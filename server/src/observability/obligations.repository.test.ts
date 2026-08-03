/**
 * PLU-111 — observability repository tests: getInstanceDetail exposes
 * obligations[] and the operator manual-resolution path (resolveInstanceObligation)
 * flips a row to terminal, scopes to the instance, and is idempotent.
 *
 * Runs against PGlite + every Prisma migration, monkeypatching the module-level
 * `db` (same technique as workflowSummary.scoping.test.ts). The shared migration
 * helper preserves DO $$…$$ bodies and enum-growth statement boundaries.
 *
 * Run:  npx tsx --test src/observability/obligations.repository.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema.js";
import { db } from "../db/drizzle.js";
import type { Db } from "../db/drizzle.js";
import { getInstanceDetail, resolveInstanceObligation } from "./repository.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

let seq = 0;
async function seedInstance(pgdb: Db): Promise<string> {
  seq++;
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: `Obs ${seq}`, email: `obs-obl-${seq}@test.local` })
    .returning();
  const [wf] = await pgdb.insert(schema.workflows).values({ name: `WF ${seq}` }).returning();
  const [ver] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: wf!.id, version: 1, nodeGraph: [] })
    .returning();
  const [inst] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: ver!.id, creatorId: creator!.id, currentState: "NEGOTIATING" })
    .returning();
  return inst!.id;
}

async function main(): Promise<void> {
  console.log("\nPLU-111 observability repository (obligations)\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;
  Object.assign(db, pgdb); // redirect the module-level db the repository reads

  await test("getInstanceDetail includes obligations[] (open + resolved)", async () => {
    const instanceId = await seedInstance(pgdb);
    await pgdb.insert(schema.conversationObligations).values([
      {
        instanceId,
        type: "CREATOR_QUESTION",
        status: "OPEN",
        originalText: "what's the fee?",
        normalizedKey: "what s the fee",
      },
      {
        instanceId,
        type: "PLUVUS_COMMITMENT",
        status: "OPEN",
        originalText: "confirm usage rights",
        normalizedKey: "confirm usage rights",
      },
      {
        instanceId,
        type: "CREATOR_QUESTION",
        status: "ANSWERED",
        originalText: "when do I get paid?",
        normalizedKey: "when do i get paid",
        resolvedAt: new Date(),
        resolutionSource: "ai",
      },
    ]);

    const detail = await getInstanceDetail(instanceId);
    assert.ok(detail, "instance detail returned");
    assert.equal(detail!.obligations.length, 3);
    const open = detail!.obligations.filter((o) => o.open);
    assert.equal(open.length, 2, "two non-terminal (OPEN) rows are marked open");
    const answered = detail!.obligations.find((o) => o.status === "ANSWERED")!;
    assert.equal(answered.open, false);
    assert.ok(detail!.obligations.some((o) => o.type === "PLUVUS_COMMITMENT"));
  });

  await test("resolveInstanceObligation flips to terminal + resolutionSource=operator", async () => {
    const instanceId = await seedInstance(pgdb);
    const [ob] = await pgdb
      .insert(schema.conversationObligations)
      .values({
        instanceId,
        type: "CREATOR_QUESTION",
        status: "OPEN",
        originalText: "usage rights?",
        normalizedKey: "usage rights",
      })
      .returning();
    const outcome = await resolveInstanceObligation(instanceId, ob!.id, {
      status: "ANSWERED",
      resolution: "answered by operator",
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.obligation.status, "ANSWERED");
      assert.equal(outcome.obligation.resolutionSource, "operator");
      assert.equal(outcome.obligation.open, false);
    }
  });

  await test("resolveInstanceObligation refuses an obligation from a DIFFERENT instance", async () => {
    const instanceA = await seedInstance(pgdb);
    const instanceB = await seedInstance(pgdb);
    const [obB] = await pgdb
      .insert(schema.conversationObligations)
      .values({
        instanceId: instanceB,
        type: "CREATOR_QUESTION",
        status: "OPEN",
        originalText: "cross?",
        normalizedKey: "cross",
      })
      .returning();
    // Try to resolve instanceB's obligation via instanceA's URL scope → refused.
    const outcome = await resolveInstanceObligation(instanceA, obB!.id, { status: "CANCELED" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "obligation_not_found");
    // The row is untouched (still OPEN).
    const detailB = await getInstanceDetail(instanceB);
    assert.equal(detailB!.obligations.find((o) => o.id === obB!.id)!.status, "OPEN");
  });

  await test("resolveInstanceObligation is idempotent on an already-terminal row", async () => {
    const instanceId = await seedInstance(pgdb);
    const [ob] = await pgdb
      .insert(schema.conversationObligations)
      .values({
        instanceId,
        type: "PLUVUS_COMMITMENT",
        status: "OPEN",
        originalText: "confirm shipping",
        normalizedKey: "confirm shipping",
      })
      .returning();
    await resolveInstanceObligation(instanceId, ob!.id, { status: "COMPLETED" });
    const again = await resolveInstanceObligation(instanceId, ob!.id, { status: "CANCELED" });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.obligation.status, "COMPLETED", "already terminal → unchanged");
  });

  console.log(`\n✓ observability obligations: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
