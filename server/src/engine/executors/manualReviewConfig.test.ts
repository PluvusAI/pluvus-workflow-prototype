/**
 * PLU-154: pure config helpers — nudge scheduling + deadline derivation.
 * Run: node --import tsx --test src/engine/executors/manualReviewConfig.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { manualReviewDueAt, nudgeDueAt } from "./manualReviewConfig.js";

const DAY = 24 * 60 * 60_000;

test("manualReviewDueAt returns null when the timeout feature is off", () => {
  delete process.env["MANUAL_REVIEW_TIMEOUT_ENABLED"];
  assert.equal(manualReviewDueAt(new Date()), null);
});

test("manualReviewDueAt stamps now + timeout when enabled", () => {
  process.env["MANUAL_REVIEW_TIMEOUT_ENABLED"] = "true";
  const now = new Date("2026-08-09T00:00:00.000Z");
  const due = manualReviewDueAt(now);
  assert.ok(due, "expected a deadline");
  // Default 7d (module-level const captured at import; env not overridden here).
  assert.equal(due!.getTime(), now.getTime() + 7 * DAY);
  delete process.env["MANUAL_REVIEW_TIMEOUT_ENABLED"];
});

test("nudgeDueAt: fires the Nth nudge once its offset has passed, in order", () => {
  const deadline = new Date("2026-08-16T00:00:00.000Z"); // 7d out from the 9th
  const offsets = [3 * DAY, 1 * DAY]; // nudge #1 at deadline-3d, #2 at deadline-1d

  // 4 days before the deadline: too early for even the first nudge.
  const early = new Date(deadline.getTime() - 4 * DAY);
  assert.equal(nudgeDueAt(early, deadline, 0, offsets), false);

  // Exactly 3 days before: first nudge (0 sent) is due; second (1 sent) is not.
  const at3d = new Date(deadline.getTime() - 3 * DAY);
  assert.equal(nudgeDueAt(at3d, deadline, 0, offsets), true);
  assert.equal(nudgeDueAt(at3d, deadline, 1, offsets), false);

  // 1 day before: second nudge is now due; a third would be out of range.
  const at1d = new Date(deadline.getTime() - 1 * DAY);
  assert.equal(nudgeDueAt(at1d, deadline, 1, offsets), true);
  assert.equal(nudgeDueAt(at1d, deadline, 2, offsets), false); // all sent
});

test("nudgeDueAt: never nudges once the deadline has passed (the sweep expires instead)", () => {
  const deadline = new Date("2026-08-16T00:00:00.000Z");
  const past = new Date(deadline.getTime() + 1);
  assert.equal(nudgeDueAt(past, deadline, 0, [3 * DAY, 1 * DAY]), false);
});
