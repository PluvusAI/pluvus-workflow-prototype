/**
 * OCC race test for updateInstanceStateConditional — the backstop the whole
 * engine's state machine leans on (callers branch on "did my expected-state
 * update match a row?").
 *
 * This test runs against a REAL Postgres (PGlite, embedded/in-memory) with the
 * REAL schema: every Prisma migration in prisma/migrations is applied verbatim,
 * so the table the update hits is byte-identical to the live Neon one — same
 * NOT NULL columns with no DB defaults (Prisma generated ids/updatedAt
 * client-side), same enums, same constraints. That also proves the Drizzle
 * schema's $defaultFn compensations (cuid2 ids, updatedAt stamps) satisfy the
 * live DDL on insert.
 *
 * Run:  npx tsx --test src/db/instances.occ.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { updateInstanceStateConditional } from "./instances.js";
import type { Db } from "./drizzle.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  // Same drizzle API surface as the Neon client; only the driver differs.
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── Seed one instance through the real constraints ────────────────────────
  // Inserts deliberately omit id/createdAt/updatedAt: ids and @updatedAt
  // columns have NO db default, so this passing proves the schema-level
  // $defaultFn compensations.
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Race Test Creator", email: "occ-race@test.local" })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: "OCC Race Workflow" })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: version!.id, creatorId: creator!.id })
    .returning();

  await test("insert generated client-side id + updatedAt (Prisma-magic parity)", async () => {
    assert.ok(instance!.id.length >= 20, "cuid-style id was generated");
    assert.ok(instance!.updatedAt instanceof Date, "updatedAt stamped on insert");
    assert.equal(instance!.currentState, "ENROLLED");
  });

  await test("winner: expected-state update matches and advances", async () => {
    const won = await updateInstanceStateConditional(
      instance!.id,
      "ENROLLED",
      { currentState: "OUTREACH_SENT", currentNodeId: "node-outreach" },
      pgdb,
    );
    assert.ok(won, "update with correct expected state returns the row");
    assert.equal(won.currentState, "OUTREACH_SENT");
    assert.ok(
      won.updatedAt.getTime() >= instance!.updatedAt.getTime(),
      "$onUpdate restamped updatedAt",
    );
  });

  await test("loser: stale expected state matches 0 rows → null, no throw", async () => {
    // A concurrent worker also read the instance at ENROLLED and lost the
    // race — its conditional update must be a no-op, not an exception.
    const lost = await updateInstanceStateConditional(
      instance!.id,
      "ENROLLED",
      { currentState: "FOLLOWED_UP", followUpCount: 99 },
      pgdb,
    );
    assert.equal(lost, null, "lose-the-race path returns null");

    const [row] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, instance!.id));
    assert.equal(row!.currentState, "OUTREACH_SENT", "loser wrote nothing");
    assert.equal(row!.followUpCount, 0, "loser's patch fields were not applied");
  });

  await test("unknown instance id → null, no throw", async () => {
    const missing = await updateInstanceStateConditional(
      "nonexistent-instance-id",
      "ENROLLED",
      { currentState: "OUTREACH_SENT" },
      pgdb,
    );
    assert.equal(missing, null);
  });

  await test("next legitimate transition still works after a lost race", async () => {
    const advanced = await updateInstanceStateConditional(
      instance!.id,
      "OUTREACH_SENT",
      { currentState: "AWAITING_REPLY", dueAt: new Date("2026-07-20T00:00:00Z") },
      pgdb,
    );
    assert.ok(advanced);
    assert.equal(advanced.currentState, "AWAITING_REPLY");
    assert.equal(advanced.dueAt?.toISOString(), "2026-07-20T00:00:00.000Z");
  });

  await test("BUG-E1: version is bumped on every conditional write", async () => {
    const [before] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, instance!.id));
    const startVersion = before!.version;
    const updated = await updateInstanceStateConditional(
      instance!.id,
      "AWAITING_REPLY",
      { currentState: "AWAITING_REPLY" }, // an X→X self-transition
      pgdb,
    );
    assert.ok(updated);
    assert.equal(updated.version, startVersion + 1, "version monotonically increments");
  });

  await test("BUG-E1: two concurrent X→X self-transitions — version OCC lets only ONE win", async () => {
    // Fresh creator so the (workflowVersionId, creatorId) unique index is happy.
    const [creator2] = await pgdb
      .insert(schema.creators)
      .values({ name: "OCC Two", email: "occ-two@test.local" })
      .returning();
    // Seed a fresh instance parked in NEGOTIATING (a real self-transition state).
    const [inst2] = await pgdb
      .insert(schema.executionInstances)
      .values({
        workflowVersionId: version!.id,
        creatorId: creator2!.id,
        currentState: "NEGOTIATING",
      })
      .returning();
    const v = inst2!.version;

    // Both "workers" read the same snapshot (state NEGOTIATING, version v) and
    // both attempt NEGOTIATING → NEGOTIATING. Without the version check, both
    // would match `currentState = NEGOTIATING` and BOTH commit (the E1 bug).
    const first = await updateInstanceStateConditional(
      inst2!.id,
      "NEGOTIATING",
      { currentState: "NEGOTIATING", negotiationRound: 1 },
      pgdb,
      v,
    );
    const second = await updateInstanceStateConditional(
      inst2!.id,
      "NEGOTIATING",
      { currentState: "NEGOTIATING", negotiationRound: 2 },
      pgdb,
      v, // same stale version the loser read
    );

    assert.ok(first, "the first X→X writer wins");
    assert.equal(second, null, "the second X→X writer sees the stale version → no-op null");

    const [after] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, inst2!.id));
    assert.equal(after!.version, v + 1, "only ONE write landed (version bumped once)");
    assert.equal(after!.negotiationRound, 1, "the winner's patch stuck; the loser's did not");
  });

  await pg.close();
  console.log(`\n${n} passed\n`);
}

await main();
