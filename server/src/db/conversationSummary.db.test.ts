/**
 * PLU-112 — DB-backed tests for the ConversationSummary table against a REAL
 * Postgres (PGlite, embedded) with the REAL schema (every migration applied
 * verbatim), so the table + unique(instanceId) index + both FKs are byte-identical
 * to live Neon.
 *
 * Covers:
 *   - insert then read back a rolling summary for an instance.
 *   - upsert (onConflictDoUpdate) collapses onto ONE row per instance (the
 *     unique(instanceId) index) and advances the cursor + text.
 *   - instance isolation: a summary on instance A does not appear on instance B.
 *   - the cursor is a nullable timestamp (null before the first real summary).
 *
 * Run:  npx tsx --test src/db/conversationSummary.db.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { getSummaryByInstance, upsertSummary } from "./conversationSummary.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");

async function applyPrismaMigrations(pg: PGlite): Promise<number> {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  let applied = 0;
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
    await pg.exec(sql);
    applied++;
  }
  return applied;
}

let seedN = 0;
async function seedInstance(pgdb: Db): Promise<string> {
  const suffix = `sum-${seedN++}`;
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Summary Test", email: `${suffix}@test.local` })
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

async function main(): Promise<void> {
  console.log("\nconversationSummary.db\n");
  const pg = new PGlite();
  const migrated = await applyPrismaMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  await test("insert then read back a rolling summary", async () => {
    const instanceId = await seedInstance(pgdb);
    const cursor = new Date(2026, 0, 1, 0, 5, 0);
    const written = await upsertSummary(
      { instanceId, text: "Creator opened at $600.", summarizedThroughSentAt: cursor, version: "summary-v1", estimatedInputTokensSaved: 200 },
      pgdb,
    );
    assert.equal(written.text, "Creator opened at $600.");
    assert.equal(written.version, "summary-v1");
    assert.equal(written.estimatedInputTokensSaved, 200);

    const read = await getSummaryByInstance(instanceId, pgdb);
    assert.ok(read, "summary reads back");
    assert.equal(read!.text, "Creator opened at $600.");
    assert.equal(read!.summarizedThroughSentAt?.getTime(), cursor.getTime());
  });

  await test("upsert collapses onto ONE row per instance + advances cursor/text", async () => {
    const instanceId = await seedInstance(pgdb);
    const c1 = new Date(2026, 0, 1, 0, 5, 0);
    const c2 = new Date(2026, 0, 1, 0, 10, 0);
    await upsertSummary({ instanceId, text: "v1 narrative", summarizedThroughSentAt: c1, version: "summary-v1" }, pgdb);
    const second = await upsertSummary({ instanceId, text: "v2 narrative", summarizedThroughSentAt: c2, version: "summary-v1" }, pgdb);
    assert.equal(second.text, "v2 narrative", "text advanced");
    assert.equal(second.summarizedThroughSentAt?.getTime(), c2.getTime(), "cursor advanced");

    // Still exactly one row for this instance (the unique(instanceId) index).
    const rows = await pgdb.select().from(schema.conversationSummaries);
    const forThis = rows.filter((r) => r.instanceId === instanceId);
    assert.equal(forThis.length, 1, "exactly one summary row per instance after two upserts");
    assert.equal(forThis[0]!.text, "v2 narrative");
  });

  await test("instance isolation: a summary on A does not appear on B", async () => {
    const a = await seedInstance(pgdb);
    const b = await seedInstance(pgdb);
    await upsertSummary({ instanceId: a, text: "A summary", summarizedThroughSentAt: null }, pgdb);
    const onB = await getSummaryByInstance(b, pgdb);
    assert.equal(onB, undefined, "instance B has no summary");
    const onA = await getSummaryByInstance(a, pgdb);
    assert.equal(onA!.text, "A summary");
  });

  await test("cursor is nullable (null before the first finalized summary)", async () => {
    const instanceId = await seedInstance(pgdb);
    const w = await upsertSummary({ instanceId, text: "bootstrap", summarizedThroughSentAt: null }, pgdb);
    assert.equal(w.summarizedThroughSentAt, null);
    const read = await getSummaryByInstance(instanceId, pgdb);
    assert.equal(read!.summarizedThroughSentAt, null);
  });

  console.log(`\nconversationSummary.db: ${n} passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
