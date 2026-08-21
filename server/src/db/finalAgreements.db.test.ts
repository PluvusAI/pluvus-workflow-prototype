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
import {
  recordFinalAgreementOnce,
  findFinalAgreementByInstance,
  recordContentBriefGeneration,
} from "./finalAgreements.js";
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

  // Review fix (PR #48): runtime.ts calls recordFinalAgreementOnce WITH the
  // accept turn's own OCC transaction, not the bare `db` singleton every test
  // above uses. Postgres aborts an ENTIRE transaction after any statement
  // inside it fails — the old "catch the unique-violation, then SELECT on the
  // SAME client" pattern would have the SELECT itself throw
  // `current transaction is aborted` instead of returning the existing row.
  // This reproduces that exact call shape against PGlite (a real Postgres, so
  // it enforces the same abort-on-error transaction semantics) — it fails
  // under the pre-fix implementation and passes under onConflictDoNothing.
  await test("a duplicate write INSIDE an explicit transaction (mirrors runtime.ts's tx-scoped call) does not abort the transaction", async () => {
    const instanceId = await seedInstance(pgdb);
    const first = await recordFinalAgreementOnce(agreement(instanceId), pgdb);

    const dup = await pgdb.transaction(async (tx) => {
      const inner = await recordFinalAgreementOnce(agreement(instanceId), tx);
      // Prove tx is STILL usable after the conflicting write — this is
      // exactly what broke under the old catch-then-select-on-same-client
      // pattern: a failed statement poisons the rest of the transaction, so
      // this probe query would itself throw if the fix regressed.
      const probe = await tx
        .select()
        .from(schema.finalAgreements)
        .where(eq(schema.finalAgreements.instanceId, instanceId));
      assert.equal(probe.length, 1, "the transaction must still be able to run further queries");
      return inner;
    });

    assert.equal(dup.id, first.id, "the existing row is returned, not a new one");
  });

  // ── PLU-143: Content Brief generation provenance ──────────────────────────
  await test("recordContentBriefGeneration writes provenance onto the EXISTING row, not a new one", async () => {
    const instanceId = await seedInstance(pgdb);
    const inserted = await recordFinalAgreementOnce(agreement(instanceId), pgdb);
    assert.equal(inserted.contentBriefGeneratedAt, null, "provenance is unset at accept time");

    const generatedAt = new Date("2026-08-21T12:00:00.000Z");
    const updated = await recordContentBriefGeneration(
      instanceId,
      {
        campaignBriefId: null,
        assetRef: "uploads/brand-brief.pdf",
        templateVersion: "brand_uploaded",
        generatedAt,
      },
      pgdb,
    );
    assert.ok(updated);
    assert.equal(updated!.id, inserted.id, "same row updated, not a new insert");
    assert.equal(updated!.contentBriefCampaignBriefId, null);
    assert.equal(updated!.contentBriefAssetRef, "uploads/brand-brief.pdf");
    assert.equal(updated!.contentBriefTemplateVersion, "brand_uploaded");
    assert.deepEqual(updated!.contentBriefGeneratedAt, generatedAt);

    const rows = await pgdb
      .select()
      .from(schema.finalAgreements)
      .where(eq(schema.finalAgreements.instanceId, instanceId));
    assert.equal(rows.length, 1, "still exactly one row for this instance");
  });

  await test("recordContentBriefGeneration is safe to call twice (a retried CONTENT_BRIEF step)", async () => {
    const instanceId = await seedInstance(pgdb);
    await recordFinalAgreementOnce(agreement(instanceId), pgdb);

    await recordContentBriefGeneration(
      instanceId,
      { campaignBriefId: null, assetRef: "uploads/first.pdf", templateVersion: "brand_uploaded", generatedAt: new Date() },
      pgdb,
    );
    const second = await recordContentBriefGeneration(
      instanceId,
      { campaignBriefId: null, assetRef: "uploads/second.pdf", templateVersion: "brand_uploaded", generatedAt: new Date() },
      pgdb,
    );
    assert.equal(second!.contentBriefAssetRef, "uploads/second.pdf", "the later write wins — a plain overwrite, not append");

    const rows = await pgdb
      .select()
      .from(schema.finalAgreements)
      .where(eq(schema.finalAgreements.instanceId, instanceId));
    assert.equal(rows.length, 1, "still exactly one row — never a duplicate on retry");
  });

  await test("recordContentBriefGeneration returns null for an instance with no FinalAgreement row", async () => {
    const instanceId = await seedInstance(pgdb);
    const result = await recordContentBriefGeneration(
      instanceId,
      { campaignBriefId: null, assetRef: "uploads/orphan.pdf", templateVersion: "brand_uploaded", generatedAt: new Date() },
      pgdb,
    );
    assert.equal(result, null);
  });

  console.log(`\n${n} passed\n`);
  await pg.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
