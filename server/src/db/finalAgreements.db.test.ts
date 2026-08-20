/**
 * PLU-169 (1f) — DB-backed tests for FinalAgreement against a REAL Postgres
 * (PGlite) with every migration applied verbatim (including
 * 20260820120000_plu169_final_agreement), so the new table/enums/FKs are
 * byte-identical to what would land on live Neon.
 *
 * Locks: a fresh insert succeeds; a duplicate write (same instanceId) is
 * idempotent — returns the EXISTING row, never a second one or an error; two
 * different instances never collide.
 *
 * Run: npx tsx --test src/db/finalAgreements.db.test.ts   (or via npm test)
 */

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { recordFinalAgreementOnce, findFinalAgreementByInstance } from "./finalAgreements.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Seed an ExecutionInstance so the FinalAgreement FK resolves. Returns its id.
let seedCounter = 0;
async function seedInstance(pgdb: Db): Promise<string> {
  seedCounter++;
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "FinalAgreement Test", email: `final-agreement-${seedCounter}@test.local` })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: `FinalAgreement WF ${seedCounter}` })
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
    finalDeliverables: [{ id: "del_1", platform: "instagram", format: "reel", quantity: 2 }],
    finalTimeline: "Live by Sept 15",
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
  console.log("\nfinalAgreements.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  await test("a fresh insert succeeds and round-trips finalDeliverables (jsonb) intact", async () => {
    const instanceId = await seedInstance(pgdb);
    const row = await recordFinalAgreementOnce(agreement(instanceId), pgdb);
    assert.equal(row.instanceId, instanceId);
    assert.equal(row.finalFeeCents, 50000);
    assert.equal(row.acceptanceSource, "AI_NEGOTIATION");
    assert.deepEqual(row.finalDeliverables, [
      { id: "del_1", platform: "instagram", format: "reel", quantity: 2 },
    ]);
  });

  await test("a duplicate write (same instanceId) is idempotent — returns the SAME row, not a second one", async () => {
    const instanceId = await seedInstance(pgdb);
    const first = await recordFinalAgreementOnce(agreement(instanceId), pgdb);
    // A retry with DIFFERENT values (as a real BullMQ retry might compute
    // slightly different derived fields) must still return the ORIGINAL row —
    // proving the UNIQUE(instanceId) constraint is what actually enforces
    // idempotency, not just "we happened to pass the same data twice."
    const retry = await recordFinalAgreementOnce(
      { ...agreement(instanceId), finalFeeCents: 999999 },
      pgdb,
    );
    assert.equal(retry.id, first.id, "same row returned on retry");
    assert.equal(retry.finalFeeCents, 50000, "the ORIGINAL value is preserved, not the retry's");

    // The unique constraint's whole job: exactly one row for this instance,
    // never two, regardless of how many times the write is retried.
    const rows = await pgdb
      .select()
      .from(schema.finalAgreements)
      .where(eq(schema.finalAgreements.instanceId, instanceId));
    assert.equal(rows.length, 1, "exactly one row exists for this instance");
  });

  await test("two different instances never collide — each gets its own row", async () => {
    const instanceA = await seedInstance(pgdb);
    const instanceB = await seedInstance(pgdb);
    const rowA = await recordFinalAgreementOnce(agreement(instanceA), pgdb);
    const rowB = await recordFinalAgreementOnce(agreement(instanceB), pgdb);
    assert.notEqual(rowA.id, rowB.id);
    assert.equal(rowA.instanceId, instanceA);
    assert.equal(rowB.instanceId, instanceB);
  });

  await test("findFinalAgreementByInstance returns null for an instance with no agreement", async () => {
    const instanceId = await seedInstance(pgdb);
    const found = await findFinalAgreementByInstance(instanceId, pgdb);
    assert.equal(found, null);
  });

  await test("findFinalAgreementByInstance returns the row once written", async () => {
    const instanceId = await seedInstance(pgdb);
    await recordFinalAgreementOnce(agreement(instanceId), pgdb);
    const found = await findFinalAgreementByInstance(instanceId, pgdb);
    assert.ok(found);
    assert.equal(found!.instanceId, instanceId);
  });

  console.log(`\n${n} passed\n`);
  await pg.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
