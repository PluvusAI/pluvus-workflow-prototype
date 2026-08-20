/**
 * PLU-169 (1f) — Greptile review (PR #46) fix: the FinalAgreement write must
 * be atomic with the OCC-guarded ACCEPTED state transition, not eager inside
 * the executor. Mirrors stepCommit.atomicity.test.ts's pattern exactly (same
 * PGlite + injectable-tx seam) but for `recordFinalAgreementOnce` specifically:
 * proves that if anything after the state write fails inside the SAME
 * transaction, neither the state change NOR the FinalAgreement row survive —
 * so a FinalAgreement can never exist for an instance that isn't genuinely
 * ACCEPTED.
 *
 * Run:  npx tsx --test src/db/finalAgreementWrite.atomicity.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { updateInstanceStateConditional } from "./instances.js";
import { appendEvent } from "./events.js";
import { recordFinalAgreementOnce, findFinalAgreementByInstance } from "./finalAgreements.js";
import type { Db } from "./drizzle.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function agreement(instanceId: string): schema.FinalAgreementInsert {
  return {
    instanceId,
    campaignTermsSnapshotId: null,
    negotiationPolicySnapshotId: null,
    finalFeeCents: 50000,
    finalCommissionMode: null,
    finalCommissionRate: null,
    finalCommissionAmountCents: null,
    finalCommissionDurationDays: null,
    finalCommissionConditions: null,
    finalGiftProductDescription: null,
    finalGiftDisposition: null,
    finalFulfillmentTerms: null,
    finalDeliverables: [],
    finalTimeline: null,
    finalPostingDate: null,
    finalUsageRights: null,
    finalExclusivity: null,
    finalAttributionWindow: null,
    finalPaymentTerms: null,
    finalScriptSubmissionRequired: false,
    approvedDeviations: null,
    acceptanceSource: "AI_NEGOTIATION",
    sourceMessageId: null,
    acceptedAt: new Date("2026-08-20T00:00:00.000Z"),
  };
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: "PLU-169 Atomicity Workflow" })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();

  let seq = 0;
  async function seedNegotiatingInstance(): Promise<string> {
    seq++;
    const [creator] = await pgdb
      .insert(schema.creators)
      .values({ name: `FA Atomicity Creator ${seq}`, email: `fa-atomic-${seq}@test.local` })
      .returning();
    const [inst] = await pgdb
      .insert(schema.executionInstances)
      .values({
        workflowVersionId: version!.id,
        creatorId: creator!.id,
        currentState: "NEGOTIATING",
      })
      .returning();
    return inst!.id;
  }

  async function currentState(instanceId: string): Promise<string> {
    const [row] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, instanceId));
    return row!.currentState;
  }

  await test("happy path: state write + FinalAgreement insert commit together", async () => {
    const instId = await seedNegotiatingInstance();
    await pgdb.transaction(async (tx) => {
      const row = await updateInstanceStateConditional(
        instId,
        "NEGOTIATING",
        { currentState: "ACCEPTED" },
        tx,
      );
      assert.ok(row, "OCC update won inside the tx");
      await appendEvent(
        { instanceId: instId, type: "NEGOTIATION_TURN", nodeId: "node-negotiate", payload: { outcome: "ACCEPT" } },
        tx,
      );
      await recordFinalAgreementOnce(agreement(instId), tx);
    });

    assert.equal(await currentState(instId), "ACCEPTED", "state committed");
    const found = await findFinalAgreementByInstance(instId, pgdb);
    assert.ok(found, "FinalAgreement committed alongside the state write");
  });

  await test("PLU-169 Greptile fix: crash AFTER state write, before the FinalAgreement insert → BOTH roll back", async () => {
    const instId = await seedNegotiatingInstance();

    await assert.rejects(
      pgdb.transaction(async (tx) => {
        const row = await updateInstanceStateConditional(
          instId,
          "NEGOTIATING",
          { currentState: "ACCEPTED" },
          tx,
        );
        assert.ok(row, "OCC update matched inside the tx");
        // Simulate exactly what the Greptile review flagged: something after the
        // state write (draft generation, the output guard, send reservation)
        // fails. The FinalAgreement insert must never have been reached/kept.
        throw new Error("simulated guard-block / draft failure after state write");
      }),
      /simulated guard-block/,
    );

    assert.equal(
      await currentState(instId),
      "NEGOTIATING",
      "state write rolled back — instance never silently entered ACCEPTED",
    );
    const found = await findFinalAgreementByInstance(instId, pgdb);
    assert.equal(found, null, "no orphaned FinalAgreement row for an instance that isn't really ACCEPTED");
  });

  await test("PLU-169 Greptile fix: a FAILED FinalAgreement insert rolls back an already-succeeded state write", async () => {
    const instId = await seedNegotiatingInstance();

    await assert.rejects(
      pgdb.transaction(async (tx) => {
        await updateInstanceStateConditional(instId, "NEGOTIATING", { currentState: "ACCEPTED" }, tx);
        await appendEvent(
          { instanceId: instId, type: "NEGOTIATION_TURN", nodeId: "node-negotiate", payload: { outcome: "ACCEPT" } },
          tx,
        );
        // A bad instanceId FK stands in for any FinalAgreement insert failure —
        // the point is that a failed final-agreement write undoes the state.
        await recordFinalAgreementOnce({ ...agreement(instId), instanceId: "does-not-exist" }, tx);
      }),
    );

    assert.equal(
      await currentState(instId),
      "NEGOTIATING",
      "state rolled back when the FinalAgreement insert failed",
    );
    const found = await findFinalAgreementByInstance(instId, pgdb);
    assert.equal(found, null);
  });

  await test("a retried ACCEPT turn (idempotent recordFinalAgreementOnce) inside a fresh successful transaction never creates a second row", async () => {
    const instId = await seedNegotiatingInstance();
    await pgdb.transaction(async (tx) => {
      await updateInstanceStateConditional(instId, "NEGOTIATING", { currentState: "ACCEPTED" }, tx);
      await recordFinalAgreementOnce(agreement(instId), tx);
    });
    // A BullMQ retry of the SAME already-committed turn: the state transition
    // is now a no-op (updateInstanceStateConditional won't match NEGOTIATING
    // anymore), but recordFinalAgreementOnce alone must still be idempotent.
    const again = await recordFinalAgreementOnce(agreement(instId), pgdb);
    const first = await findFinalAgreementByInstance(instId, pgdb);
    assert.equal(again.id, first!.id, "retry returns the SAME row, not a duplicate");
  });

  await pg.close();
  console.log(`\n${n} passed\n`);
}

await main();
