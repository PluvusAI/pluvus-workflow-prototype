/**
 * PLU-112 — pure windowing unit tests. Covers the 10/30/50-message cases the
 * sub-issue asks for, plus every coverage invariant from Calvin's review.
 *
 *   npx tsx src/engine/executors/conversationWindow.test.ts
 */

import assert from "node:assert/strict";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { ConversationSummary } from "../conversationContext/types.js";
import type { DatedEntry } from "./negotiationHistory.js";
import { windowDraftHistory } from "./conversationWindow.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A chronological transcript of `count` short turns; `at` = 1000, 2000, … so a
// cursor at turn K is `K * 1000`. Alternating creator/us roles, unique messageIds.
function transcript(count: number): DatedEntry[] {
  const out: DatedEntry[] = [];
  for (let i = 1; i <= count; i++) {
    const entry: DraftHistoryEntry = {
      role: i % 2 === 0 ? "us" : "creator",
      message: `turn ${i} body`,
      messageId: `m${i}`,
    };
    out.push({ at: i * 1000, entry });
  }
  return out;
}

function summaryThrough(turn: number): ConversationSummary {
  return { text: `narrative through turn ${turn}`, version: "summary-v1.0", summarizedThroughSentAt: new Date(turn * 1000) };
}

const BIG_BUDGET = 1_000_000;
const OPTS = { window: 8, tokenBudget: BIG_BUDGET };

// --- 10 messages: under window, no summary → full transcript unchanged ---------
test("10 msgs, no summary → full transcript, unchanged", () => {
  const dated = transcript(10);
  const r = windowDraftHistory(dated, undefined, OPTS);
  assert.equal(r.summary, undefined);
  assert.deepEqual(r.history, dated.map((d) => d.entry));
});

// --- 30 messages: cursor at turn 22 → tail 23-30 raw + summary present ---------
test("30 msgs, cursor at turn 22 → recent tail raw + summary present", () => {
  const dated = transcript(30);
  const r = windowDraftHistory(dated, summaryThrough(22), OPTS);
  assert.ok(r.summary, "summary travels with the shortened history");
  assert.ok(r.history.length < 30, "history is shortened");
  // Recent wording is verbatim: the last entry is turn 30 unchanged.
  assert.equal(r.history[r.history.length - 1]!.message, "turn 30 body");
  // Every dropped entry is at/before the cursor (covered by the summary).
  const kept = new Set(r.history.map((e) => e.messageId));
  for (const d of dated) {
    if (!kept.has(d.entry.messageId)) assert.ok(d.at <= 22_000, `dropped ${d.entry.messageId} must be covered`);
  }
});

// --- 50 messages: windowed; drop set ⊆ covered ---------------------------------
test("50 msgs, cursor at turn 40 → drop set ⊆ covered", () => {
  const dated = transcript(50);
  const r = windowDraftHistory(dated, summaryThrough(40), OPTS);
  const kept = new Set(r.history.map((e) => e.messageId));
  for (const d of dated) {
    if (!kept.has(d.entry.messageId)) assert.ok(d.at <= 40_000, "only covered entries dropped");
  }
});

// --- Cursor-gap (Calvin): cursor at 22, tail 23-31 all stay raw ----------------
test("cursor-gap: entries after the cursor all stay raw (nothing in neither place)", () => {
  const dated = transcript(31);
  const summary = summaryThrough(22); // NOT 30 — the current turn reads the OLD cursor.
  const r = windowDraftHistory(dated, summary, OPTS);
  const kept = new Set(r.history.map((e) => e.messageId));
  // Turn 23 (just past the cursor) must still be present raw.
  assert.ok(kept.has("m23"), "turn 23 (uncovered) must stay raw");
  for (let i = 23; i <= 31; i++) assert.ok(kept.has(`m${i}`), `turn ${i} (at>cursor) must stay raw`);
});

// --- Refresh failure (Calvin): stale summary, every entry after cursor stays raw
test("refresh failure: entries after the old cursor remain raw", () => {
  const dated = transcript(30);
  // Refresh "failed" so the summary is unchanged at turn 22 while 8 newer turns exist.
  const r = windowDraftHistory(dated, summaryThrough(22), OPTS);
  const kept = new Set(r.history.map((e) => e.messageId));
  for (let i = 23; i <= 30; i++) assert.ok(kept.has(`m${i}`), `turn ${i} must remain raw`);
});

// --- Budget pressure (Calvin): never drop an uncovered entry -------------------
test("budget pressure never drops an entry after the cursor", () => {
  const dated = transcript(30);
  // A tiny budget forces shedding, but the tail (turns 23-30) is uncovered.
  const r = windowDraftHistory(dated, summaryThrough(22), { window: 8, tokenBudget: 1 });
  const kept = new Set(r.history.map((e) => e.messageId));
  for (let i = 23; i <= 30; i++) assert.ok(kept.has(`m${i}`), `uncovered turn ${i} survives budget shedding`);
  // The latest entry is never dropped.
  assert.equal(r.history[r.history.length - 1]!.messageId, "m30");
});

// --- Full-coverage invariant (Calvin): every entry is raw OR at/before cursor --
test("full-coverage invariant: every source entry is raw or covered", () => {
  const dated = transcript(37);
  const r = windowDraftHistory(dated, summaryThrough(20), { window: 5, tokenBudget: 200 });
  const kept = new Set(r.history.map((e) => e.messageId));
  for (const d of dated) {
    const present = kept.has(d.entry.messageId);
    const covered = d.at <= 20_000;
    assert.ok(present || covered, `${d.entry.messageId} is in neither the raw history nor the summary`);
  }
});

// --- No valid summary → full transcript (empty text / missing cursor) ----------
test("empty summary text → full transcript", () => {
  const dated = transcript(30);
  const r = windowDraftHistory(dated, { text: "  ", version: "v", summarizedThroughSentAt: new Date(22_000) }, OPTS);
  assert.equal(r.summary, undefined);
  assert.equal(r.history.length, 30);
});

test("summary with no cursor → full transcript", () => {
  const dated = transcript(30);
  const r = windowDraftHistory(dated, { text: "narrative", version: "v" }, OPTS);
  assert.equal(r.summary, undefined);
  assert.equal(r.history.length, 30);
});

console.log(`\n${n} passed\n`);
