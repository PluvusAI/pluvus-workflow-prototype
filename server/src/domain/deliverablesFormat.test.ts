/**
 * PLU-143 — unit tests for formatDeliverablesForCreator.
 * Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/deliverablesFormat.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatDeliverablesForCreator } from "./deliverablesFormat.js";
import type { Deliverable } from "./deliverables.js";

function d(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: "del_1",
    platform: "instagram",
    format: "reel",
    quantity: 1,
    ...overrides,
  };
}

console.log("\nformatDeliverablesForCreator — basic platform/format prose\n");

test("singular quantity renders singular noun", () => {
  const [line] = formatDeliverablesForCreator([d({ quantity: 1 })]);
  assert.equal(line, "1 Instagram Reel");
});

test("plural quantity renders plural noun", () => {
  const [line] = formatDeliverablesForCreator([d({ quantity: 2 })]);
  assert.equal(line, "2 Instagram Reels");
});

test("irregular plural (Story -> Stories) is correct", () => {
  const [line] = formatDeliverablesForCreator([d({ quantity: 3, format: "story" })]);
  assert.equal(line, "3 Instagram Stories");
});

test("every real platform/format combination renders a sensible label", () => {
  const cases: Array<[Deliverable["platform"], Deliverable["format"], string]> = [
    ["instagram", "reel", "Instagram Reel"],
    ["instagram", "carousel", "Instagram Carousel Post"],
    ["instagram", "story", "Instagram Story"],
    ["tiktok", "video", "TikTok Video"],
    ["youtube", "dedicated", "YouTube Dedicated Video"],
    ["youtube", "integrated", "YouTube Integrated Video"],
    ["linkedin", "post", "LinkedIn Post"],
    ["linkedin", "video", "LinkedIn Video"],
    ["twitter", "post", "Twitter Post"],
  ];
  for (const [platform, format, expectedNoun] of cases) {
    const [line] = formatDeliverablesForCreator([d({ platform, format, quantity: 1 })]);
    assert.equal(line, `1 ${expectedNoun}`, `${platform}/${format}`);
  }
});

console.log("\nthe issue's own worked example\n");

test("the issue's own example: '1 Instagram Reel, 3 Instagram Stories, and 1 Raw Footage package'", () => {
  const lines = formatDeliverablesForCreator([
    d({ id: "a", platform: "instagram", format: "reel", quantity: 1 }),
    d({ id: "b", platform: "instagram", format: "story", quantity: 3 }),
    d({ id: "c", platform: "other", format: "other", quantity: 1, customLabel: "Raw Footage package" }),
  ]);
  assert.deepEqual(lines, ["1 Instagram Reel", "3 Instagram Stories", "1 Raw Footage package"]);
});

console.log("\ncustom (\"other\") deliverables\n");

test("custom label renders verbatim at quantity 1", () => {
  const [line] = formatDeliverablesForCreator([
    d({ platform: "other", format: "other", quantity: 1, customLabel: "Behind-the-scenes reel" }),
  ]);
  assert.equal(line, "1 Behind-the-scenes reel");
});

test("custom label is pluralized (best-effort) at quantity > 1", () => {
  const [line] = formatDeliverablesForCreator([
    d({ platform: "other", format: "other", quantity: 2, customLabel: "Raw Footage package" }),
  ]);
  assert.equal(line, "2 Raw Footage packages");
});

test("a missing/blank customLabel falls back to a generic label rather than rendering empty", () => {
  const [line] = formatDeliverablesForCreator([
    d({ platform: "other", format: "other", quantity: 1, customLabel: null }),
  ]);
  assert.equal(line, "1 Custom deliverable");
});

console.log("\nrequirements and notes\n");

test("durationSeconds with both min and max renders a range", () => {
  const [line] = formatDeliverablesForCreator([
    d({ requirements: { durationSeconds: { min: 30, max: 60 } } }),
  ]);
  assert.equal(line, "1 Instagram Reel (30–60s)");
});

test("durationSeconds with only min renders a floor", () => {
  const [line] = formatDeliverablesForCreator([d({ requirements: { durationSeconds: { min: 15 } } })]);
  assert.equal(line, "1 Instagram Reel (15s+)");
});

test("durationSeconds with only max renders a ceiling", () => {
  const [line] = formatDeliverablesForCreator([d({ requirements: { durationSeconds: { max: 90 } } })]);
  assert.equal(line, "1 Instagram Reel (up to 90s)");
});

test("no requirements omits the parenthetical entirely", () => {
  const [line] = formatDeliverablesForCreator([d()]);
  assert.equal(line, "1 Instagram Reel");
});

test("notes are appended as a trailing note, after any requirements", () => {
  const [line] = formatDeliverablesForCreator([
    d({
      requirements: { durationSeconds: { min: 30, max: 60 } },
      notes: "brand-requested angle",
    }),
  ]);
  assert.equal(line, "1 Instagram Reel (30–60s) — brand-requested angle");
});

test("blank/whitespace-only notes are omitted, not rendered as an empty trailing dash", () => {
  const [line] = formatDeliverablesForCreator([d({ notes: "   " })]);
  assert.equal(line, "1 Instagram Reel");
});

console.log("\nthe complete-package contract — every item renders, order preserved\n");

test("a mixed package with one negotiated quantity change still renders every item, not just the changed one", () => {
  const lines = formatDeliverablesForCreator([
    d({ id: "reel", platform: "instagram", format: "reel", quantity: 1 }), // negotiated down from 2
    d({ id: "story", platform: "instagram", format: "story", quantity: 3 }), // unchanged
    d({ id: "raw", platform: "other", format: "other", quantity: 1, customLabel: "Raw Footage package" }), // unchanged
  ]);
  assert.equal(lines.length, 3, "every item in the final package renders, not only the one that changed");
});

test("an empty array renders an empty array (the caller is responsible for blocking on empty, not this function)", () => {
  assert.deepEqual(formatDeliverablesForCreator([]), []);
});

test("output preserves input order (no re-sorting or grouping)", () => {
  const lines = formatDeliverablesForCreator([
    d({ id: "a", format: "story" }),
    d({ id: "b", format: "reel" }),
    d({ id: "c", format: "carousel" }),
  ]);
  assert.deepEqual(lines, ["1 Instagram Story", "1 Instagram Reel", "1 Instagram Carousel Post"]);
});

console.log("\nno internal id/enum leakage\n");

test("no output line contains a raw id, a raw lowercase enum value, or JSON syntax", () => {
  const lines = formatDeliverablesForCreator([
    d({ id: "del_a1b2c3", platform: "instagram", format: "reel", quantity: 2 }),
    d({ id: "del_d4e5f6", platform: "other", format: "other", quantity: 1, customLabel: "Raw Footage package" }),
  ]);
  for (const line of lines) {
    assert.ok(!line.includes("del_"), `leaked a raw id: ${line}`);
    assert.ok(!/[{}[\]"]/.test(line), `leaked JSON syntax: ${line}`);
    assert.ok(!/\binstagram\b/.test(line), `leaked the raw lowercase platform enum: ${line}`);
    assert.ok(!/\breel\b/.test(line), `leaked the raw lowercase format enum: ${line}`);
  }
});
