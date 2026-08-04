/**
 * PLU-113 — DB-backed tests for campaign-scoped creator memory against a REAL
 * Postgres (PGlite, embedded) with the REAL schema (every Prisma migration applied
 * verbatim), so the tables, enums, and the partial-unique live index are byte-
 * identical to live Neon.
 *
 * Covers the issue's acceptance criteria + Calvin's review points:
 *   - revision history: $400 → $600 → $800 keeps ALL prior values (review #4).
 *   - conflicting facts are NOT silently overwritten (status CONFLICTED, pair kept).
 *   - facts are traceable to source Messages (revision.sourceMessageId + evidence).
 *   - operator edits have unambiguous provenance (source=operator, no sourceMessageId,
 *     numeric mirror recalculated — review #5).
 *   - campaign-specific info does not leak across instances (no cross-campaign leak).
 *   - failed memory writes are recorded, listed, and resolvable (review #6).
 *
 * Run:  npx tsx --test src/db/campaignCreatorMemory.db.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  listLiveCreatorMemory,
  listCreatorMemoryWithRevisions,
  applyMemoryWritePlan,
  operatorCorrectFact,
  operatorCreateFact,
  operatorRemoveFact,
  recordFailedMemoryWrite,
  listPendingFailedMemoryWrites,
  resolveFailedMemoryWrite,
} from "./campaignCreatorMemory.js";
import {
  memoryDedupKey,
  normalizeMemoryValue,
  singletonSentinel,
  type MemoryWritePlanItem,
} from "../engine/memoryKeys.js";

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
  const suffix = `mem-${seedN++}`;
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Memory Test", email: `${suffix}@test.local` })
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

async function seedInbound(pgdb: Db, instanceId: string, body: string): Promise<string> {
  const [m] = await pgdb
    .insert(schema.messages)
    .values({ instanceId, direction: "INBOUND", body })
    .returning();
  return m!.id;
}

function rateItem(rate: number, sourceMessageId: string): MemoryWritePlanItem {
  const value = String(rate);
  return {
    key: "MINIMUM_RATE",
    value,
    valueNumber: rate,
    normalizedValue: singletonSentinel("MINIMUM_RATE"),
    matchValue: normalizeMemoryValue(value),
    confidence: 0.9,
    sourceMessageId,
    evidenceText: `I can't go below ${rate}`,
  };
}

function listItem(
  key: MemoryWritePlanItem["key"],
  value: string,
  sourceMessageId: string,
): MemoryWritePlanItem {
  const matchValue = normalizeMemoryValue(value);
  return {
    key,
    value,
    valueNumber: null,
    normalizedValue: memoryDedupKey(key, matchValue),
    matchValue,
    confidence: 0.9,
    sourceMessageId,
    evidenceText: value,
  };
}

async function main(): Promise<void> {
  console.log("\ncampaignCreatorMemory.db\n");
  const pg = new PGlite();
  const migrated = await applyPrismaMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── revision history: $400 → $600 → $800 keeps ALL prior values (review #4) ──
  await test("singleton revision history preserves every prior value ($400→$600→$800)", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "I can't go below 400");
    const m2 = await seedInbound(pgdb, instanceId, "actually I can't go below 600");
    const m3 = await seedInbound(pgdb, instanceId, "make that I can't go below 800");

    await applyMemoryWritePlan(instanceId, [rateItem(400, m1)], pgdb);
    await applyMemoryWritePlan(instanceId, [rateItem(600, m2)], pgdb);
    await applyMemoryWritePlan(instanceId, [rateItem(800, m3)], pgdb);

    // The LIVE head is 800.
    const live = await listLiveCreatorMemory(instanceId, pgdb);
    const rate = live.find((r) => r.key === "MINIMUM_RATE");
    assert.ok(rate);
    assert.equal(rate!.valueNumber, 800);
    assert.equal(rate!.status, "CONFLICTED"); // materially changed from prior

    // The FULL history (across all heads for this instance/key) has all three values.
    const all = await listCreatorMemoryWithRevisions(instanceId, pgdb);
    const values = all
      .flatMap((f) => f.revisions)
      .map((r) => r.valueNumber)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    assert.deepEqual(values, [400, 600, 800], "every prior value survives");
  });

  // ── conflicting facts are NOT silently overwritten ─────────────────────────
  await test("a singleton material change surfaces both values (conflict pair)", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "free in July");
    const m2 = await seedInbound(pgdb, instanceId, "actually away in July");
    await applyMemoryWritePlan(instanceId, [listItem("AVAILABILITY", "free in July", m1)], pgdb);
    await applyMemoryWritePlan(instanceId, [listItem("AVAILABILITY", "away in July", m2)], pgdb);

    const live = await listLiveCreatorMemory(instanceId, pgdb);
    const avail = live.find((r) => r.key === "AVAILABILITY");
    assert.ok(avail);
    assert.equal(avail!.status, "CONFLICTED");
    assert.equal(avail!.value, "away in July");
    assert.equal(avail!.conflictValue, "free in July", "prior value kept as the conflict pair");
    assert.equal(
      avail!.conflictSourceMessageId,
      m1,
      "the prior value's source message is preserved",
    );
  });

  // ── same value again → confirming revision, head unchanged ─────────────────
  await test("repeating the same singleton value adds a revision but no conflict", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "away in August");
    const m2 = await seedInbound(pgdb, instanceId, "still away in August");
    await applyMemoryWritePlan(instanceId, [listItem("AVAILABILITY", "away in August", m1)], pgdb);
    const res = await applyMemoryWritePlan(
      instanceId,
      [listItem("AVAILABILITY", "away in August!", m2)],
      pgdb,
    );
    assert.equal(res.unchanged, 1);
    const live = await listLiveCreatorMemory(instanceId, pgdb);
    assert.equal(live.filter((r) => r.key === "AVAILABILITY").length, 1);
  });

  // ── list keys accumulate distinct rows ─────────────────────────────────────
  await test("list keys accumulate one live row per distinct value", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "no perpetual rights");
    await applyMemoryWritePlan(
      instanceId,
      [
        listItem("OBJECTION", "no perpetual rights", m1),
        listItem("OBJECTION", "no exclusivity", m1),
      ],
      pgdb,
    );
    const live = await listLiveCreatorMemory(instanceId, pgdb);
    assert.equal(live.filter((r) => r.key === "OBJECTION").length, 2);
  });

  // ── traceability: each revision links to its source message + evidence ─────
  await test("facts are traceable to source Messages with evidence", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "travelling until August");
    await applyMemoryWritePlan(
      instanceId,
      [listItem("AVAILABILITY", "away until August", m1)],
      pgdb,
    );
    const [withRev] = await listCreatorMemoryWithRevisions(instanceId, pgdb);
    assert.ok(withRev);
    const rev = withRev!.revisions[0]!;
    assert.equal(rev.source, "creator");
    assert.equal(rev.sourceMessageId, m1);
    assert.equal(rev.evidenceText, "away until August");
  });

  // ── operator provenance (review #5) ────────────────────────────────────────
  await test("operator correct: source=operator, no sourceMessageId, numeric recalc", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "I can't go below 400");
    await applyMemoryWritePlan(instanceId, [rateItem(400, m1)], pgdb);
    const [before] = await listLiveCreatorMemory(instanceId, pgdb);

    const updated = await operatorCorrectFact(
      before!.id,
      { value: "550", note: "confirmed on a call" },
      pgdb,
    );
    assert.ok(updated);
    assert.equal(updated!.value, "550");
    assert.equal(updated!.valueNumber, 550, "numeric mirror recalculated");
    assert.equal(updated!.status, "ACTIVE", "operator edit reconciles the conflict");

    const withRev = (await listCreatorMemoryWithRevisions(instanceId, pgdb)).find(
      (f) => f.fact.id === before!.id,
    );
    const opRev = withRev!.revisions[0]!; // newest first
    assert.equal(opRev.source, "operator");
    assert.equal(opRev.sourceMessageId, null, "operator value carries NO source message");
    assert.equal(opRev.note, "confirmed on a call");
    // The original creator revision still carries its source message (history intact).
    const creatorRev = withRev!.revisions.find((r) => r.source === "creator");
    assert.equal(creatorRev!.sourceMessageId, m1);
  });

  await test("operator create + remove (soft), history kept", async () => {
    const instanceId = await seedInstance(pgdb);
    const created = await operatorCreateFact(
      instanceId,
      {
        key: "MANAGER_CONTACT",
        value: "jane@mgmt.co",
        normalizedValue: memoryDedupKey("MANAGER_CONTACT", normalizeMemoryValue("jane@mgmt.co")),
        note: "from a phone call",
      },
      pgdb,
    );
    assert.ok(created);
    let live = await listLiveCreatorMemory(instanceId, pgdb);
    assert.equal(live.length, 1);

    await operatorRemoveFact(created!.id, "no longer relevant", pgdb);
    live = await listLiveCreatorMemory(instanceId, pgdb);
    assert.equal(live.length, 0, "removed fact drops out of the live read");
    const withRev = await listCreatorMemoryWithRevisions(instanceId, pgdb);
    assert.equal(withRev.length, 1, "the removed head + its revisions are kept for audit");
  });

  // ── no cross-campaign leak ─────────────────────────────────────────────────
  await test("campaign-specific info does not leak across instances", async () => {
    const a = await seedInstance(pgdb);
    const b = await seedInstance(pgdb);
    const ma = await seedInbound(pgdb, a, "no perpetual rights");
    await applyMemoryWritePlan(a, [listItem("OBJECTION", "no perpetual rights", ma)], pgdb);
    const liveA = await listLiveCreatorMemory(a, pgdb);
    const liveB = await listLiveCreatorMemory(b, pgdb);
    assert.equal(liveA.length, 1);
    assert.equal(liveB.length, 0, "instance B sees none of instance A's memory");
  });

  // ── failed memory writes (review #6) ───────────────────────────────────────
  await test("failed memory writes are recorded, listed, and resolvable", async () => {
    const instanceId = await seedInstance(pgdb);
    const m1 = await seedInbound(pgdb, instanceId, "away in August");
    const failed = await recordFailedMemoryWrite(
      {
        instanceId,
        plan: [listItem("AVAILABILITY", "away in August", m1)],
        sourceMessageId: m1,
        error: "boom",
      },
      pgdb,
    );
    let pending = await listPendingFailedMemoryWrites(instanceId, pgdb);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.error, "boom");

    await resolveFailedMemoryWrite(failed.id, "DISCARDED", pgdb);
    pending = await listPendingFailedMemoryWrites(instanceId, pgdb);
    assert.equal(pending.length, 0, "resolved write drops out of the pending read");

    const [row] = await pgdb
      .select()
      .from(schema.failedMemoryWrite)
      .where(eq(schema.failedMemoryWrite.id, failed.id));
    assert.equal(row!.status, "DISCARDED");
    assert.ok(row!.resolvedAt instanceof Date);
  });

  console.log(`\n✓ campaignCreatorMemory.db: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
