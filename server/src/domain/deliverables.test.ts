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
  remapLegacyDeliverablePricingKeys,
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
  const { items } = normalizeLegacyDeliverableIds([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(typeof normalized?.["id"], "string");
  assert.ok((normalized?.["id"] as string).length > 0);
  assert.equal(normalized?.["platform"], "instagram");
});

test("a row that already has an id keeps that EXACT id (not re-minted)", () => {
  const { items, legacyKeyToId } = normalizeLegacyDeliverableIds([d({ id: "del_stable" })]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["id"], "del_stable");
  assert.equal(legacyKeyToId.size, 0, "an already-id'd row mints nothing");
});

test("two id-less rows in the same array each get their OWN distinct minted id", () => {
  const a = { platform: "instagram", format: "reel", quantity: 1 };
  const b = { platform: "instagram", format: "story", quantity: 1 };
  const { items } = normalizeLegacyDeliverableIds([a, b]);
  const [na, nb] = items as Array<Record<string, unknown>>;
  assert.notEqual(na?.["id"], nb?.["id"]);
});

test("non-array input passes through untouched, letting validateDeliverables produce the real error", () => {
  const input = { not: "an array" };
  const { items, legacyKeyToId } = normalizeLegacyDeliverableIds(input);
  assert.equal(items, input);
  assert.equal(legacyKeyToId.size, 0);
});

test("non-object array entries pass through untouched", () => {
  const { items } = normalizeLegacyDeliverableIds([null, 42, "x"]);
  assert.deepEqual(items, [null, 42, "x"]);
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
  const result = validateDeliverables(normalizeLegacyDeliverableIds([legacy]).items);
  assert.equal(result.ok, true);
});

test("a mix of legacy id-less rows and already-id'd rows all validate together, ids stay unique", () => {
  const legacyA = { platform: "instagram", format: "reel", quantity: 1 };
  const legacyB = { platform: "instagram", format: "story", quantity: 1 };
  const modern = d({ id: "del_modern", platform: "tiktok", format: "video" });
  const result = validateDeliverables(normalizeLegacyDeliverableIds([legacyA, legacyB, modern]).items);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 3);
    const ids = result.deliverables.map((x) => x.id);
    assert.equal(new Set(ids).size, 3, "every row — legacy and modern — has a unique id");
  }
});

console.log("\nnormalizeLegacyDeliverableIds — legacyKeyToId (feeds the deliverablePricing remap)\n");

test("a minted legacy id is recorded under its \"<platform>:<format>\" composite key", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const { items, legacyKeyToId } = normalizeLegacyDeliverableIds([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(legacyKeyToId.size, 1);
  assert.equal(legacyKeyToId.get("instagram:reel"), normalized?.["id"]);
});

test("an already-id'd row contributes NOTHING to legacyKeyToId", () => {
  const { legacyKeyToId } = normalizeLegacyDeliverableIds([d({ id: "del_stable" })]);
  assert.equal(legacyKeyToId.size, 0);
});

test("two legacy rows sharing the same platform+format only map the FIRST (an already-ambiguous case under the old composite-keyed scheme)", () => {
  const a = { platform: "other", format: "other", quantity: 1, customLabel: "Raw Footage" };
  const b = { platform: "other", format: "other", quantity: 1, customLabel: "Loose Post" };
  const { legacyKeyToId } = normalizeLegacyDeliverableIds([a, b]);
  assert.equal(legacyKeyToId.size, 1, "only one entry — the composite key can't disambiguate the two");
});

console.log("\nremapLegacyDeliverablePricingKeys — review fix: keep deliverablePricing from orphaning\n");

test("a pricing entry keyed by the OLD composite is folded onto the newly minted id", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const { legacyKeyToId } = normalizeLegacyDeliverableIds([legacy]);
  const newId = legacyKeyToId.get("instagram:reel")!;
  const remapped = remapLegacyDeliverablePricingKeys({ "instagram:reel": 50000 }, legacyKeyToId) as Record<
    string,
    unknown
  >;
  assert.equal(remapped["instagram:reel"], undefined, "the stale composite key must not survive");
  assert.equal(remapped[newId], 50000, "the price now lives under the row's current id");
});

test("a pricing entry NOT covered by legacyKeyToId (e.g. already id-keyed) passes through unchanged", () => {
  const remapped = remapLegacyDeliverablePricingKeys(
    { del_modern: 30000 },
    new Map([["instagram:reel", "del_new"]]),
  ) as Record<string, unknown>;
  assert.equal(remapped["del_modern"], 30000);
});

test("a price already saved under the NEW id wins over the stale composite-keyed value", () => {
  const legacyKeyToId = new Map([["instagram:reel", "del_new"]]);
  const remapped = remapLegacyDeliverablePricingKeys(
    { "instagram:reel": 50000, del_new: 99000 },
    legacyKeyToId,
  ) as Record<string, unknown>;
  assert.equal(remapped["del_new"], 99000, "the already-migrated value must not be clobbered by the stale one");
});

test("an empty legacyKeyToId returns the pricing object unchanged (the common, non-legacy case)", () => {
  const pricing = { del_a: 100, del_b: 200 };
  assert.deepEqual(remapLegacyDeliverablePricingKeys(pricing, new Map()), pricing);
});

test("non-object pricing (null, array, scalar) passes through untouched for the caller's own validation", () => {
  const map = new Map([["instagram:reel", "del_new"]]);
  assert.equal(remapLegacyDeliverablePricingKeys(null, map), null);
  assert.deepEqual(remapLegacyDeliverablePricingKeys([1, 2], map), [1, 2]);
  assert.equal(remapLegacyDeliverablePricingKeys("not an object", map), "not an object");
});

test("end-to-end: normalize a legacy deliverable, then remap its pricing entry, exactly as the PATCH route does", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const { items, legacyKeyToId } = normalizeLegacyDeliverableIds([legacy]);
  const validated = validateDeliverables(items);
  assert.equal(validated.ok, true);
  const remappedPricing = remapLegacyDeliverablePricingKeys(
    { "instagram:reel": 75000 },
    legacyKeyToId,
  ) as Record<string, unknown>;
  if (validated.ok) {
    const newId = validated.deliverables[0]!.id;
    assert.equal(remappedPricing[newId], 75000, "PricingGrid's keyOf(row) now finds the price under row.id");
  }
});
