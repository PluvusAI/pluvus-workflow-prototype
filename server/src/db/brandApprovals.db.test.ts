/**
 * PLU-118 (Calvin review follow-up) — DB-backed tests for the BrandApproval
 * lifecycle against a REAL Postgres (PGlite) with every migration applied
 * verbatim, so the new PROCESSING enum member + brandName column + the
 * predicate-guarded status transitions are byte-identical to live Neon.
 *
 * Locks the two hardening invariants:
 *   §1 token consistency — createBrandApprovalOnce reports created vs existing, and
 *      rotateBrandApprovalToken rewrites hash+expiry TOGETHER only while AWAITING.
 *   §2 decision finalized only after the action — claim → (finalize | revert) are
 *      each predicate-guarded so a decision is written exactly once, a failed
 *      action reverts to AWAITING_APPROVAL (re-clickable), and no path skips the
 *      claim.
 *
 * Run: npx tsx --test src/db/brandApprovals.db.test.ts   (or via npm test)
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  createBrandApprovalOnce,
  rotateBrandApprovalToken,
  claimBrandApprovalForProcessing,
  finalizeBrandApprovalDecision,
  revertBrandApprovalToAwaiting,
  findBrandApprovalById,
} from "./brandApprovals.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");

// Split a migration into statements on `;`, but NOT inside a `$$ … $$` dollar-quoted
// block (Prisma's idempotency guards, e.g. `DO $$ BEGIN … END $$;`, contain inner
// `;`). The shared .db.test.ts harness splits naively on `;` and so trips over these
// blocks — this test uses a $$-aware splitter so the migrations actually apply here
// and the BrandApproval invariants are exercised against real Postgres.
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements: string[] = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i]!;
    if (ch === "$" && withoutComments[i + 1] === "$") {
      inDollar = !inDollar;
      current += "$$";
      i++;
      continue;
    }
    if (ch === ";" && !inDollar) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function applyPrismaMigrations(pg: PGlite): Promise<number> {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  let applied = 0;
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
    for (const stmt of splitStatements(sql)) await pg.exec(stmt);
    applied++;
  }
  return applied;
}

// Seed an ExecutionInstance so the BrandApproval FK resolves. Returns its id.
let seedCounter = 0;
async function seedInstance(pgdb: Db): Promise<string> {
  seedCounter++;
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Approval Test", email: `approval-${seedCounter}@test.local` })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: `Approval WF ${seedCounter}` })
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

function snapshot(instanceId: string): schema.BrandApprovalInsert {
  return {
    instanceId,
    creatorName: "Maya Rivers",
    creatorEmail: "maya@example.com",
    campaignName: "Spring Launch",
    brandName: "Stridr",
    fixedFee: 450,
    commissionRate: null,
    negotiationFloor: 200,
    negotiationCeiling: 500,
    deliverables: "1 reel",
    timeline: "2 weeks",
    paymentTerms: null,
    rewardDescription: null,
    creatorHandle: "mayamakes",
    creatorPlatform: "instagram",
    threadId: null,
    acceptedAt: new Date("2026-07-01T00:00:00.000Z"),
    approveTokenHash: "hash-v1",
    tokenExpiresAt: new Date("2026-07-15T00:00:00.000Z"),
  };
}

async function main(): Promise<void> {
  console.log("\nbrandApprovals.db\n");
  const pg = new PGlite();
  const migrated = await applyPrismaMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  await test("createBrandApprovalOnce reports created=true on fresh insert, false on retry (§1)", async () => {
    const instanceId = await seedInstance(pgdb);
    const first = await createBrandApprovalOnce(snapshot(instanceId), pgdb);
    assert.equal(first.created, true, "fresh insert reports created");
    assert.equal(first.approval.brandName, "Stridr", "brandName persisted");
    assert.equal(first.approval.status, "AWAITING_APPROVAL", "defaults to AWAITING_APPROVAL");

    // A retry (same instanceId) hits the UNIQUE constraint and returns the EXISTING
    // row with its ORIGINAL token hash — created=false so the caller knows the
    // freshly minted token would NOT match.
    const retry = await createBrandApprovalOnce(
      { ...snapshot(instanceId), approveTokenHash: "hash-v2-different" },
      pgdb,
    );
    assert.equal(retry.created, false, "retry reports NOT created");
    assert.equal(retry.approval.id, first.approval.id, "same row returned");
    assert.equal(
      retry.approval.approveTokenHash,
      "hash-v1",
      "the ORIGINAL hash is preserved (the retry's hash was ignored)",
    );
  });

  await test("rotateBrandApprovalToken rewrites hash+expiry together, only while AWAITING (§1)", async () => {
    const instanceId = await seedInstance(pgdb);
    const { approval } = await createBrandApprovalOnce(snapshot(instanceId), pgdb);

    const newExpiry = new Date("2026-08-01T00:00:00.000Z");
    const rotated = await rotateBrandApprovalToken(
      approval.id,
      { approveTokenHash: "rotated-hash", tokenExpiresAt: newExpiry },
      pgdb,
    );
    assert.ok(rotated, "rotation on an AWAITING row succeeds");
    assert.equal(rotated!.approveTokenHash, "rotated-hash", "hash rotated");
    assert.equal(
      rotated!.tokenExpiresAt?.getTime(),
      newExpiry.getTime(),
      "expiry rotated in the SAME write",
    );
    assert.equal(rotated!.status, "AWAITING_APPROVAL", "still AWAITING after rotation");

    // Once decided, rotation is a no-op (predicate-guarded on AWAITING_APPROVAL).
    await claimBrandApprovalForProcessing(approval.id, {}, pgdb);
    await finalizeBrandApprovalDecision(approval.id, { status: "APPROVED" }, pgdb);
    const afterDecide = await rotateBrandApprovalToken(
      approval.id,
      { approveTokenHash: "should-not-apply", tokenExpiresAt: null },
      pgdb,
    );
    assert.equal(afterDecide, null, "rotation on a decided row matches 0 rows → null");
    const still = await findBrandApprovalById(approval.id, pgdb);
    assert.equal(still!.approveTokenHash, "rotated-hash", "decided row's hash untouched");
  });

  await test("claim → finalize writes the decision exactly once, guarded on PROCESSING (§2)", async () => {
    const instanceId = await seedInstance(pgdb);
    const { approval } = await createBrandApprovalOnce(snapshot(instanceId), pgdb);

    const claimed = await claimBrandApprovalForProcessing(
      approval.id,
      { decidedIp: "1.2.3.4", decidedUserAgent: "brand-browser" },
      pgdb,
    );
    assert.ok(claimed, "first claim succeeds");
    assert.equal(claimed!.status, "PROCESSING", "AWAITING → PROCESSING");
    assert.equal(claimed!.decidedIp, "1.2.3.4", "audit ip stamped at claim");
    assert.equal(claimed!.decidedAt, null, "NOT yet decided — decidedAt still null");

    // A concurrent/duplicate claim while PROCESSING matches 0 rows (idempotency lock).
    const dup = await claimBrandApprovalForProcessing(approval.id, {}, pgdb);
    assert.equal(dup, null, "a second claim on a PROCESSING row is a no-op");

    const finalized = await finalizeBrandApprovalDecision(
      approval.id,
      { status: "APPROVED" },
      pgdb,
    );
    assert.ok(finalized, "finalize on a PROCESSING row succeeds");
    assert.equal(finalized!.status, "APPROVED", "PROCESSING → APPROVED");
    assert.ok(finalized!.decidedAt, "decidedAt stamped at finalize");

    // Finalizing again is a no-op (no longer PROCESSING).
    const again = await finalizeBrandApprovalDecision(approval.id, { status: "REJECTED" }, pgdb);
    assert.equal(again, null, "a second finalize cannot overwrite the decision");
    const row = await findBrandApprovalById(approval.id, pgdb);
    assert.equal(row!.status, "APPROVED", "decision unchanged by the second finalize");
  });

  await test("revert returns a failed claim to AWAITING_APPROVAL and clears audit (§2)", async () => {
    const instanceId = await seedInstance(pgdb);
    const { approval } = await createBrandApprovalOnce(snapshot(instanceId), pgdb);

    await claimBrandApprovalForProcessing(
      approval.id,
      { decidedIp: "9.9.9.9", decidedUserAgent: "ua" },
      pgdb,
    );
    const reverted = await revertBrandApprovalToAwaiting(approval.id, pgdb);
    assert.ok(reverted, "revert on a PROCESSING row succeeds");
    assert.equal(reverted!.status, "AWAITING_APPROVAL", "PROCESSING → AWAITING_APPROVAL");
    assert.equal(reverted!.decidedIp, null, "audit ip cleared on revert");
    assert.equal(reverted!.decidedUserAgent, null, "audit ua cleared on revert");
    assert.equal(reverted!.decidedAt, null, "still not decided");

    // The link is now re-clickable: a fresh claim succeeds again.
    const reclaim = await claimBrandApprovalForProcessing(approval.id, {}, pgdb);
    assert.ok(reclaim, "after revert the brand can claim (click) again");
    assert.equal(reclaim!.status, "PROCESSING");

    // Revert only matches PROCESSING — reverting an AWAITING row is a no-op.
    await finalizeBrandApprovalDecision(approval.id, { status: "REJECTED" }, pgdb);
    const revertDecided = await revertBrandApprovalToAwaiting(approval.id, pgdb);
    assert.equal(revertDecided, null, "cannot revert a finalized (non-PROCESSING) row");
  });

  console.log(`\n  brandApprovals.db: ${n} assertions passed.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nbrandApprovals.db FAILED:", err);
    process.exit(1);
  });
