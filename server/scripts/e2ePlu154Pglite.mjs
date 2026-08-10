// PLU-154 END-TO-END on a throwaway pglite DB with ALL migrations applied
// (including the PLU-135 snapshot epic + PLU-153 + PLU-154). Zero writes to any
// shared DB. Drives the full lifecycle through the SAME functions the HTTP routes
// and the poller call:
//   seed a MANUAL_REVIEW case → approve/reject/opt-out (resolveManualReviewCase +
//   band validation) → timeout sweep (sweepManualReviewTimeouts) → queue read.
//
// Run: node --import tsx scripts/e2ePlu154Pglite.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../prisma/migrations");

// ── migration runner (same splitter the DB tests use) ──────────────────────
function splitSqlStatements(sql) {
  const out = []; let cur = "", quote = null, dollar = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (dollar) { if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length - 1; dollar = null; } else cur += ch; continue; }
    if (quote) { cur += ch; if (ch === quote) { if (sql[i + 1] === quote) { cur += quote; i++; } else quote = null; } continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "$") { const tag = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0]; if (tag) { dollar = tag; cur += tag; i += tag.length - 1; continue; } }
    if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
async function applyMigrations(pg) {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const f of folders) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f, "migration.sql"), "utf8")
      .split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const s of splitSqlStatements(sql)) await pg.exec(s);
  }
}

const pg = new PGlite();
await applyMigrations(pg);
const schema = await import("../src/db/schema.js");
const db = drizzle(pg, { schema });

// Point the app's db singleton at this pglite so route-core + sweep use it.
const drizzleMod = await import("../src/db/drizzle.js");
// The modules import { db } by value; we instead pass our db explicitly to the
// functions that accept an injectable client (resolveManualReviewCase, list*).
const {
  resolveManualReviewCase, assertFeeWithinBand, findNegotiationPolicySnapshotById,
  listExpiredManualReviewCases, listManualReviewCasesForNudge, countNudges,
  BandViolationError, ManualReviewRaceError,
} = await import("../src/db/manualReview.js");
const { sweepManualReviewTimeouts } = await import("../src/scheduler/manualReviewSweep.js");

let seq = 0;
async function seedCase({ mode = "operator_handoff", dueAt = null, band = null }) {
  seq++;
  const [c] = await db.insert(schema.campaigns).values({ name: `E2E ${seq}`, brand: "Pluvus", status: "ACTIVE" }).returning();
  const [wf] = await db.insert(schema.workflows).values({ name: "WF", campaignId: c.id }).returning();
  const [v] = await db.insert(schema.workflowVersions).values({ workflowId: wf.id, version: 1, nodeGraph: [] }).returning();
  const [cr] = await db.insert(schema.creators).values({ name: `Creator ${seq}`, email: `c${seq}@e2e.local` }).returning();
  let snapId = null;
  if (band) {
    const [s] = await db.insert(schema.negotiationPolicySnapshots).values({ campaignId: c.id, floorCents: band.floor, ceilingCents: band.ceil }).returning();
    snapId = s.id;
  }
  const [inst] = await db.insert(schema.executionInstances).values({
    workflowVersionId: v.id, creatorId: cr.id, currentState: "MANUAL_REVIEW", currentNodeId: "negotiation",
    postAcceptanceMode: mode, dueAt, negotiationPolicySnapshotId: snapId,
  }).returning();
  await db.insert(schema.events).values({ instanceId: inst.id, type: "MANUAL_REVIEW_FLAGGED", payload: { reason: "max_rounds_reached" } });
  return { inst, cr, snapId, workflowId: wf.id, versionId: v.id };
}
async function stateOf(id) { const [r] = await db.select().from(schema.executionInstances).where(eq(schema.executionInstances.id, id)); return r; }
async function evTypes(id) { const rs = await db.select().from(schema.events).where(eq(schema.events.instanceId, id)); return rs.map((e) => e.type); }

console.log("=== PLU-154 E2E (pglite, ALL migrations incl. PLU-135) ===\n");

// [1] APPROVE (mirrors the approve route core: band check → resolve → DealHandoff)
{
  const { inst, cr } = await seedCase({ band: { floor: 20000, ceil: 60000 } });
  const snap = inst.negotiationPolicySnapshotId ? await findNegotiationPolicySnapshotById(inst.negotiationPolicySnapshotId, db) : null;
  assertFeeWithinBand({ fixedFee: 500 }, snap); // in band → no throw
  const r = await resolveManualReviewCase(inst.id, {
    to: "NEEDS_DEAL_FINALIZATION", resolvedBy: "op", reason: "approve",
    terms: { fixedFee: 500, commissionRate: 0.1 }, creator: { name: cr.name, email: cr.email }, campaignName: "E2E",
  }, db);
  assert.equal(r.currentState, "NEEDS_DEAL_FINALIZATION");
  const [h] = await db.select().from(schema.dealHandoffs).where(eq(schema.dealHandoffs.instanceId, inst.id));
  assert.ok(h && Number(h.fixedFee) === 500, "DealHandoff $500");
  assert.ok((await evTypes(inst.id)).includes("MANUAL_REVIEW_RESOLVED"));
  // idempotency: second resolve loses the OCC race
  await assert.rejects(() => resolveManualReviewCase(inst.id, { to: "NEEDS_DEAL_FINALIZATION", resolvedBy: "op", reason: "x", creator: { name: cr.name, email: cr.email } }, db), ManualReviewRaceError);
  console.log("[1] APPROVE ✓ → NEEDS_DEAL_FINALIZATION + DealHandoff($500) + idempotent");
}

// [2] BAND violation → 422 equivalent (BandViolationError), unless approvedDeviation
{
  const { inst } = await seedCase({ band: { floor: 20000, ceil: 50000 } });
  const snap = await findNegotiationPolicySnapshotById(inst.negotiationPolicySnapshotId, db);
  assert.throws(() => assertFeeWithinBand({ fixedFee: 600 }, snap), BandViolationError);
  assert.doesNotThrow(() => assertFeeWithinBand({ fixedFee: 600, approvedDeviation: true }, snap));
  // snapshot immutable after resolve
  await resolveManualReviewCase(inst.id, { to: "NEEDS_DEAL_FINALIZATION", resolvedBy: "op", reason: "dev", terms: { fixedFee: 600, approvedDeviation: true }, creator: { name: "n", email: "e@e2e.local" } }, db);
  const after = await findNegotiationPolicySnapshotById(inst.negotiationPolicySnapshotId, db);
  assert.equal(after.floorCents, 20000); assert.equal(after.ceilingCents, 50000);
  console.log("[2] BAND ✓ → $600 rejected, approvedDeviation allowed, snapshot immutable");
}

// [3] REJECT + OPT-OUT
{
  const { inst: ri } = await seedCase({});
  await resolveManualReviewCase(ri.id, { to: "REJECTED", resolvedBy: "op", reason: "not a fit" }, db);
  assert.equal((await stateOf(ri.id)).currentState, "REJECTED");
  assert.ok((await evTypes(ri.id)).includes("MANUAL_REVIEW_FLAGGED"), "history preserved");
  const { inst: oi } = await seedCase({});
  await resolveManualReviewCase(oi.id, { to: "OPTED_OUT", resolvedBy: "op", reason: "creator_withdrew" }, db);
  assert.equal((await stateOf(oi.id)).currentState, "OPTED_OUT");
  console.log("[3] REJECT/OPT-OUT ✓ → REJECTED + OPTED_OUT, history preserved");
}

// [4] CONCURRENT approve vs reject → exactly one wins
{
  const { inst, cr } = await seedCase({});
  const results = await Promise.allSettled([
    resolveManualReviewCase(inst.id, { to: "NEEDS_DEAL_FINALIZATION", resolvedBy: "a", reason: "ap", creator: { name: cr.name, email: cr.email } }, db),
    resolveManualReviewCase(inst.id, { to: "REJECTED", resolvedBy: "b", reason: "rj" }, db),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  console.log("[4] CONCURRENCY ✓ → exactly one resolution won (OCC)");
}

// [5] TIMEOUT sweep → EXPIRED (real sweep fn, injected pglite deps)
{
  const now = new Date("2026-08-09T00:00:00.000Z");
  const { inst: past } = await seedCase({ dueAt: new Date(now.getTime() - 1000) });
  const { inst: future } = await seedCase({ dueAt: new Date(now.getTime() + 86400000) });
  const { appendEvent } = await import("../src/db/events.js");
  const deps = {
    listExpiredManualReviewCases: (a) => listExpiredManualReviewCases(a, db),
    listManualReviewCasesForNudge: () => Promise.resolve([]),
    countNudges: (id) => countNudges(id, db),
    resolveManualReviewCase: (id, input) => resolveManualReviewCase(id, input, db),
    notifyBrandOfEscalation: async () => ({}),
    appendEvent: (data) => db.insert(schema.events).values(data).returning().then((r) => r[0]),
    email: () => ({}),
    now: () => now,
  };
  const res = await sweepManualReviewTimeouts(deps);
  assert.equal(res.expired, 1);
  assert.equal((await stateOf(past.id)).currentState, "EXPIRED");
  assert.notEqual((await stateOf(past.id)).currentState, "NO_RESPONSE");
  assert.equal((await stateOf(future.id)).currentState, "MANUAL_REVIEW");
  assert.ok((await evTypes(past.id)).includes("MANUAL_REVIEW_EXPIRED"));
  // human-wins determinism
  await resolveManualReviewCase(future.id, { to: "REJECTED", resolvedBy: "human", reason: "rj" }, db);
  const res2 = await sweepManualReviewTimeouts({ ...deps, now: () => new Date(now.getTime() + 2 * 86400000) });
  assert.equal(res2.expired, 0);
  console.log("[5] TIMEOUT ✓ → past→EXPIRED (not NO_RESPONSE), future untouched, human wins the race");
}

// [6] ARCHIVAL: EXPIRED counts as closed; MANUAL_REVIEW still blocks
{
  const { getCampaignLifecycleCounts } = await import("../src/db/campaigns.js");
  const { inst } = await seedCase({ dueAt: new Date(Date.now() - 1000) });
  const [wfRow] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, (await db.select().from(schema.workflowVersions).where(eq(schema.workflowVersions.id, inst.workflowVersionId)))[0].workflowId));
  const campaignId = wfRow.campaignId;
  let counts = await getCampaignLifecycleCounts(campaignId, db);
  assert.equal(counts.manualReviewCount, 1, "MR case blocks (counts as MR)");
  assert.equal(counts.inProgressCreatorCount, 1, "MR case is in-progress");
  await resolveManualReviewCase(inst.id, { to: "EXPIRED", resolvedBy: "system", reason: "timeout", source: "system" }, db);
  counts = await getCampaignLifecycleCounts(campaignId, db);
  assert.equal(counts.inProgressCreatorCount, 0, "EXPIRED no longer in-progress (unblocks archival)");
  console.log("[6] ARCHIVAL ✓ → MANUAL_REVIEW blocks, EXPIRED unblocks (in CLOSED_INSTANCE_STATES)");
}

console.log("\n✅ ALL PLU-154 E2E STEPS PASSED (pglite, full migration chain)");
await pg.close();
process.exit(0);
