/**
 * BUG-Q2: unit tests for the inbound-email re-drive sweep. Proves it re-enqueues
 * PENDING dead-lettered inbound replies, claims each row (PENDING guard) before
 * enqueue so concurrent sweeps don't double-drive, skips unusable payloads, and
 * tolerates a per-row enqueue failure. Injects the DB + queue seam so it runs
 * with no live DB / Redis. Run: npx tsx src/scheduler/inboundRedrive.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeadLetterJob } from "../db/schema.js";
import type { InboundEmailJobData } from "../workers/jobs.js";
import {
  inboundJobFromPayload,
  redriveInboundDeadLetters,
  type InboundRedriveDeps,
} from "./inboundRedrive.js";

function dl(id: string, payload: unknown): DeadLetterJob {
  return {
    id,
    queue: "inbound-email",
    jobId: `inbound|${id}`,
    jobName: "reply",
    payload,
    instanceId: "inst-1",
    failReason: "agent timeout",
    attemptsMade: 3,
    status: "PENDING",
    redriveCount: 0,
    createdAt: new Date("2026-07-19T00:00:00.000Z"),
    redrivenAt: null,
  } as unknown as DeadLetterJob;
}

const goodPayload = {
  instanceId: "inst-1",
  externalMessageId: "msg-1",
  threadId: "thr-1",
  subject: "Re: collab",
  body: "sounds good",
};

function makeDeps(
  rows: DeadLetterJob[],
  opts?: { failEnqueueFor?: string; claimNull?: Set<string> },
): {
  deps: InboundRedriveDeps;
  enqueued: InboundEmailJobData[];
  claimed: string[];
} {
  const enqueued: InboundEmailJobData[] = [];
  const claimed: string[] = [];
  const deps: InboundRedriveDeps = {
    async listPendingDeadLetters() {
      return rows;
    },
    async markDeadLetterRedriven(id) {
      if (opts?.claimNull?.has(id)) return null; // lost the race
      claimed.push(id);
      return { id } as unknown as DeadLetterJob;
    },
    async enqueueInboundEmail(data) {
      if (opts?.failEnqueueFor && data.externalMessageId === opts.failEnqueueFor) {
        throw new Error("redis down");
      }
      enqueued.push(data);
    },
  };
  return { deps, enqueued, claimed };
}

describe("BUG-Q2 inboundJobFromPayload", () => {
  it("reconstructs a valid job from a full payload", () => {
    const job = inboundJobFromPayload(goodPayload);
    assert.deepEqual(job, {
      instanceId: "inst-1",
      externalMessageId: "msg-1",
      threadId: "thr-1",
      subject: "Re: collab",
      body: "sounds good",
    });
  });

  it("carries optional senderEmail / mockIntent when present", () => {
    const job = inboundJobFromPayload({
      ...goodPayload,
      emailAccountId: "account-1",
      senderEmail: "casey@example.com",
      mockIntent: "POSITIVE",
    });
    assert.equal(job?.emailAccountId, "account-1");
    assert.equal(job?.senderEmail, "casey@example.com");
    assert.equal(job?.mockIntent, "POSITIVE");
  });

  it("returns null when required fields are missing", () => {
    assert.equal(inboundJobFromPayload(null), null);
    assert.equal(inboundJobFromPayload({}), null);
    assert.equal(inboundJobFromPayload({ instanceId: "x" }), null); // no externalMessageId
    assert.equal(inboundJobFromPayload({ externalMessageId: "m" }), null); // no instanceId
    assert.equal(inboundJobFromPayload([goodPayload]), null); // array, not object
  });
});

describe("BUG-Q2 redriveInboundDeadLetters", () => {
  it("re-enqueues every claimable pending row", async () => {
    const { deps, enqueued, claimed } = makeDeps([
      dl("a", goodPayload),
      dl("b", { ...goodPayload, externalMessageId: "msg-2", instanceId: "inst-2" }),
    ]);
    const n = await redriveInboundDeadLetters(deps);
    assert.equal(n, 2);
    assert.deepEqual(claimed, ["a", "b"], "each row claimed before enqueue");
    assert.equal(enqueued.length, 2);
    assert.equal(enqueued[0]?.externalMessageId, "msg-1");
    assert.equal(enqueued[1]?.externalMessageId, "msg-2");
  });

  it("claims the row (PENDING guard) BEFORE enqueuing — lost race → no enqueue", async () => {
    const { deps, enqueued } = makeDeps([dl("a", goodPayload)], {
      claimNull: new Set(["a"]),
    });
    const n = await redriveInboundDeadLetters(deps);
    assert.equal(n, 0, "a row already claimed by another sweep is not re-enqueued");
    assert.equal(enqueued.length, 0);
  });

  it("skips a row with an unusable payload (no throw, no enqueue)", async () => {
    const { deps, enqueued, claimed } = makeDeps([dl("bad", { instanceId: "only" })]);
    const n = await redriveInboundDeadLetters(deps);
    assert.equal(n, 0);
    assert.equal(claimed.length, 0, "an unusable row is not even claimed");
    assert.equal(enqueued.length, 0);
  });

  it("tolerates a per-row enqueue failure and still drives the rest", async () => {
    const { deps, enqueued } = makeDeps(
      [
        dl("a", goodPayload),
        dl("b", { ...goodPayload, externalMessageId: "msg-2" }),
      ],
      { failEnqueueFor: "msg-1" },
    );
    const n = await redriveInboundDeadLetters(deps);
    assert.equal(n, 1, "the second row still re-drives after the first fails");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]?.externalMessageId, "msg-2");
  });

  it("returns 0 on an empty dead-letter set", async () => {
    const { deps } = makeDeps([]);
    assert.equal(await redriveInboundDeadLetters(deps), 0);
  });
});
