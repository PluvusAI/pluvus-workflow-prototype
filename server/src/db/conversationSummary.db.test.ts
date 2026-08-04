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

/** Insert a minimal SENT outbound Message and return its id — the cursor's
 *  summarizedThroughMessageId has an FK to Message, so the compound-CAS tests must
 *  point at real rows. `atMs` is the sentAt used to model same-instant sends. */
async function seedMessage(pgdb: Db, instanceId: string, atMs: number): Promise<string> {
  const [m] = await pgdb
    .insert(schema.messages)
    .values({ instanceId, direction: "OUTBOUND", body: `msg@${atMs}`, sentAt: new Date(atMs) })
    .returning();
  return m!.id;
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
      null,
      pgdb,
    );
    const advanced = await upsertConversationSummary(
      { instanceId, text: "v2", summarizedThroughSentAt: new Date(2000), version: "summary-v1.0" },
      new Date(1000),
      null,
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
      null,
      pgdb,
    );
    // Worker A advances 1000 → 2000.
    await upsertConversationSummary(
      { instanceId, text: "A", summarizedThroughSentAt: new Date(2000), version: "summary-v1.0" },
      new Date(1000),
      null,
      pgdb,
    );
    // Worker B still holds the OLD cursor (1000) — its write must be discarded.
    const stale = await upsertConversationSummary(
      { instanceId, text: "B", summarizedThroughSentAt: new Date(1500), version: "summary-v1.0" },
      new Date(1000),
      null,
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
      null,
      pgdb,
    );
    const second = await upsertConversationSummary(
      { instanceId, text: "second", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      null,
      pgdb,
    );
    assert.ok(first);
    assert.equal(second, null, "the second concurrent insert is discarded");
    assert.equal((await loadConversationSummary(instanceId, pgdb))!.text, "first");
  });

  // --- founder review #2: two workers advancing WITHIN THE SAME timestamp -------
  // The whole point of the compound CAS. Both workers see the same prior cursor
  // (1000, mA) and both advance to the SAME sentAt (2000) but DIFFERENT messageIds:
  // worker one → (2000, mC), worker two → (2000, mB). Worker one commits first. With
  // a timestamp-only guard, worker two's expected sentAt (still 1000) would... no —
  // the real hazard is the NEXT round: once the stored cursor is (2000, mC), a stale
  // worker that loaded (2000, mB) as its expected cursor (e.g. it computed a delta
  // ending at mB) must NOT match. A timestamp-only CAS would see stored.sentAt=2000
  // == expected 2000 and clobber mC with the older mB. The compound guard rejects it.
  await test("same-timestamp advances: a stale write sharing only the sentAt half cannot overwrite", async () => {
    const instanceId = await seedInstance(pgdb);
    // Two real messages the cursor can point at, both sent at the SAME instant.
    const mB = await seedMessage(pgdb, instanceId, 2000);
    const mC = await seedMessage(pgdb, instanceId, 2000);
    // Prior cursor: (1000, null).
    await upsertConversationSummary(
      { instanceId, text: "v1", summarizedThroughSentAt: new Date(1000), version: "summary-v1.0" },
      null,
      null,
      pgdb,
    );
    // Worker ONE advances (1000,null) → (2000, mC) and commits.
    const one = await upsertConversationSummary(
      {
        instanceId,
        text: "one → mC",
        summarizedThroughSentAt: new Date(2000),
        summarizedThroughMessageId: mC,
        version: "summary-v1.0",
      },
      new Date(1000),
      null,
      pgdb,
    );
    assert.ok(one, "worker one's advance wins");
    // Worker TWO also loaded the old (1000,null) cursor and tries to advance to
    // (2000, mB). Its expected cursor is still (1000, null) — the sentAt half would
    // MATCH a timestamp-only guard against the row worker one left at 2000 only if it
    // had used 2000; here it correctly loses on sentAt. So test the sharper case too:
    const twoFromOld = await upsertConversationSummary(
      {
        instanceId,
        text: "two → mB (from stale 1000 cursor)",
        summarizedThroughSentAt: new Date(2000),
        summarizedThroughMessageId: mB,
        version: "summary-v1.0",
      },
      new Date(1000),
      null,
      pgdb,
    );
    assert.equal(twoFromOld, null, "stale (1000,null) cursor cannot overwrite the (2000,mC) row");

    // The crux the founder described: a worker that loaded (2000, mB) as its expected
    // cursor — same TIMESTAMP as the stored (2000, mC) but a different messageId —
    // must be rejected by the compound guard. A timestamp-only CAS would let it win.
    const staleSameTs = await upsertConversationSummary(
      {
        instanceId,
        text: "stale same-timestamp, wrong messageId",
        summarizedThroughSentAt: new Date(3000),
        summarizedThroughMessageId: await seedMessage(pgdb, instanceId, 3000),
        version: "summary-v1.0",
      },
      new Date(2000),
      mB, // expected (2000, mB) — but the stored cursor is (2000, mC)
      pgdb,
    );
    assert.equal(staleSameTs, null, "same-sentAt but wrong messageId ⇒ CAS lost (compound guard)");
    const finalRow = await loadConversationSummary(instanceId, pgdb);
    assert.equal(finalRow!.text, "one → mC", "the (2000,mC) summary is preserved");
    assert.equal(finalRow!.summarizedThroughMessageId, mC);

    // And the LEGITIMATE continuation — a worker holding the true (2000, mC) cursor —
    // still advances cleanly.
    const good = await upsertConversationSummary(
      {
        instanceId,
        text: "legit advance from (2000,mC)",
        summarizedThroughSentAt: new Date(4000),
        summarizedThroughMessageId: await seedMessage(pgdb, instanceId, 4000),
        version: "summary-v1.0",
      },
      new Date(2000),
      mC, // correct expected compound cursor
      pgdb,
    );
    assert.ok(good, "the worker holding the true (2000,mC) cursor advances");
    assert.equal((await loadConversationSummary(instanceId, pgdb))!.text, "legit advance from (2000,mC)");
  });

  console.log(`\n${n} passed\n`);
}

await main();
