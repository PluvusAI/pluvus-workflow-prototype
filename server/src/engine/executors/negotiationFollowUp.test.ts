/**
 * PLU-110 — pure negotiation-follow-up config helpers + the interval-index
 * convention that guards the off-by-one / infinite-loop hazard (PLAN §2b).
 *
 * Run:  node --import tsx --test src/engine/executors/negotiationFollowUp.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  negotiationFollowUpEnabled,
  negotiationFollowUpMaxCount,
  resolveNegotiationFollowUpIntervalMs,
} from "./negotiation.js";

const DAY = 24 * 60 * 60 * 1_000;

test("enabled only when the flag is literally true", () => {
  assert.equal(negotiationFollowUpEnabled({ negotiationFollowUpEnabled: true }), true);
  assert.equal(negotiationFollowUpEnabled({ negotiationFollowUpEnabled: false }), false);
  assert.equal(negotiationFollowUpEnabled({}), false, "missing ⇒ off (legacy nodes)");
  assert.equal(
    negotiationFollowUpEnabled({ negotiationFollowUpEnabled: "true" }),
    false,
    "a string is not the boolean true",
  );
});

test("max count defaults to 2, honors a number", () => {
  assert.equal(negotiationFollowUpMaxCount({}), 2);
  assert.equal(negotiationFollowUpMaxCount({ negotiationFollowUpMaxCount: 5 }), 5);
});

test("interval index resolves days by default and clamps past the last", () => {
  const cfg = { negotiationFollowUpIntervals: [2, 4] };
  assert.equal(resolveNegotiationFollowUpIntervalMs(cfg, 0), 2 * DAY);
  assert.equal(resolveNegotiationFollowUpIntervalMs(cfg, 1), 4 * DAY);
  assert.equal(resolveNegotiationFollowUpIntervalMs(cfg, 2), 4 * DAY, "index past end clamps to last");
  assert.equal(resolveNegotiationFollowUpIntervalMs(cfg, 9), 4 * DAY);
});

test("interval unit multipliers", () => {
  assert.equal(resolveNegotiationFollowUpIntervalMs({ negotiationFollowUpIntervals: [3], negotiationFollowUpIntervalUnit: "seconds" }, 0), 3 * 1_000);
  assert.equal(resolveNegotiationFollowUpIntervalMs({ negotiationFollowUpIntervals: [3], negotiationFollowUpIntervalUnit: "minutes" }, 0), 3 * 60_000);
  assert.equal(resolveNegotiationFollowUpIntervalMs({ negotiationFollowUpIntervals: [3], negotiationFollowUpIntervalUnit: "hours" }, 0), 3 * 60 * 60_000);
  assert.equal(resolveNegotiationFollowUpIntervalMs({ negotiationFollowUpIntervals: [3], negotiationFollowUpIntervalUnit: "days" }, 0), 3 * DAY);
});

test("missing intervals fall back to [2,4] days", () => {
  assert.equal(resolveNegotiationFollowUpIntervalMs({}, 0), 2 * DAY);
  assert.equal(resolveNegotiationFollowUpIntervalMs({}, 1), 4 * DAY);
});

// PLAN §2b: the counter/interval convention, modeled as a pure state walk over
// intervals [2,4] / max 2. Proves attempts terminate at NO_RESPONSE with no
// off-by-one and no infinite loop.
test("interval-index sequence: [2,4]/max 2 → arm, attempt, arm, attempt, exhaust", () => {
  const cfg = { negotiationFollowUpEnabled: true, negotiationFollowUpIntervals: [2, 4], negotiationFollowUpMaxCount: 2 };
  const max = negotiationFollowUpMaxCount(cfg);

  // present/counter send committed count=0; flush arms index 0.
  let count = 0;
  assert.equal(resolveNegotiationFollowUpIntervalMs(cfg, count), 2 * DAY, "first arm = 2d");

  // poller → attempt 0: pre-increment count(0) < max(2) → send, commit count=1.
  assert.ok(count < max);
  const attempt0 = count;
  count = attempt0 + 1;
  assert.equal(count, 1);
  // flush arms index = post-increment count (1) = 4d.
  assert.equal(resolveNegotiationFollowUpIntervalMs(cfg, count), 4 * DAY, "second arm = 4d");

  // poller → attempt 1: count(1) < max(2) → send, commit count=2.
  assert.ok(count < max);
  const attempt1 = count;
  count = attempt1 + 1;
  assert.equal(count, 2);

  // poller → count(2) >= max(2) → NO_RESPONSE (exhausted).
  assert.ok(count >= max, "exhausted → NO_RESPONSE, loop terminates");
});
