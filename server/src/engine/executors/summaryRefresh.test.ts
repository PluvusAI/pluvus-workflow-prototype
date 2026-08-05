/**
 * PLU-112 — pure refresh-planner tests. planSummaryRefresh is where the
 * idempotency, incremental-delta, and send-delay-barrier logic lives; the DB-level
 * CAS/concurrency is covered by conversationSummary.db.test.ts.
 *
 *   npx tsx src/engine/executors/summaryRefresh.test.ts
 */

import assert from "node:assert/strict";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { ConversationSummary } from "../conversationContext/types.js";
import type { DatedEntry } from "./negotiationHistory.js";
import { planSummaryRefresh } from "./summaryRefresh.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function transcript(count: number): DatedEntry[] {
  const out: DatedEntry[] = [];
  for (let i = 1; i <= count; i++) {
    const entry: DraftHistoryEntry = { role: "creator", message: `turn ${i}`, messageId: `m${i}` };
    out.push({ at: i * 1000, entry });
  }
  return out;
}

function summaryThrough(turn: number): ConversationSummary {
  return { text: `through ${turn}`, version: "summary-v1.0", summarizedThroughSentAt: new Date(turn * 1000) };
}

const WINDOW = 8;

// --- Idempotency: nothing new past the cursor → no-op (no summarizer call) ------
test("idempotent: cursor already covers the whole pre-window prefix → null plan", () => {
  const dated = transcript(30);
  // prefix = turns 1..22 (30 - window 8). Cursor at 22 covers all of it.
  const plan = planSummaryRefresh(dated, summaryThrough(22), WINDOW);
  assert.equal(plan, null);
});

test("idempotent: transcript at/under the window → null plan", () => {
  const plan = planSummaryRefresh(transcript(8), undefined, WINDOW);
  assert.equal(plan, null);
});

// --- Incremental: delta is ONLY the newly-uncovered pre-window turns ------------
test("incremental: delta is only turns after the cursor and before the window", () => {
  const dated = transcript(30); // prefix = 1..22
  const plan = planSummaryRefresh(dated, summaryThrough(20), WINDOW);
  assert.ok(plan);
  // Newly summarizable = turns 21, 22 only (not 1..20, not the window 23..30).
  assert.deepEqual(plan!.delta.map((d) => d.entry.messageId), ["m21", "m22"]);
  assert.equal(plan!.priorSummary, "through 20");
});

test("first fold: no prior summary → delta is the whole pre-window prefix", () => {
  const dated = transcript(12); // prefix = 1..4
  const plan = planSummaryRefresh(dated, undefined, WINDOW);
  assert.ok(plan);
  assert.deepEqual(plan!.delta.map((d) => d.entry.messageId), ["m1", "m2", "m3", "m4"]);
  assert.equal(plan!.priorSummary, "");
  assert.equal(plan!.expectedThroughSentAt, null);
});

// --- Cursor advances to the last folded turn (monotonic) -----------------------
test("new cursor = the last delta turn's sentAt + messageId", () => {
  const dated = transcript(30);
  const plan = planSummaryRefresh(dated, summaryThrough(20), WINDOW);
  assert.ok(plan);
  assert.equal(plan!.newThroughSentAt.getTime(), 22_000);
  assert.equal(plan!.newThroughMessageId, "m22");
  assert.equal(plan!.expectedThroughSentAt!.getTime(), 20_000);
});

// --- Send-delay barrier (§5.4.1): a reserved outbound is absent from the dated
//     transcript (buildDatedDraftHistory drops sentAt===null), so the cursor can
//     never advance past it — the plan only ever folds finalized turns. ----------
test("barrier: only finalized turns are in the input, so none can be summarized-past", () => {
  // Simulate the drop: turn 21 was reserved (never in the dated array).
  const dated = transcript(30).filter((d) => d.entry.messageId !== "m21");
  const plan = planSummaryRefresh(dated, summaryThrough(20), WINDOW);
  assert.ok(plan);
  // Only the finalized turn 22 folds; the reserved 21 is simply not present.
  assert.ok(!plan!.delta.some((d) => d.entry.messageId === "m21"));
});

// --- Identical-timestamp tie-break (founder review) ----------------------------
// The delta filter must use the SAME compound cursor as windowing. If the cursor
// covered only ONE of two same-sentAt turns, the OTHER must still land in the delta
// (be folded) — otherwise it is dropped from the raw tail AND skipped here = lost.
test("same-sentAt: the twin the cursor did NOT cover is still folded into the delta", () => {
  // 12 turns, window 8 → prefix = turns 1..4. Make turns 3 & 4 share sentAt 4000,
  // and set the cursor to cover m3 only (same at, smaller messageId).
  const dated = transcript(12).map((d) =>
    d.entry.messageId === "m3" || d.entry.messageId === "m4" ? { ...d, at: 4000 } : d,
  );
  const summary: ConversationSummary = {
    text: "through m3",
    version: "summary-v1.0",
    summarizedThroughSentAt: new Date(4000),
    summarizedThroughMessageId: "m3",
  };
  const plan = planSummaryRefresh(dated, summary, WINDOW);
  assert.ok(plan, "there is still an uncovered twin to fold");
  // m3 is covered; m4 (same sentAt, not folded) MUST be in the delta.
  assert.deepEqual(plan!.delta.map((d) => d.entry.messageId), ["m4"]);
  assert.equal(plan!.newThroughSentAt.getTime(), 4000);
  assert.equal(plan!.newThroughMessageId, "m4");
  // founder review #2: the COMPOUND expected cursor is threaded to the CAS — both
  // the sentAt AND the messageId half of the loaded row, so a stale worker sharing
  // only the timestamp cannot clobber this advance.
  assert.equal(plan!.expectedThroughSentAt!.getTime(), 4000);
  assert.equal(plan!.expectedThroughMessageId, "m3");
});

test("compound expected cursor: prior messageId is carried into the plan for the CAS", () => {
  // A plain (non-twin) prior cursor at turn 20 with a messageId → the plan must
  // expose BOTH halves so upsertConversationSummary can guard on the compound key.
  const dated = transcript(30);
  const summary: ConversationSummary = {
    text: "through 20",
    version: "summary-v1.0",
    summarizedThroughSentAt: new Date(20_000),
    summarizedThroughMessageId: "m20",
  };
  const plan = planSummaryRefresh(dated, summary, WINDOW);
  assert.ok(plan);
  assert.equal(plan!.expectedThroughSentAt!.getTime(), 20_000);
  assert.equal(plan!.expectedThroughMessageId, "m20");
});

test("no prior messageId (legacy cursor) → expectedThroughMessageId is undefined", () => {
  // A prior cursor with a sentAt but no messageId (legacy/eventless boundary): the
  // plan leaves expectedThroughMessageId undefined, which the CAS maps to IS NULL.
  const dated = transcript(30);
  const plan = planSummaryRefresh(dated, summaryThrough(20), WINDOW);
  assert.ok(plan);
  assert.equal(plan!.expectedThroughSentAt!.getTime(), 20_000);
  assert.equal(plan!.expectedThroughMessageId, undefined);
});

test("same-sentAt: a cursor already covering the LARGER twin id → no-op", () => {
  // Cursor covers m4 (the larger id at 4000). m3 shares the timestamp but sorts
  // BEFORE the cursor, so it is covered too — nothing left in the prefix to fold.
  const dated = transcript(12).map((d) =>
    d.entry.messageId === "m3" || d.entry.messageId === "m4" ? { ...d, at: 4000 } : d,
  );
  const summary: ConversationSummary = {
    text: "through m4",
    version: "summary-v1.0",
    summarizedThroughSentAt: new Date(4000),
    summarizedThroughMessageId: "m4",
  };
  const plan = planSummaryRefresh(dated, summary, WINDOW);
  assert.equal(plan, null);
});

console.log(`\n${n} passed\n`);
