/**
 * Unit tests for the Randomized Send Delay safety-net sweep (§4.4, §8) — fully
 * injected deps, no live DB or Redis.
 *
 * Covers §8:
 *   - safety-net sweep: a stranded reservation is re-driven with a DISTINCT jobId.
 *   - poison-loop bound: a reservation past MAX_REDRIVES / MAX_SWEEP_AGE is not
 *     re-enqueued (the underlying query excludes it; the sweep re-drives at most a
 *     few times then stops).
 *   - rolled-back turn / orphan guard (§4.3a): a reservation whose owning turn did
 *     not commit is skipped, never resurrected.
 *
 * Run with:  npx tsx src/scheduler/sendDelaySweep.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sweepStrandedSends,
  committingEventType,
  BRAND_REJECT_CLOSE_PREFIX,
  INITIAL_OUTREACH_PREFIX,
  type SendDelaySweepDeps,
} from "./sendDelaySweep.js";
import type { Message } from "../db/schema.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function reservation(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    instanceId: "i1",
    direction: "OUTBOUND",
    subject: "Re: Collab",
    body: "…",
    threadId: null,
    senderEmail: null,
    externalMessageId: null,
    idempotencyKey: "negotiation:counter:i1:1",
    replyIntent: null,
    classifyConfidence: null,
    redriveCount: 0,
    sentAt: null,
    receivedAt: null,
    processedAt: null,
    createdAt: new Date(NOW.getTime() - 10 * 60_000), // 10 min old (stranded)
    ...over,
  } as unknown as Message;
}

function makeDeps(over: Partial<SendDelaySweepDeps> & { stranded?: Message[]; committed?: boolean } = {}) {
  const enqueued: { messageId: string; delayMs: number | undefined; jobId: string | undefined }[] = [];
  const bumped: string[] = [];
  const counts = new Map<string, number>();
  const deps: SendDelaySweepDeps = {
    async listStrandedOutboundReservations() {
      return over.stranded ?? [];
    },
    async incrementRedriveCount(id: string) {
      const next = (counts.get(id) ?? 0) + 1;
      counts.set(id, next);
      bumped.push(id);
      return next;
    },
    async enqueueDelayedSend(data, delayMs, jobId) {
      enqueued.push({ messageId: data.messageId, delayMs, jobId });
    },
    async turnCommitted() {
      return over.committed ?? true;
    },
    now: () => NOW,
    ...(over.listStrandedOutboundReservations
      ? { listStrandedOutboundReservations: over.listStrandedOutboundReservations }
      : {}),
    ...(over.turnCommitted ? { turnCommitted: over.turnCommitted } : {}),
    ...(over.enqueueDelayedSend ? { enqueueDelayedSend: over.enqueueDelayedSend } : {}),
  };
  return { deps, enqueued, bumped, counts };
}

test("sweep: a committed stranded reservation is re-driven with a DISTINCT jobId", async () => {
  const { deps, enqueued, bumped } = makeDeps({
    stranded: [reservation({ id: "mA", redriveCount: 0 })],
    committed: true,
  });
  const res = await sweepStrandedSends(deps);
  assert.equal(res.reclaimed, 1);
  assert.equal(res.orphansSkipped, 0);
  assert.equal(bumped[0], "mA", "redriveCount claimed before enqueue");
  assert.equal(enqueued.length, 1);
  // Distinct jobId (§4.4): send|<id>|redrive-<n>, NOT the first-enqueue send|<id>.
  assert.equal(enqueued[0]!.jobId, "send|mA|redrive-1");
  assert.equal(enqueued[0]!.delayMs, 0, "re-drive flushes ASAP");
});

test("sweep: the re-drive jobId advances with redriveCount across successive sweeps", async () => {
  // Same row swept twice: the counter (and thus the jobId) increments each time,
  // so a stuck/failed prior job never blocks the re-enqueue (BullMQ same-jobId is
  // a no-op — a distinct id is required).
  const row = reservation({ id: "mB", redriveCount: 0 });
  const { deps, enqueued } = makeDeps({ stranded: [row], committed: true });
  await sweepStrandedSends(deps);
  await sweepStrandedSends(deps);
  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[0]!.jobId, "send|mB|redrive-1");
  assert.equal(enqueued[1]!.jobId, "send|mB|redrive-2", "jobId advances → not deduped");
});

test("orphan guard (§4.3a): a rolled-back reservation is SKIPPED, never re-driven", async () => {
  const { deps, enqueued, bumped } = makeDeps({
    stranded: [reservation({ id: "mC" })],
    committed: false, // turnCommitted → false: the owning turn rolled back
  });
  const res = await sweepStrandedSends(deps);
  assert.equal(res.reclaimed, 0);
  assert.equal(res.orphansSkipped, 1);
  assert.equal(enqueued.length, 0, "an orphan is NEVER re-enqueued");
  assert.equal(bumped.length, 0, "an orphan's redriveCount is not even bumped");
});

test("poison-loop bound: the sweep query excludes over-limit / too-old rows, so nothing is re-driven", async () => {
  // The bound lives in listStrandedOutboundReservations (redriveCount < max AND
  // createdAt within [maxAge, max+grace]). We simulate the query already having
  // filtered a poison row out → the sweep sees an empty list → no re-enqueue.
  const { deps, enqueued } = makeDeps({ stranded: [] });
  const res = await sweepStrandedSends(deps);
  assert.equal(res.reclaimed, 0);
  assert.equal(enqueued.length, 0, "a poison row filtered by the query is never re-driven");
});

test("poison-loop bound: multiple rounds re-drive a row at most until the caller-provided cap", async () => {
  // Model the query enforcing redriveCount < MAX_REDRIVES: the fake returns the row
  // only while its count is under 3, then filters it out. Prove the sweep re-drives
  // it at most 3 times and then stops (no infinite loop).
  let count = 0;
  const MAX = 3;
  const enqueued: string[] = [];
  const deps: SendDelaySweepDeps = {
    async listStrandedOutboundReservations() {
      return count < MAX ? [reservation({ id: "mD", redriveCount: count })] : [];
    },
    async incrementRedriveCount() {
      count++;
      return count;
    },
    async enqueueDelayedSend(_data, _delay, jobId) {
      enqueued.push(jobId!);
    },
    async turnCommitted() {
      return true;
    },
    now: () => NOW,
  };
  // Run the sweep several times; it must stop re-driving once the cap is hit.
  for (let i = 0; i < 6; i++) await sweepStrandedSends(deps);
  assert.equal(enqueued.length, MAX, "re-driven at most MAX_REDRIVES times, then stops");
  assert.deepEqual(enqueued, [
    "send|mD|redrive-1",
    "send|mD|redrive-2",
    "send|mD|redrive-3",
  ]);
});

test("sweep: an orphan-guard check FAILURE fails safe (skips, does not re-drive)", async () => {
  const deps: SendDelaySweepDeps = {
    async listStrandedOutboundReservations() {
      return [reservation({ id: "mE" })];
    },
    async incrementRedriveCount() {
      throw new Error("should not be called");
    },
    async enqueueDelayedSend() {
      throw new Error("should not be called");
    },
    async turnCommitted() {
      throw new Error("event log unavailable");
    },
    now: () => NOW,
  };
  const res = await sweepStrandedSends(deps);
  assert.equal(res.reclaimed, 0, "an uncertain guard never re-drives");
});

test("sweep: an empty stranded set is a clean no-op", async () => {
  const { deps, enqueued } = makeDeps({ stranded: [] });
  const res = await sweepStrandedSends(deps);
  assert.deepEqual(res, { reclaimed: 0, orphansSkipped: 0 });
  assert.equal(enqueued.length, 0);
});

// ── Reservation-type-aware orphan guard (PLU-118, Calvin review §2) ─────────────
// A brand-reject close email is committed by BRAND_REJECTED, never NEGOTIATION_TURN.
// The orphan guard must pick the committing event by the reservation's
// idempotencyKey, or a genuinely-committed reject's close email would be mistaken
// for an orphan and dropped.

test("committingEventType: a brand-reject-close reservation maps to BRAND_REJECTED", () => {
  const rejectClose = reservation({ idempotencyKey: `${BRAND_REJECT_CLOSE_PREFIX}i9` });
  assert.equal(committingEventType(rejectClose), "BRAND_REJECTED");
});

test("committingEventType: a negotiation reservation maps to NEGOTIATION_TURN", () => {
  const negotiation = reservation({ idempotencyKey: "negotiation:counter:i1:1" });
  assert.equal(committingEventType(negotiation), "NEGOTIATION_TURN");
  // A null key (defensive) also defaults to the negotiation event.
  assert.equal(committingEventType(reservation({ idempotencyKey: null })), "NEGOTIATION_TURN");
});

test("committingEventType: initial outreach maps to OUTREACH_DRAFTED", () => {
  const outreach = reservation({ idempotencyKey: `${INITIAL_OUTREACH_PREFIX}i1` });
  assert.equal(committingEventType(outreach), "OUTREACH_DRAFTED");
});

test("orphan guard: a brand-reject close reservation is re-driven when its commit event is queried", async () => {
  // Prove the guard is passed the ROW (so it can key on idempotencyKey), not just an
  // instanceId. The injected guard here asserts the row it receives is the
  // reject-close reservation and that the sweep re-drives it once committed.
  const rejectClose = reservation({
    id: "mRC",
    idempotencyKey: `${BRAND_REJECT_CLOSE_PREFIX}i1`,
  });
  let sawRejectClose = false;
  const { deps, enqueued } = makeDeps({
    stranded: [rejectClose],
    turnCommitted: async (row: Message) => {
      // The sweep must hand the guard the row so committingEventType(row) can pick
      // BRAND_REJECTED. A committed reject → re-drive.
      if (committingEventType(row) === "BRAND_REJECTED") sawRejectClose = true;
      return true;
    },
  });
  const res = await sweepStrandedSends(deps);
  assert.equal(sawRejectClose, true, "the guard received the reject-close row");
  assert.equal(res.reclaimed, 1, "a committed reject's close email is recovered");
  assert.equal(enqueued[0]!.jobId, "send|mRC|redrive-1");
});
