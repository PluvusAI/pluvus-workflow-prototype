/**
 * PLU-112 — DB-backed tests for the rolling-summary CAS against a REAL Postgres
 * (PGlite) with every Prisma migration applied verbatim, so the table + unique
 * index match live Neon.
 *
 * Covers Calvin's review #7: the compare-and-swap advance, the stale-worker
 * discard (concurrency), the unique-per-instance insert, and idempotent load.
 *
 *   npx tsx --test src/db/conversationSummary.db.test.ts
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
  loadConversationSummary,
  upsertConversationSummary,
} from "./conversationSummary.js";

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
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8"));
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
  const [workflow] = await pgdb.insert(schema.workflows).values({ name: `WF ${suffix}` }).returning();
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

  await test("first write inserts; load returns it", async () => {
    const instanceId = await seedInstance(pgdb);
    assert.equal(await loadConversationSummary(instanceId, pgdb), undefined);
    const w = await upsertConversationSummary(
      { instanceId, text: "arc so far", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      pgdb,
    );
    assert.ok(w, "insert returns the row");
    const loaded = await loadConversationSummary(instanceId, pgdb);
    assert.equal(loaded!.text, "arc so far");
    assert.equal(loaded!.summarizedThroughSentAt.getTime(), 1000);
  });

  await test("CAS advance succeeds when the expected cursor matches", async () => {
    const instanceId = await seedInstance(pgdb);
    await upsertConversationSummary(
      { instanceId, text: "v1", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      pgdb,
    );
    const advanced = await upsertConversationSummary(
      { instanceId, text: "v2", summarizedThroughSentAt: new Date(2000), version: "summary-v1.0" },
      new Date(1000),
      pgdb,
    );
    assert.ok(advanced, "advance with the matching cursor wins");
    assert.equal((await loadConversationSummary(instanceId, pgdb))!.text, "v2");
  });

  await test("stale CAS loses: a worker with an outdated cursor cannot overwrite", async () => {
    const instanceId = await seedInstance(pgdb);
    await upsertConversationSummary(
      { instanceId, text: "v1", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      pgdb,
    );
    // Worker A advances 1000 → 2000.
    await upsertConversationSummary(
      { instanceId, text: "A", summarizedThroughSentAt: new Date(2000), version: "summary-v1.0" },
      new Date(1000),
      pgdb,
    );
    // Worker B still holds the OLD cursor (1000) — its write must be discarded.
    const stale = await upsertConversationSummary(
      { instanceId, text: "B", summarizedThroughSentAt: new Date(1500), version: "summary-v1.0" },
      new Date(1000),
      pgdb,
    );
    assert.equal(stale, null, "stale write returns null (CAS lost)");
    assert.equal((await loadConversationSummary(instanceId, pgdb))!.text, "A", "newer summary preserved");
  });

  await test("concurrent first insert: the second insert loses (unique per instance)", async () => {
    const instanceId = await seedInstance(pgdb);
    const first = await upsertConversationSummary(
      { instanceId, text: "first", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      pgdb,
    );
    const second = await upsertConversationSummary(
      { instanceId, text: "second", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      pgdb,
    );
    assert.ok(first);
    assert.equal(second, null, "the second concurrent insert is discarded");
    assert.equal((await loadConversationSummary(instanceId, pgdb))!.text, "first");
  });

  console.log(`\n${n} passed\n`);
}

await main();
