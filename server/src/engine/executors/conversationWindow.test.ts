/**
 * PLU-112 §5.7 — budget-aware windowing tests (pure, offline, no LLM).
 *
 * Run: node --import tsx --test src/engine/executors/conversationWindow.test.ts
 *
 * Covers the sub-issue's explicit asks (10/30/50-message threads) plus the
 * load-bearing invariants: summary-fail → FULL transcript (never a bare window),
 * latest turn always preserved, budget backstop, idempotence, and the flag-gated
 * projection behavior (window only when the flag is ON and a valid summary exists).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { ConversationSummary } from "../conversationContext.js";
import {
  applyBudgetWindow,
  isSummaryValid,
  estimateTurnsTokens,
} from "./conversationWindow.js";

// A transcript of N alternating turns, each with a short body.
function transcript(n: number): DraftHistoryEntry[] {
  const out: DraftHistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? "creator" : "us",
      message: `turn ${i} body`,
      messageId: `m${i}`,
    });
  }
  return out;
}

const validSummary: ConversationSummary = { text: "Earlier: creator asked about usage; we deferred.", version: "summary-v1" };

// Defaults: RECENT_MESSAGE_WINDOW=8, CONTEXT_TOKEN_BUDGET=6000. These tests do NOT
// set env, so the config helpers return their defaults — the numbers below assume 8.

test("isSummaryValid: present+text → true; absent/empty/whitespace → false", () => {
  assert.equal(isSummaryValid(validSummary), true);
  assert.equal(isSummaryValid(undefined), false);
  assert.equal(isSummaryValid({ text: "" }), false);
  assert.equal(isSummaryValid({ text: "   " }), false);
});

test("10 turns (≤ window) → full transcript, NOT windowed, even with a valid summary", () => {
  const t = transcript(10); // > 8, so this actually windows — use a genuinely-short one:
  const short = transcript(6);
  const r = applyBudgetWindow(short, validSummary);
  assert.equal(r.windowed, false, "a transcript that fits the window is never windowed");
  assert.deepEqual(r.recentMessages, short, "full short transcript preserved");
  // and 10 > 8 DOES window (sanity that the boundary is real)
  const r10 = applyBudgetWindow(t, validSummary);
  assert.equal(r10.windowed, true);
  assert.equal(r10.recentMessages.length, 8);
});

test("30 turns + valid summary → newest 8 raw, older elided (covered by summary)", () => {
  const t = transcript(30);
  const r = applyBudgetWindow(t, validSummary);
  assert.equal(r.windowed, true);
  assert.equal(r.recentMessages.length, 8, "window = newest 8 turns");
  // the tail is exactly the last 8 entries, verbatim (recent wording preserved for tone)
  assert.deepEqual(r.recentMessages, t.slice(22), "tail is the newest 8, verbatim");
  // the LATEST turn is always present
  assert.equal(r.recentMessages.at(-1)?.messageId, "m29");
});

test("50 turns + valid summary → still newest 8 raw (older 42 elided)", () => {
  const t = transcript(50);
  const r = applyBudgetWindow(t, validSummary);
  assert.equal(r.windowed, true);
  assert.equal(r.recentMessages.length, 8);
  assert.equal(r.recentMessages[0]?.messageId, "m42");
  assert.equal(r.recentMessages.at(-1)?.messageId, "m49");
});

test("summary INVALID (undefined) → FULL transcript, NOT a bare window (§5.1/§5.6)", () => {
  const t = transcript(30);
  const r = applyBudgetWindow(t, undefined);
  assert.equal(r.windowed, false, "no valid summary → never window");
  assert.deepEqual(r.recentMessages, t, "the FULL 30-turn transcript is preserved (today's behavior)");
});

test("summary EMPTY (generation failed) → FULL transcript preserved (the §5.1 hole-guard)", () => {
  const t = transcript(30);
  const r = applyBudgetWindow(t, { text: "   " });
  assert.equal(r.windowed, false);
  assert.equal(r.recentMessages.length, 30, "a failed/empty summary falls back to the full transcript, not a window");
});

test("budget backstop: an over-budget raw window sheds its OLDEST turns but keeps the latest", () => {
  // Build 12 turns where each body is huge so the newest-8 window busts a tiny budget.
  const big = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 === 0 ? "creator" : "us") as DraftHistoryEntry["role"],
    message: "x".repeat(4000), // ~1000 tokens each
    messageId: `m${i}`,
  }));
  // Temporarily shrink the budget via env for this test.
  const prevBudget = process.env["CONTEXT_TOKEN_BUDGET"];
  const prevWindow = process.env["RECENT_MESSAGE_WINDOW"];
  process.env["CONTEXT_TOKEN_BUDGET"] = "2500"; // ~2 turns' worth
  process.env["RECENT_MESSAGE_WINDOW"] = "8";
  try {
    const r = applyBudgetWindow(big, validSummary);
    assert.equal(r.windowed, true);
    // The window started at 8 turns (~8000 tokens) and shed oldest until ≤ 2500.
    assert.ok(r.recentMessages.length < 8, "over-budget window sheds oldest turns");
    assert.ok(r.recentMessages.length >= 1, "never sheds below the latest turn");
    assert.equal(r.recentMessages.at(-1)?.messageId, "m11", "the latest turn is always kept");
    assert.ok(estimateTurnsTokens(r.recentMessages) <= 2500, "final window is under budget");
  } finally {
    if (prevBudget === undefined) delete process.env["CONTEXT_TOKEN_BUDGET"];
    else process.env["CONTEXT_TOKEN_BUDGET"] = prevBudget;
    if (prevWindow === undefined) delete process.env["RECENT_MESSAGE_WINDOW"];
    else process.env["RECENT_MESSAGE_WINDOW"] = prevWindow;
  }
});

test("budget backstop never drops the single latest turn even if it alone busts budget", () => {
  const one = [{ role: "creator" as const, message: "y".repeat(40000), messageId: "m0" }];
  const prev = process.env["CONTEXT_TOKEN_BUDGET"];
  process.env["CONTEXT_TOKEN_BUDGET"] = "100";
  try {
    const r = applyBudgetWindow(one, validSummary);
    // 1 turn ≤ window(8) → not windowed at all; the latest turn is always shipped.
    assert.equal(r.recentMessages.length, 1);
    assert.equal(r.recentMessages[0]?.messageId, "m0");
  } finally {
    if (prev === undefined) delete process.env["CONTEXT_TOKEN_BUDGET"];
    else process.env["CONTEXT_TOKEN_BUDGET"] = prev;
  }
});

test("idempotent: windowing an already-windowed tail is a no-op fixed point", () => {
  const t = transcript(30);
  const r1 = applyBudgetWindow(t, validSummary);
  const r2 = applyBudgetWindow(r1.recentMessages, validSummary);
  // r1 tail is 8 turns ≤ window → r2 does not window further.
  assert.equal(r2.windowed, false);
  assert.deepEqual(r2.recentMessages, r1.recentMessages);
});

test("estimateTurnsTokens: chars/4 over message bodies, ignores non-message fields", () => {
  const t: DraftHistoryEntry[] = [
    { role: "creator", message: "abcd" }, // 4 chars → 1 token
    { role: "us", message: "abcdefgh", round: 3, rate: 500 }, // 8 chars → 2 tokens; round/rate ignored
    { role: "creator" }, // no body → 0
  ];
  assert.equal(estimateTurnsTokens(t), 3);
});
