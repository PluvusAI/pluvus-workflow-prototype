/**
 * PLU-113 — DB-backed tests for the CampaignCreatorMemory ledger against a REAL
 * Postgres (PGlite, embedded) with the REAL schema (every Prisma migration applied
 * verbatim), so the table, both enums, and the partial-unique live index are
 * byte-identical to live Neon.
 *
 * Covers the spec's DB acceptance tests (§7):
 *   - conflict trail: a material singleton change → CONFLICTED + priorValue kept.
 *   - consistent restatement → touch (no conflict), confidence refreshed to max.
 *   - list keys accumulate distinct rows; a re-stated one touches (dedup).
 *   - campaign isolation: a fact on instance A does not appear in instance B.
 *   - a round-1 objection survives to a later round (still live).
 *   - provenance: an AI fact has sourceMessageId; an operator fact has source=operator.
 *   - rolled-back turn: a thrown tx leaves NO memory rows.
 *   - concurrent double-insert → partial-unique live index → one live row.
 *   - operator correct: EDIT / RESOLVE_CONFLICT / REMOVE.
 *
 * Applies each migration file WHOLE via pg.exec() (handles DO $$…$$ blocks + the
 * partial-unique index natively).
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
import { isUniqueViolation } from "./errors.js";
import {
  listLiveMemoryByInstance,
  listMemoryByInstance,
  upsertMemoryFact,
  correctMemoryFact,
  createOperatorMemoryFact,
  type UpsertMemoryFactArgs,
} from "./campaignCreatorMemory.js";

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

/** Seed an INBOUND message and return its id (a fact's source). */
async function seedInbound(pgdb: Db, instanceId: string, body: string): Promise<string> {
  const [m] = await pgdb
    .insert(schema.messages)
    .values({ instanceId, direction: "INBOUND", body })
    .returning();
  return m!.id;
}

// A REQUESTED_RATE singleton write (the shape the executor builds).
function rateWrite(
  instanceId: string,
  value: string,
  valueNumber: number,
  over: Partial<UpsertMemoryFactArgs> = {},
): UpsertMemoryFactArgs {
  return {
    instanceId,
    key: "REQUESTED_RATE",
    singleton: true,
    value,
    valueNumber,
    normalizedValue: "__singleton__REQUESTED_RATE",
    matchValue: value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(),
    confidence: 1,
    ...over,
  };
}

// An OBJECTION list write.
function objectionWrite(
  instanceId: string,
  value: string,
  over: Partial<UpsertMemoryFactArgs> = {},
): UpsertMemoryFactArgs {
  const norm = value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return {
    instanceId,
    key: "OBJECTION",
    singleton: false,
    value,
    normalizedValue: norm,
    matchValue: norm,
    confidence: 0.9,
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("\ncampaignCreatorMemory.db\n");
  const pg = new PGlite();
  const migrated = await applyPrismaMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── conflict trail: material singleton change → CONFLICTED + prior retained ──
  await test("round-1 $400 → ACTIVE; round-3 $600 → CONFLICTED, priorValue=400 (§4.6)", async () => {
    const instanceId = await seedInstance(pgdb);
    const inb1 = await seedInbound(pgdb, instanceId, "I'd want $400 for this.");
    const inb3 = await seedInbound(pgdb, instanceId, "Actually I need $600 now.");

    const r1 = await upsertMemoryFact(rateWrite(instanceId, "400", 400, { sourceMessageId: inb1 }), pgdb);
    assert.equal(r1.outcome, "inserted");
    assert.equal(r1.fact.status, "ACTIVE");

    const r3 = await upsertMemoryFact(rateWrite(instanceId, "600", 600, { sourceMessageId: inb3 }), pgdb);
    assert.equal(r3.outcome, "conflicted");
    assert.equal(r3.fact.status, "CONFLICTED");
    assert.equal(r3.fact.value, "600");
    assert.equal(r3.fact.valueNumber, 600);
    assert.equal(r3.fact.priorValue, "400");
    assert.equal(r3.fact.priorSourceMessageId, inb1, "prior source retained");

    // Exactly one live row (the conflict replaced in place, not a new row).
    const live = await listLiveMemoryByInstance(instanceId, pgdb);
    assert.equal(live.length, 1);
  });

  // ── consistent restatement → touch (no conflict), confidence to max ──────────
  await test("singleton re-stated with the SAME value → touch, confidence→max (§4.6)", async () => {
    const instanceId = await seedInstance(pgdb);
    await upsertMemoryFact(rateWrite(instanceId, "500", 500, { confidence: 0.6 }), pgdb);
    const again = await upsertMemoryFact(rateWrite(instanceId, "500", 500, { confidence: 0.9 }), pgdb);
    assert.equal(again.outcome, "touched");
    assert.equal(again.fact.status, "ACTIVE");
    assert.equal(again.fact.confidence, 0.9, "confidence refreshed to the max seen");
    const live = await listLiveMemoryByInstance(instanceId, pgdb);
    assert.equal(live.length, 1);
  });

  // ── list keys accumulate distinct rows; re-stated one touches ────────────────
  await test("OBJECTION list: distinct values accumulate; a re-statement touches", async () => {
    const instanceId = await seedInstance(pgdb);
    const a = await upsertMemoryFact(objectionWrite(instanceId, "no exclusivity"), pgdb);
    const b = await upsertMemoryFact(objectionWrite(instanceId, "no perpetual usage rights"), pgdb);
    assert.equal(a.outcome, "inserted");
    assert.equal(b.outcome, "inserted");
    // Re-state the first with different punctuation/case → same normalized → touch.
    const aAgain = await upsertMemoryFact(objectionWrite(instanceId, "No  Exclusivity!"), pgdb);
    assert.equal(aAgain.outcome, "touched");
    assert.equal(aAgain.fact.id, a.fact.id);
    const live = await listLiveMemoryByInstance(instanceId, pgdb);
    assert.equal(live.length, 2, "two distinct objections, no duplicate");
  });

  // ── campaign isolation: A's fact never appears in B's read ───────────────────
  await test("campaign isolation: a fact on instance A is not in instance B's read", async () => {
    const instanceA = await seedInstance(pgdb);
    const instanceB = await seedInstance(pgdb);
    await upsertMemoryFact(rateWrite(instanceA, "700", 700), pgdb);
    const liveA = await listLiveMemoryByInstance(instanceA, pgdb);
    const liveB = await listLiveMemoryByInstance(instanceB, pgdb);
    assert.equal(liveA.length, 1);
    assert.equal(liveB.length, 0, "instance B's memory is empty — no cross-campaign leak");
  });

  // ── a round-1 objection survives to a later round (still live) ───────────────
  await test("a round-1 objection stays live after later turns (survives summarization)", async () => {
    const instanceId = await seedInstance(pgdb);
    await upsertMemoryFact(objectionWrite(instanceId, "no usage rights"), pgdb);
    // Simulate later turns writing OTHER facts (different key, different objection).
    await upsertMemoryFact(
      { ...objectionWrite(instanceId, "reels only"), key: "DELIVERABLE_PREFERENCE" },
      pgdb,
    );
    await upsertMemoryFact(rateWrite(instanceId, "500", 500), pgdb);
    const live = await listLiveMemoryByInstance(instanceId, pgdb);
    const objections = live.filter((r) => r.key === "OBJECTION").map((r) => r.value);
    assert.ok(objections.includes("no usage rights"), "the round-1 objection is still live");
  });

  // ── provenance: AI fact has sourceMessageId; operator fact has source=operator ─
  await test("provenance: AI fact → sourceMessageId; operator fact → source=operator (§4.1)", async () => {
    const instanceId = await seedInstance(pgdb);
    const inbound = await seedInbound(pgdb, instanceId, "no exclusivity please");
    const ai = await upsertMemoryFact(objectionWrite(instanceId, "no exclusivity", { sourceMessageId: inbound }), pgdb);
    assert.equal(ai.fact.source, "ai");
    assert.equal(ai.fact.sourceMessageId, inbound);

    const op = await createOperatorMemoryFact(
      {
        instanceId,
        key: "MANAGER_CONTACT",
        singleton: true,
        value: "Jane <jane@mgmt.co>",
        normalizedValue: "__singleton__MANAGER_CONTACT",
      },
      pgdb,
    );
    assert.equal(op.source, "operator");
    assert.equal(op.confidence, 1);
    assert.equal(op.sourceMessageId, null, "operator entry has no source message — that IS its provenance");
  });

  // ── rolled-back turn: a thrown tx leaves NO memory rows (§4.7) ────────────────
  await test("rolled-back tx: memory writes roll back (no rows)", async () => {
    const instanceId = await seedInstance(pgdb);
    await assert.rejects(
      pgdb.transaction(async (tx) => {
        await upsertMemoryFact(rateWrite(instanceId, "800", 800), tx as unknown as Db);
        throw new Error("simulated StaleInstanceError");
      }),
    );
    const rows = await listMemoryByInstance(instanceId, pgdb);
    assert.equal(rows.length, 0, "the whole tx rolled back — no half-written fact");
  });

  // ── memory writes commit WITH the NEGOTIATION_TURN event (atomic) ────────────
  await test("memory writes + NEGOTIATION_TURN event are atomic (both roll back)", async () => {
    const instanceId = await seedInstance(pgdb);
    await assert.rejects(
      pgdb.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          instanceId,
          type: "NEGOTIATION_TURN",
          payload: { outcome: "counter", round: 1 } as schema.JsonValue,
        });
        await upsertMemoryFact(objectionWrite(instanceId, "atomic objection"), tx as unknown as Db);
        throw new Error("simulated StaleInstanceError");
      }),
    );
    const events = await pgdb.select().from(schema.events).where(eq(schema.events.instanceId, instanceId));
    const rows = await listMemoryByInstance(instanceId, pgdb);
    assert.equal(events.length, 0);
    assert.equal(rows.length, 0, "the fact rolled back with the event");
  });

  // ── concurrent double-insert → partial-unique live index → one live row ──────
  await test("concurrent double-insert of the same live key → partial-unique → one row (§4.6)", async () => {
    const instanceId = await seedInstance(pgdb);
    // Two raw inserts of the same (instance, key, normalizedValue) live row — the
    // second must hit the partial-unique live index.
    await pgdb.insert(schema.campaignCreatorMemory).values({
      instanceId,
      key: "AVAILABILITY",
      status: "ACTIVE",
      value: "gone until Aug",
      normalizedValue: "__singleton__AVAILABILITY",
      confidence: 1,
    });
    await assert.rejects(
      () =>
        pgdb.insert(schema.campaignCreatorMemory).values({
          instanceId,
          key: "AVAILABILITY",
          status: "ACTIVE",
          value: "gone until Sep",
          normalizedValue: "__singleton__AVAILABILITY",
          confidence: 1,
        }),
      (err) => isUniqueViolation(err),
      "a second live row under the same singleton key must be rejected",
    );
  });

  // ── operator correct: EDIT / RESOLVE_CONFLICT / REMOVE (§4.10) ────────────────
  await test("operator EDIT sets a new value + source=operator + retains prior", async () => {
    const instanceId = await seedInstance(pgdb);
    const inserted = await upsertMemoryFact(objectionWrite(instanceId, "no exclusivity"), pgdb);
    const edited = await correctMemoryFact(
      inserted.fact.id,
      { action: "EDIT", value: "exclusivity is fine", normalizedValue: "exclusivity is fine" },
      pgdb,
    );
    assert.ok(edited);
    assert.equal(edited!.value, "exclusivity is fine");
    assert.equal(edited!.source, "operator");
    assert.equal(edited!.confidence, 1);
    assert.equal(edited!.priorValue, "no exclusivity", "old value kept as prior");
    assert.equal(edited!.status, "ACTIVE");
  });

  await test("operator RESOLVE_CONFLICT picks the authoritative value → ACTIVE", async () => {
    const instanceId = await seedInstance(pgdb);
    await upsertMemoryFact(rateWrite(instanceId, "400", 400), pgdb);
    const conflicted = await upsertMemoryFact(rateWrite(instanceId, "600", 600), pgdb);
    assert.equal(conflicted.fact.status, "CONFLICTED");
    // Operator keeps the prior ($400) as authoritative.
    const resolved = await correctMemoryFact(
      conflicted.fact.id,
      { action: "RESOLVE_CONFLICT", value: "400" },
      pgdb,
    );
    assert.ok(resolved);
    assert.equal(resolved!.status, "ACTIVE");
    assert.equal(resolved!.value, "400");
    assert.equal(resolved!.source, "operator");
  });

  await test("operator REMOVE drops the fact from the live read (kept for audit)", async () => {
    const instanceId = await seedInstance(pgdb);
    const inserted = await upsertMemoryFact(objectionWrite(instanceId, "no static posts"), pgdb);
    const removed = await correctMemoryFact(inserted.fact.id, { action: "REMOVE" }, pgdb);
    assert.equal(removed!.status, "REMOVED");
    const live = await listLiveMemoryByInstance(instanceId, pgdb);
    assert.equal(live.length, 0, "REMOVED drops out of the live read");
    const all = await listMemoryByInstance(instanceId, pgdb);
    assert.equal(all.length, 1, "but is kept for audit");
  });

  await test("correctMemoryFact is idempotent on REMOVE (re-remove no-ops)", async () => {
    const instanceId = await seedInstance(pgdb);
    const inserted = await upsertMemoryFact(objectionWrite(instanceId, "no giveaways"), pgdb);
    await correctMemoryFact(inserted.fact.id, { action: "REMOVE" }, pgdb);
    const again = await correctMemoryFact(inserted.fact.id, { action: "REMOVE" }, pgdb);
    assert.equal(again!.status, "REMOVED");
  });

  console.log(`\ncampaignCreatorMemory.db: ${n} passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
