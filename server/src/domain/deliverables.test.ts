/**
 * PLU-169 (1f) — unit tests for the shared deliverables validator.
 * Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/deliverables.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_FORMAT_MATRIX,
  deliverableSchema,
  deliverablesSchema,
  validateDeliverables,
  normalizeLegacyDeliverableIds,
} from "./deliverablesValidator.js";

function d(overrides: Record<string, unknown> = {}) {
  return {
    id: "del_1",
    platform: "instagram",
    format: "reel",
    quantity: 2,
    ...overrides,
  };
}

console.log("\nPLATFORM_FORMAT_MATRIX — every real-catalog combination the 8 existing DELIVERABLE_CARDS use\n");

test("every DELIVERABLE_CARDS platform/format pair validates (rollout must not break existing saved rows)", () => {
  const cards: Array<[string, string]> = [
    ["instagram", "reel"],
    ["instagram", "carousel"],
    ["tiktok", "video"],
    ["youtube", "dedicated"],
    ["youtube", "integrated"],
    ["linkedin", "post"],
    ["linkedin", "video"],
    ["twitter", "post"],
  ];
  for (const [platform, format] of cards) {
    const r = deliverableSchema.safeParse(d({ platform, format }));
    assert.equal(r.success, true, `${platform}/${format} must validate`);
  }
});

test("instagram/story validates too (worksheet card not yet in the fixed 8, but a real combination)", () => {
  const r = deliverableSchema.safeParse(d({ platform: "instagram", format: "story" }));
  assert.equal(r.success, true);
});

console.log("\ninvalid platform/format combinations are rejected\n");

test("tiktok + reel is rejected (not in the matrix)", () => {
  const r = deliverableSchema.safeParse(d({ platform: "tiktok", format: "reel" }));
  assert.equal(r.success, false);
});

test("linkedin + carousel is rejected", () => {
  const r = deliverableSchema.safeParse(d({ platform: "linkedin", format: "carousel" }));
  assert.equal(r.success, false);
});

test("a real platform paired with format \"other\" is rejected (decision #8: \"other\" is platform-less)", () => {
  const r = deliverableSchema.safeParse(d({ platform: "instagram", format: "other" }));
  assert.equal(r.success, false);
});

console.log("\ncustom (\"other\") deliverables\n");

test("platform=other, format=other, WITH customLabel validates", () => {
  const r = deliverableSchema.safeParse(
    d({ platform: "other", format: "other", customLabel: "Raw Footage Package" }),
  );
  assert.equal(r.success, true);
});

test("platform=other WITHOUT customLabel is rejected", () => {
  const r = deliverableSchema.safeParse(d({ platform: "other", format: "other" }));
  assert.equal(r.success, false);
});

test("platform=other with blank/whitespace customLabel is rejected", () => {
  const r = deliverableSchema.safeParse(d({ platform: "other", format: "other", customLabel: "   " }));
  assert.equal(r.success, false);
});

console.log("\nfield/value type + quantity constraints\n");

test("quantity must be a positive integer", () => {
  assert.equal(deliverableSchema.safeParse(d({ quantity: 0 })).success, false);
  assert.equal(deliverableSchema.safeParse(d({ quantity: -1 })).success, false);
  assert.equal(deliverableSchema.safeParse(d({ quantity: 1.5 })).success, false);
  assert.equal(deliverableSchema.safeParse(d({ quantity: "2" })).success, false);
});

test("an unknown platform/format string is rejected (closed enum)", () => {
  assert.equal(deliverableSchema.safeParse(d({ platform: "facebook" })).success, false);
  assert.equal(deliverableSchema.safeParse(d({ format: "livestream" })).success, false);
});

test("id must be a non-empty string", () => {
  assert.equal(deliverableSchema.safeParse(d({ id: "" })).success, false);
  assert.equal(deliverableSchema.safeParse(d({ id: 123 })).success, false);
});

test("an unknown extra field is rejected (strict schema, no silent passthrough)", () => {
  const r = deliverableSchema.safeParse(d({ unexpectedField: "x" }));
  assert.equal(r.success, false);
});

console.log("\nrequirements — the one machine-comparable structured field in scope\n");

test("durationSeconds min/max validates", () => {
  const r = deliverableSchema.safeParse(
    d({ requirements: { durationSeconds: { min: 30, max: 60 } } }),
  );
  assert.equal(r.success, true);
});

test("requirements is optional and nullable", () => {
  assert.equal(deliverableSchema.safeParse(d({ requirements: null })).success, true);
  assert.equal(deliverableSchema.safeParse(d()).success, true);
});

test("negative duration bounds are rejected", () => {
  const r = deliverableSchema.safeParse(
    d({ requirements: { durationSeconds: { min: -5 } } }),
  );
  assert.equal(r.success, false);
});

console.log("\ndeliverablesSchema — array-level rules\n");

test("unique ids across the array is required", () => {
  const r = deliverablesSchema.safeParse([d({ id: "del_1" }), d({ id: "del_1" })]);
  assert.equal(r.success, false);
});

test("distinct ids across the array validates", () => {
  const r = deliverablesSchema.safeParse([
    d({ id: "del_1" }),
    d({ id: "del_2", platform: "tiktok", format: "video" }),
  ]);
  assert.equal(r.success, true);
});

test("an empty array validates (a campaign can have zero deliverables recorded yet)", () => {
  assert.equal(deliverablesSchema.safeParse([]).success, true);
});

console.log("\nvalidateDeliverables — the typed wrapper\n");

test("ok:true carries the parsed deliverables array", () => {
  const result = validateDeliverables([d()]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 1);
    assert.equal(result.deliverables[0]?.platform, "instagram");
  }
});

test("ok:false carries a joined error message, never throws", () => {
  const result = validateDeliverables([{ id: "x" }]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  }
});

test("non-array input is rejected without throwing", () => {
  const result = validateDeliverables({ not: "an array" });
  assert.equal(result.ok, false);
});

console.log("\nPLATFORM_FORMAT_MATRIX — closed-list documentation lock\n");

test("every platform has at least one valid format", () => {
  for (const platform of Object.keys(PLATFORM_FORMAT_MATRIX) as (keyof typeof PLATFORM_FORMAT_MATRIX)[]) {
    assert.ok(PLATFORM_FORMAT_MATRIX[platform].length > 0, `${platform} must allow at least one format`);
  }
});

test("\"other\" platform allows only \"other\" format (decision #8)", () => {
  assert.deepEqual(PLATFORM_FORMAT_MATRIX.other, ["other"]);
});

console.log("\nnormalizeLegacyDeliverableIds — a campaign can still hold rows saved before id was required\n");

test("an id-less legacy row is minted a fresh, non-empty id", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 }; // no id
  const [normalized] = normalizeLegacyDeliverableIds([legacy]) as Array<Record<string, unknown>>;
  assert.equal(typeof normalized?.["id"], "string");
  assert.ok((normalized?.["id"] as string).length > 0);
  assert.equal(normalized?.["platform"], "instagram");
});

test("a row that already has an id keeps that EXACT id (not re-minted)", () => {
  const [normalized] = normalizeLegacyDeliverableIds([d({ id: "del_stable" })]) as Array<
    Record<string, unknown>
  >;
  assert.equal(normalized?.["id"], "del_stable");
});

test("two id-less rows in the same array each get their OWN distinct minted id", () => {
  const a = { platform: "instagram", format: "reel", quantity: 1 };
  const b = { platform: "instagram", format: "story", quantity: 1 };
  const [na, nb] = normalizeLegacyDeliverableIds([a, b]) as Array<Record<string, unknown>>;
  assert.notEqual(na?.["id"], nb?.["id"]);
});

test("non-array input passes through untouched, letting validateDeliverables produce the real error", () => {
  const input = { not: "an array" };
  assert.equal(normalizeLegacyDeliverableIds(input), input);
});

test("non-object array entries pass through untouched", () => {
  const result = normalizeLegacyDeliverableIds([null, 42, "x"]);
  assert.deepEqual(result, [null, 42, "x"]);
});

// The reported bug: an id-less legacy row, run through validateDeliverables
// DIRECTLY, is rejected — this is what made an unrelated edit to a legacy,
// not-yet-backfilled campaign 400 on every save.
test("regression: an id-less legacy row FAILS validateDeliverables directly (proves the bug existed)", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const result = validateDeliverables([legacy]);
  assert.equal(result.ok, false);
});

// The fix: normalize BEFORE validating, exactly as finalAgreements.ts's
// resolveFinalDeliverables and routes/campaigns.ts's PATCH handler now do —
// the same legacy row now passes.
test("fix: normalizeLegacyDeliverableIds then validateDeliverables accepts the same legacy row", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const result = validateDeliverables(normalizeLegacyDeliverableIds([legacy]));
  assert.equal(result.ok, true);
});

test("a mix of legacy id-less rows and already-id'd rows all validate together, ids stay unique", () => {
  const legacyA = { platform: "instagram", format: "reel", quantity: 1 };
  const legacyB = { platform: "instagram", format: "story", quantity: 1 };
  const modern = d({ id: "del_modern", platform: "tiktok", format: "video" });
  const result = validateDeliverables(normalizeLegacyDeliverableIds([legacyA, legacyB, modern]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 3);
    const ids = result.deliverables.map((x) => x.id);
    assert.equal(new Set(ids).size, 3, "every row — legacy and modern — has a unique id");
  }
});
