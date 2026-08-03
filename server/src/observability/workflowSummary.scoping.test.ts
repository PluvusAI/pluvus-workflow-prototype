/**
 * W-6 test — the workflow summary is SCOPED to one version and computed in SQL.
 *
 * The bug: getWorkflowSummary labelled the dashboard with the newest published
 * version but aggregated EVERY instance in the table with no version filter, so
 * a second campaign's creators leaked into the first's counts. This test seeds
 * TWO workflows with instances in overlapping states and asserts each summary
 * counts ONLY its own version's instances — and that the SQL aggregate paths
 * (grouped counts, stuck filter, avg-time-in-state join) execute on real DDL.
 *
 * Runs against PGlite + every Prisma migration, same harness as the OCC test.
 *
 * Run:  npx tsx --test src/observability/workflowSummary.scoping.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { db } from "../db/drizzle.js";
import { getWorkflowSummary, listWorkflowOptions } from "./repository.js";
import type { Db } from "../db/drizzle.js";
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
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // getWorkflowSummary / listWorkflowOptions read the module-level `db`. Point it
  // at PGlite for the duration of this test by swapping its internals is not
  // possible (const), so instead we redirect via a proxy: the repository uses the
  // exported `db`, so we monkeypatch the query builder methods onto it.
  // Simpler + honest: replace the pool-backed db's methods with pgdb's.
  Object.assign(db, pgdb);

  // ── Seed two workflows, each with its own published version ───────────────
  async function seedWorkflow(name: string, version: number) {
    const [wf] = await pgdb.insert(schema.workflows).values({ name }).returning();
    const [ver] = await pgdb
      .insert(schema.workflowVersions)
      .values({ workflowId: wf!.id, version, nodeGraph: [] })
      .returning();
    return { workflowId: wf!.id, versionId: ver!.id, version };
  }

  let creatorSeq = 0;
  async function seedInstance(versionId: string, state: schema.InstanceState) {
    creatorSeq++;
    const [creator] = await pgdb
      .insert(schema.creators)
      .values({ name: `C${creatorSeq}`, email: `w6-c${creatorSeq}@test.local` })
      .returning();
    const [inst] = await pgdb
      .insert(schema.executionInstances)
      .values({ workflowVersionId: versionId, creatorId: creator!.id, currentState: state })
      .returning();
    return inst!.id;
  }

  const wfA = await seedWorkflow("Campaign A", 1);
  const wfB = await seedWorkflow("Campaign B", 2); // newer version → default target

  // A: 2 NEGOTIATING, 1 ACCEPTED.  B: 3 NEGOTIATING.
  await seedInstance(wfA.versionId, "NEGOTIATING");
  await seedInstance(wfA.versionId, "NEGOTIATING");
  await seedInstance(wfA.versionId, "ACCEPTED");
  await seedInstance(wfB.versionId, "NEGOTIATING");
  await seedInstance(wfB.versionId, "NEGOTIATING");
  await seedInstance(wfB.versionId, "NEGOTIATING");

  await test("summary scoped to version A counts ONLY A's instances", async () => {
    const s = await getWorkflowSummary(wfA.versionId);
    assert.equal(s.workflow?.name, "Campaign A");
    assert.equal(s.totalInstances, 3, "A has exactly 3 instances (no B leakage)");
    const neg = s.nodes.find((n) => n.state === "NEGOTIATING")!;
    const acc = s.nodes.find((n) => n.state === "ACCEPTED")!;
    assert.equal(neg.count, 2, "A's NEGOTIATING count excludes B's 3");
    assert.equal(acc.count, 1);
  });

  await test("summary scoped to version B counts ONLY B's instances", async () => {
    const s = await getWorkflowSummary(wfB.versionId);
    assert.equal(s.workflow?.name, "Campaign B");
    assert.equal(s.totalInstances, 3);
    const neg = s.nodes.find((n) => n.state === "NEGOTIATING")!;
    assert.equal(neg.count, 3);
    const acc = s.nodes.find((n) => n.state === "ACCEPTED")!;
    assert.equal(acc.count, 0, "B has no ACCEPTED — A's is not counted here");
  });

  await test("default (no arg) targets the newest version and does not sum both", async () => {
    const s = await getWorkflowSummary();
    // Newest published version is B (version 2). Must show B's 3, NOT 6.
    assert.equal(s.workflow?.name, "Campaign B");
    assert.equal(s.totalInstances, 3, "default no longer aggregates the whole table");
  });

  await test("stuck filter + avg-time-in-state SQL execute (no runtime error)", async () => {
    // A waiting instance with a long-lapsed dueAt should surface as stuck.
    const cId = await seedInstance(wfA.versionId, "AWAITING_REPLY");
    await pgdb
      .update(schema.executionInstances)
      .set({ dueAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(schema.executionInstances.id, cId));

    const s = await getWorkflowSummary(wfA.versionId);
    const wait = s.nodes.find((n) => n.state === "AWAITING_REPLY")!;
    assert.equal(wait.stuck, 1, "long-lapsed AWAITING_REPLY is flagged stuck via SQL filter");
    assert.ok(
      wait.avgTimeInStateSeconds === null || typeof wait.avgTimeInStateSeconds === "number",
      "avg-time-in-state aggregate returned a number or null, not an error",
    );
  });

  await test("listWorkflowOptions returns one row per workflow with counts", async () => {
    const opts = await listWorkflowOptions();
    assert.equal(opts.length, 2, "two workflows");
    const a = opts.find((o) => o.workflowName === "Campaign A")!;
    const b = opts.find((o) => o.workflowName === "Campaign B")!;
    assert.equal(a.instanceCount, 4, "A now has 4 (3 + the stuck AWAITING_REPLY)");
    assert.equal(b.instanceCount, 3);
    assert.equal(a.latestVersion, 1);
    assert.equal(b.latestVersion, 2);
  });

  await pg.close();
  console.log(`\n${n} passed\n`);
}

await main();
