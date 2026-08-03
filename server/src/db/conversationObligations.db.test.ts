/**
 * PLU-111 — DB-backed tests for the ConversationObligation ledger against a REAL
 * Postgres (PGlite, embedded) with the REAL schema (every Prisma migration applied
 * verbatim), so the table, enums, and the partial-unique index are byte-identical
 * to live Neon.
 *
 * Covers the spec's DB acceptance tests (§7):
 *   - SENT gate: reserve link → OPEN + resolutionMessageId; flush → ANSWERED.
 *   - draft-fail / stranded reserve: never resolved without a real send.
 *   - transaction rollback: a thrown tx leaves NO obligation rows.
 *   - round-1 question survives to a later round while unanswered.
 *   - deferral mints a commitment; a later send completes it.
 *   - escalation keeps it open (non-terminal).
 *   - no-repeat-ask: an ANSWERED question drops out of the open read.
 *   - concurrent double-insert → partial-unique constraint → one row.
 *   - operator manual resolution (idempotent on a terminal row).
 *
 * The shared migration helper preserves DO $$…$$ blocks while executing each
 * top-level statement separately, including enum-growth migrations.
 *
 * Run:  npx tsx --test src/db/conversationObligations.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  listOpenObligationsByInstance,
  listObligationsByInstance,
  upsertQuestionObligation,
  mintCommitmentObligation,
  linkResolutionMessage,
  resolveObligationsByResolutionMessage,
  resolveObligationManual,
  escalateObligations,
  type DeferralClassifier,
} from "./conversationObligations.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

let seedN = 0;
/** Seed an ExecutionInstance (via creator/workflow chain) so obligation FKs
 *  resolve. Returns the instance id. */
async function seedInstance(pgdb: Db): Promise<string> {
  const suffix = `co-${seedN++}`;
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Obligation Test", email: `${suffix}@test.local` })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: `WF ${suffix}` })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: version!.id, creatorId: creator!.id })
    .returning();
  return instance!.id;
}

/** Seed an OUTBOUND Message row (reserved-but-unsent: sentAt null). */
async function seedOutbound(
  pgdb: Db,
  instanceId: string,
  opts: { body?: string; sentAt?: Date | null } = {},
): Promise<string> {
  const [m] = await pgdb
    .insert(schema.messages)
    .values({
      instanceId,
      direction: "OUTBOUND",
      body: opts.body ?? "our reply",
      sentAt: opts.sentAt ?? null,
    })
    .returning();
  return m!.id;
}

/** Seed an INBOUND Message row (the row that raised a question). */
async function seedInbound(pgdb: Db, instanceId: string): Promise<string> {
  const [m] = await pgdb
    .insert(schema.messages)
    .values({ instanceId, direction: "INBOUND", body: "creator asks a question" })
    .returning();
  return m!.id;
}

async function main(): Promise<void> {
  console.log("\nconversationObligations.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── SENT gate (the headline test) ──────────────────────────────────────────
  await test("SENT gate: reserve links (stays OPEN); flush marks ANSWERED", async () => {
    const instanceId = await seedInstance(pgdb);
    const inbound = await seedInbound(pgdb, instanceId);
    const outbound = await seedOutbound(pgdb, instanceId, { body: "The fee is $250." });

    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "what s the fee", originalText: "what's the fee?", sourceMessageId: inbound },
      pgdb,
    );
    // Reserve-time link: status unchanged, resolutionMessageId stamped.
    await linkResolutionMessage([q.id], outbound, pgdb);
    let [row] = await pgdb
      .select()
      .from(schema.conversationObligations)
      .where(eq(schema.conversationObligations.id, q.id));
    assert.equal(row!.status, "OPEN", "still OPEN before the send");
    assert.equal(row!.resolutionMessageId, outbound);
    assert.equal(row!.resolvedAt, null);

    // Flush: the message has now been sent → resolve.
    const res = await resolveObligationsByResolutionMessage(outbound, pgdb);
    assert.equal(res.answered, 1);
    [row] = await pgdb
      .select()
      .from(schema.conversationObligations)
      .where(eq(schema.conversationObligations.id, q.id));
    assert.equal(row!.status, "ANSWERED");
    assert.equal(row!.resolutionSource, "ai");
    assert.ok(row!.resolvedAt instanceof Date, "resolvedAt set on the terminal transition");
  });

  // ── draft-fail: no reserve → no link → stays OPEN ──────────────────────────
  await test("draft-fail path: no resolutionMessageId → obligation stays OPEN", async () => {
    const instanceId = await seedInstance(pgdb);
    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "usage rights", originalText: "usage rights?" },
      pgdb,
    );
    // No link stamped (the draft failed before reserving). A flush for some OTHER
    // message must not touch this row.
    const other = await seedOutbound(pgdb, instanceId);
    await resolveObligationsByResolutionMessage(other, pgdb);
    const [row] = await pgdb
      .select()
      .from(schema.conversationObligations)
      .where(eq(schema.conversationObligations.id, q.id));
    assert.equal(row!.status, "OPEN");
    assert.equal(row!.resolutionMessageId, null);
  });

  // ── stranded reserve: linked but never flushed → stays OPEN ────────────────
  await test("stranded reserve: linked but flush never runs → stays OPEN", async () => {
    const instanceId = await seedInstance(pgdb);
    const outbound = await seedOutbound(pgdb, instanceId, { sentAt: null });
    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "when paid", originalText: "when do I get paid?" },
      pgdb,
    );
    await linkResolutionMessage([q.id], outbound, pgdb);
    // We simply never call resolveObligationsByResolutionMessage (sentAt stays
    // null → the flush that would call it never runs). The row stays OPEN.
    const open = await listOpenObligationsByInstance(instanceId, pgdb);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.status, "OPEN");
  });

  // ── transaction rollback: a thrown tx leaves NO rows ───────────────────────
  await test("rolled-back tx: create + link both roll back (no obligation rows)", async () => {
    const instanceId = await seedInstance(pgdb);
    const outbound = await seedOutbound(pgdb, instanceId);
    await assert.rejects(
      pgdb.transaction(async (tx) => {
        const q = await upsertQuestionObligation(
          { instanceId, normalizedKey: "rollback q", originalText: "rollback?" },
          tx as unknown as Db,
        );
        await linkResolutionMessage([q.id], outbound, tx as unknown as Db);
        throw new Error("simulated StaleInstanceError");
      }),
    );
    const rows = await listObligationsByInstance(instanceId, pgdb);
    assert.equal(rows.length, 0, "the whole tx rolled back — no half-written obligation");
  });

  // ── runtime tx shape: obligation writes commit WITH the NEGOTIATION_TURN event,
  //    and roll back together on a thrown tx (invariant #5, §4.6) ──────────────
  await test("obligation writes + NEGOTIATION_TURN event are atomic (both roll back)", async () => {
    const instanceId = await seedInstance(pgdb);
    // Mirror runtime.stepInstance's tx body: append the domain event, then apply
    // the obligation plan — then throw (a StaleInstanceError stand-in).
    await assert.rejects(
      pgdb.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          instanceId,
          type: "NEGOTIATION_TURN",
          payload: { outcome: "counter", round: 1 } as schema.JsonValue,
        });
        await upsertQuestionObligation(
          { instanceId, normalizedKey: "atomic q", originalText: "atomic?" },
          tx as unknown as Db,
        );
        throw new Error("simulated StaleInstanceError");
      }),
    );
    const events = await pgdb
      .select()
      .from(schema.events)
      .where(eq(schema.events.instanceId, instanceId));
    const obligations = await listObligationsByInstance(instanceId, pgdb);
    assert.equal(events.length, 0, "the NEGOTIATION_TURN event rolled back");
    assert.equal(obligations.length, 0, "the obligation rolled back with it — no partial write");
  });

  // Positive: the SAME sequence committing leaves BOTH the event and the obligation.
  await test("obligation writes + event COMMIT together on a clean tx", async () => {
    const instanceId = await seedInstance(pgdb);
    await pgdb.transaction(async (tx) => {
      await tx.insert(schema.events).values({
        instanceId,
        type: "NEGOTIATION_TURN",
        payload: { outcome: "counter", round: 1 } as schema.JsonValue,
      });
      await upsertQuestionObligation(
        { instanceId, normalizedKey: "commit q", originalText: "commit?" },
        tx as unknown as Db,
      );
    });
    const events = await pgdb
      .select()
      .from(schema.events)
      .where(eq(schema.events.instanceId, instanceId));
    const obligations = await listObligationsByInstance(instanceId, pgdb);
    assert.equal(events.length, 1);
    assert.equal(obligations.length, 1);
  });

  // ── round-1 question survives to a later round while unanswered ─────────────
  await test("a round-1 question stays OPEN and readable across later rounds", async () => {
    const instanceId = await seedInstance(pgdb);
    await upsertQuestionObligation(
      { instanceId, normalizedKey: "deadline", originalText: "what's the deadline?" },
      pgdb,
    );
    // Several later turns happen with no answer sent → still open.
    for (let round = 0; round < 3; round++) {
      const open = await listOpenObligationsByInstance(instanceId, pgdb);
      assert.equal(open.length, 1, `round ${round}: still open`);
      assert.equal(open[0]!.originalText, "what's the deadline?");
    }
  });

  // ── deferral mints a commitment; a later send completes it ─────────────────
  await test("a sent deferral → question DEFERRED + a new PLUVUS_COMMITMENT; later send COMPLETES it", async () => {
    const instanceId = await seedInstance(pgdb);
    const outbound = await seedOutbound(pgdb, instanceId, {
      body: "We'll confirm the usage rights on the next step.",
    });
    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "usage rights", originalText: "usage rights?", category: "usage_rights" },
      pgdb,
    );
    await linkResolutionMessage([q.id], outbound, pgdb);

    // Classifier says this question was DEFERRED (the copy promised to confirm).
    const deferAll: DeferralClassifier = { isDeferred: () => true };
    const res = await resolveObligationsByResolutionMessage(outbound, pgdb, deferAll);
    assert.equal(res.deferred, 1);
    assert.equal(res.mintedCommitments, 1);

    const all = await listObligationsByInstance(instanceId, pgdb);
    const question = all.find((r) => r.id === q.id)!;
    const commitment = all.find((r) => r.type === "PLUVUS_COMMITMENT")!;
    assert.equal(question.status, "DEFERRED", "question stays open (non-terminal)");
    assert.equal(commitment.status, "OPEN", "a fresh commitment is now owed");

    // A later fulfilling send completes the commitment.
    const outbound2 = await seedOutbound(pgdb, instanceId, {
      body: "Confirmed: the usage rights are 6 months organic.",
    });
    await linkResolutionMessage([commitment.id], outbound2, pgdb);
    const res2 = await resolveObligationsByResolutionMessage(outbound2, pgdb);
    assert.equal(res2.completed, 1);
    const [done] = await pgdb
      .select()
      .from(schema.conversationObligations)
      .where(eq(schema.conversationObligations.id, commitment.id));
    assert.equal(done!.status, "COMPLETED");
    assert.equal(done!.resolutionSource, "ai");
  });

  // ── flush retry idempotency (answered + deferred) ──────────────────────────
  await test("a retried flush is idempotent (answered stays answered; deferral doesn't re-mint)", async () => {
    const instanceId = await seedInstance(pgdb);
    const answerMsg = await seedOutbound(pgdb, instanceId, { body: "The fee is $250." });
    const deferMsg = await seedOutbound(pgdb, instanceId, {
      body: "We'll confirm the usage rights on the next step.",
    });
    const qa = await upsertQuestionObligation(
      { instanceId, normalizedKey: "fee2", originalText: "what's the fee?" },
      pgdb,
    );
    const qd = await upsertQuestionObligation(
      { instanceId, normalizedKey: "usage2", originalText: "usage rights?", category: "usage_rights" },
      pgdb,
    );
    await linkResolutionMessage([qa.id], answerMsg, pgdb);
    await linkResolutionMessage([qd.id], deferMsg, pgdb);

    const deferOnly: DeferralClassifier = {
      isDeferred: (o) => o.id === qd.id,
    };
    // First flush of each message.
    await resolveObligationsByResolutionMessage(answerMsg, pgdb, deferOnly);
    await resolveObligationsByResolutionMessage(deferMsg, pgdb, deferOnly);
    // Retry BOTH — must be a no-op.
    await resolveObligationsByResolutionMessage(answerMsg, pgdb, deferOnly);
    const retry = await resolveObligationsByResolutionMessage(deferMsg, pgdb, deferOnly);
    assert.equal(retry.deferred, 0, "the DEFERRED question is no longer linked to deferMsg → not re-processed");
    assert.equal(retry.mintedCommitments, 0, "no duplicate commitment on retry");

    const all = await listObligationsByInstance(instanceId, pgdb);
    assert.equal(all.filter((r) => r.id === qa.id)[0]!.status, "ANSWERED");
    assert.equal(all.filter((r) => r.id === qd.id)[0]!.status, "DEFERRED");
    assert.equal(
      all.filter((r) => r.type === "PLUVUS_COMMITMENT").length,
      1,
      "exactly one commitment across both flushes + retries",
    );
  });

  // ── escalation keeps it open (non-terminal) ────────────────────────────────
  await test("escalation moves open obligations to ESCALATED (non-terminal, still read)", async () => {
    const instanceId = await seedInstance(pgdb);
    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "legal", originalText: "can you sign our contract?" },
      pgdb,
    );
    const moved = await escalateObligations([q.id], pgdb);
    assert.equal(moved, 1);
    const open = await listOpenObligationsByInstance(instanceId, pgdb);
    assert.equal(open.length, 1, "ESCALATED is non-terminal → still in the open read");
    assert.equal(open[0]!.status, "ESCALATED");
    // resolvedAt must NOT be set (it's non-terminal).
    assert.equal(open[0]!.resolvedAt, null);
  });

  // ── no-repeat-ask: ANSWERED drops out of the open read ─────────────────────
  await test("an ANSWERED question does not reappear in the open read (no-repeat-ask)", async () => {
    const instanceId = await seedInstance(pgdb);
    const outbound = await seedOutbound(pgdb, instanceId, { body: "The fee is $250." });
    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "fee", originalText: "what's the fee?" },
      pgdb,
    );
    await linkResolutionMessage([q.id], outbound, pgdb);
    await resolveObligationsByResolutionMessage(outbound, pgdb);
    const open = await listOpenObligationsByInstance(instanceId, pgdb);
    assert.equal(open.length, 0, "answered → gone from the open (must-answer) read");
  });

  // ── rephrase-of-an-ANSWERED question is a NEW obligation ────────────────────
  await test("re-asking an ANSWERED question mints a FRESH open row (slot freed)", async () => {
    const instanceId = await seedInstance(pgdb);
    const outbound = await seedOutbound(pgdb, instanceId);
    const q1 = await upsertQuestionObligation(
      { instanceId, normalizedKey: "shipping", originalText: "when does it ship?" },
      pgdb,
    );
    await linkResolutionMessage([q1.id], outbound, pgdb);
    await resolveObligationsByResolutionMessage(outbound, pgdb); // → ANSWERED

    // Same normalizedKey re-asked later — the partial-unique slot is now free.
    const q2 = await upsertQuestionObligation(
      { instanceId, normalizedKey: "shipping", originalText: "when does it ship again?" },
      pgdb,
    );
    assert.notEqual(q2.id, q1.id, "a fresh OPEN row, not the terminal one");
    assert.equal(q2.status, "OPEN");
  });

  // ── conservative dedup: a re-ask TOUCHES the open row, no duplicate ─────────
  await test("re-ask of an OPEN question updates the existing row (no duplicate)", async () => {
    const instanceId = await seedInstance(pgdb);
    const first = await upsertQuestionObligation(
      { instanceId, normalizedKey: "exclusivity", originalText: "exclusivity?" },
      pgdb,
    );
    const second = await upsertQuestionObligation(
      { instanceId, normalizedKey: "exclusivity", originalText: "are we exclusive?" },
      pgdb,
    );
    assert.equal(second.id, first.id, "same open row is touched");
    assert.equal(second.originalText, "exclusivity?", "originalText keeps the FIRST wording (audit)");
    const open = await listOpenObligationsByInstance(instanceId, pgdb);
    assert.equal(open.length, 1, "still exactly one open obligation");
  });

  // ── concurrent double-insert → partial-unique → one row ────────────────────
  await test("concurrent double-insert of the same open key → partial-unique → one row", async () => {
    const instanceId = await seedInstance(pgdb);
    // Bypass upsert's read-then-insert to force the raw insert race: two direct
    // inserts of the same (instanceId, type, normalizedKey) non-terminal row. The
    // second must hit the partial-unique index.
    await pgdb.insert(schema.conversationObligations).values({
      instanceId,
      type: "CREATOR_QUESTION",
      status: "OPEN",
      originalText: "same?",
      normalizedKey: "same",
    });
    await assert.rejects(
      () =>
        pgdb.insert(schema.conversationObligations).values({
          instanceId,
          type: "CREATOR_QUESTION",
          status: "OPEN",
          originalText: "same again?",
          normalizedKey: "same",
        }),
      (err) => isUniqueViolation(err),
      "a second non-terminal row under the same key must be rejected",
    );
    // And upsert absorbs the race gracefully → still one row.
    const raced = await upsertQuestionObligation(
      { instanceId, normalizedKey: "same", originalText: "same yet again?" },
      pgdb,
    );
    assert.ok(raced.id, "upsert returned the existing open row rather than throwing");
    const open = await listOpenObligationsByInstance(instanceId, pgdb);
    assert.equal(open.filter((o) => o.normalizedKey === "same").length, 1);
  });

  // ── operator manual resolution (idempotent on a terminal row) ──────────────
  await test("operator manual resolution → terminal + resolutionSource=operator; idempotent", async () => {
    const instanceId = await seedInstance(pgdb);
    const q = await upsertQuestionObligation(
      { instanceId, normalizedKey: "op", originalText: "operator will handle?" },
      pgdb,
    );
    const resolved = await resolveObligationManual(
      q.id,
      { status: "CANCELED", resolution: "handled out of band" },
      "operator",
      pgdb,
    );
    assert.equal(resolved!.status, "CANCELED");
    assert.equal(resolved!.resolutionSource, "operator");
    assert.equal(resolved!.resolution, "handled out of band");
    assert.ok(resolved!.resolvedAt instanceof Date);

    // Idempotent: resolving the already-terminal row no-ops and returns it.
    const again = await resolveObligationManual(
      q.id,
      { status: "NO_LONGER_RELEVANT" },
      "operator",
      pgdb,
    );
    assert.equal(again!.status, "CANCELED", "already terminal → unchanged");
  });

  // ── commitment mint idempotency (retried flush) ────────────────────────────
  await test("mintCommitmentObligation is idempotent on a retry (one open commitment)", async () => {
    const instanceId = await seedInstance(pgdb);
    const args = {
      instanceId,
      normalizedKey: "confirm shipping",
      originalText: "confirm shipping date",
      category: "shipping",
    };
    const c1 = await mintCommitmentObligation(args, pgdb);
    const c2 = await mintCommitmentObligation(args, pgdb);
    assert.equal(c2.id, c1.id, "a re-mint returns the existing open commitment");
    const commitments = (await listOpenObligationsByInstance(instanceId, pgdb)).filter(
      (o) => o.type === "PLUVUS_COMMITMENT",
    );
    assert.equal(commitments.length, 1);
  });

  console.log(`\n✓ conversationObligations.db: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
