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
  normalizeLegacyDeliverables,
  remapLegacyDeliverablePricingKeys,
  resolveDeliverableSave,
  validateDeliverableDeltas,
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

console.log("\nnormalizeLegacyDeliverables — a campaign can still hold rows saved before id was required\n");

test("an id-less legacy row is minted a fresh, non-empty id", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 }; // no id
  const { items } = normalizeLegacyDeliverables([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(typeof normalized?.["id"], "string");
  assert.ok((normalized?.["id"] as string).length > 0);
  assert.equal(normalized?.["platform"], "instagram");
});

test("a row that already has an id keeps that EXACT id (not re-minted)", () => {
  const { items, legacyKeyToId } = normalizeLegacyDeliverables([d({ id: "del_stable" })]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["id"], "del_stable");
  assert.equal(legacyKeyToId.size, 0, "an already-id'd row mints nothing");
});

test("two id-less rows in the same array each get their OWN distinct minted id", () => {
  const a = { platform: "instagram", format: "reel", quantity: 1 };
  const b = { platform: "instagram", format: "story", quantity: 1 };
  const { items } = normalizeLegacyDeliverables([a, b]);
  const [na, nb] = items as Array<Record<string, unknown>>;
  assert.notEqual(na?.["id"], nb?.["id"]);
});

test("non-array input passes through untouched, letting validateDeliverables produce the real error", () => {
  const input = { not: "an array" };
  const { items, legacyKeyToId } = normalizeLegacyDeliverables(input);
  assert.equal(items, input);
  assert.equal(legacyKeyToId.size, 0);
});

test("non-object array entries pass through untouched", () => {
  const { items } = normalizeLegacyDeliverables([null, 42, "x"]);
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
test("fix: normalizeLegacyDeliverables then validateDeliverables accepts the same legacy row", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const result = validateDeliverables(normalizeLegacyDeliverables([legacy]).items);
  assert.equal(result.ok, true);
});

test("a mix of legacy id-less rows and already-id'd rows all validate together, ids stay unique", () => {
  const legacyA = { platform: "instagram", format: "reel", quantity: 1 };
  const legacyB = { platform: "instagram", format: "story", quantity: 1 };
  const modern = d({ id: "del_modern", platform: "tiktok", format: "video" });
  const result = validateDeliverables(normalizeLegacyDeliverables([legacyA, legacyB, modern]).items);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 3);
    const ids = result.deliverables.map((x) => x.id);
    assert.equal(new Set(ids).size, 3, "every row — legacy and modern — has a unique id");
  }
});

console.log("\nnormalizeLegacyDeliverables — round 2: free-form platform/format and bad quantity\n");

test("an unrecognized platform string is rebucketed into other/other with a synthesized customLabel", () => {
  const legacy = { id: "del_1", platform: "facebook", format: "livestream", quantity: 1 };
  const { items } = normalizeLegacyDeliverables([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["platform"], "other");
  assert.equal(normalized?.["format"], "other");
  assert.equal(normalized?.["customLabel"], "facebook livestream");
});

test("a recognized platform/format pair NOT in PLATFORM_FORMAT_MATRIX (e.g. tiktok+reel) is also rebucketed", () => {
  const legacy = { id: "del_1", platform: "tiktok", format: "reel", quantity: 1 };
  const { items } = normalizeLegacyDeliverables([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["platform"], "other");
  assert.equal(normalized?.["format"], "other");
  assert.equal(normalized?.["customLabel"], "tiktok reel");
});

test("an already-valid platform/format pair is left completely untouched, including any existing customLabel", () => {
  const valid = { id: "del_1", platform: "instagram", format: "reel", quantity: 1, customLabel: "keep me" };
  const { items } = normalizeLegacyDeliverables([valid]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["platform"], "instagram");
  assert.equal(normalized?.["format"], "reel");
  assert.equal(normalized?.["customLabel"], "keep me", "not clobbered — the pair was already valid");
});

test("an already-other/other row keeps its existing customLabel — never re-migrated", () => {
  const existing = { id: "del_1", platform: "other", format: "other", quantity: 1, customLabel: "Raw Footage" };
  const { items } = normalizeLegacyDeliverables([existing]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["customLabel"], "Raw Footage");
});

test("a completely missing/blank platform+format still gets a non-empty fallback label, never an empty string", () => {
  const legacy = { id: "del_1", quantity: 1 };
  const { items } = normalizeLegacyDeliverables([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["platform"], "other");
  assert.equal(normalized?.["format"], "other");
  assert.equal(normalized?.["customLabel"], "Legacy deliverable");
});

test("zero quantity migrates to 1", () => {
  const legacy = { id: "del_1", platform: "instagram", format: "reel", quantity: 0 };
  const { items } = normalizeLegacyDeliverables([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["quantity"], 1);
});

test("negative, non-numeric-string, and missing quantity all migrate to 1", () => {
  for (const quantity of [-5, "not a number", undefined, null]) {
    const { items } = normalizeLegacyDeliverables([{ id: "del_1", platform: "instagram", format: "reel", quantity }]);
    const [normalized] = items as Array<Record<string, unknown>>;
    assert.equal(normalized?.["quantity"], 1, `quantity ${JSON.stringify(quantity)} must migrate to 1`);
  }
});

test("a numeric-string quantity is parsed rather than defaulted", () => {
  const { items } = normalizeLegacyDeliverables([{ id: "del_1", platform: "instagram", format: "reel", quantity: "3" }]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["quantity"], 3);
});

test("a fractional quantity rounds rather than defaulting to 1", () => {
  const { items } = normalizeLegacyDeliverables([{ id: "del_1", platform: "instagram", format: "reel", quantity: 2.7 }]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["quantity"], 3);
});

test("an already-valid positive integer quantity is left completely untouched", () => {
  const { items } = normalizeLegacyDeliverables([{ id: "del_1", platform: "instagram", format: "reel", quantity: 5 }]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(normalized?.["quantity"], 5);
});

// The reviewer's exact reported bug: a historical free-form platform/format
// or zero quantity fails validateDeliverables directly, even with the id
// fix already applied — this is what still 400'd an unrelated edit to a
// legacy campaign after the FIRST round of this fix shipped.
test("regression: id-fixed-but-otherwise-legacy rows (bad platform, bad combo, zero quantity) still FAIL validateDeliverables directly", () => {
  const badPlatform = { id: "del_1", platform: "facebook", format: "livestream", quantity: 1 };
  const badCombo = { id: "del_2", platform: "tiktok", format: "reel", quantity: 1 };
  const zeroQty = { id: "del_3", platform: "instagram", format: "reel", quantity: 0 };
  for (const item of [badPlatform, badCombo, zeroQty]) {
    assert.equal(validateDeliverables([item]).ok, false, JSON.stringify(item));
  }
});

// The fix: the SAME rows now survive normalizeLegacyDeliverables + validateDeliverables.
test("fix: the same historically-invalid rows all pass after normalizeLegacyDeliverables", () => {
  const badPlatform = { platform: "facebook", format: "livestream", quantity: 1 }; // also no id
  const badCombo = { id: "del_2", platform: "tiktok", format: "reel", quantity: 1 };
  const zeroQty = { id: "del_3", platform: "instagram", format: "reel", quantity: 0 };
  const { items } = normalizeLegacyDeliverables([badPlatform, badCombo, zeroQty]);
  const result = validateDeliverables(items);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 3, "no row silently dropped — every legacy row survives, migrated");
  }
});

console.log("\nnormalizeLegacyDeliverables — legacyKeyToId (feeds the deliverablePricing remap)\n");

test("a minted legacy id is recorded under its \"<platform>:<format>\" composite key", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const { items, legacyKeyToId } = normalizeLegacyDeliverables([legacy]);
  const [normalized] = items as Array<Record<string, unknown>>;
  assert.equal(legacyKeyToId.size, 1);
  assert.equal(legacyKeyToId.get("instagram:reel"), normalized?.["id"]);
});

test("an already-id'd row contributes NOTHING to legacyKeyToId", () => {
  const { legacyKeyToId } = normalizeLegacyDeliverables([d({ id: "del_stable" })]);
  assert.equal(legacyKeyToId.size, 0);
});

test("two legacy rows sharing the same platform+format only map the FIRST (an already-ambiguous case under the old composite-keyed scheme)", () => {
  const a = { platform: "other", format: "other", quantity: 1, customLabel: "Raw Footage" };
  const b = { platform: "other", format: "other", quantity: 1, customLabel: "Loose Post" };
  const { legacyKeyToId } = normalizeLegacyDeliverables([a, b]);
  assert.equal(legacyKeyToId.size, 1, "only one entry — the composite key can't disambiguate the two");
});

console.log("\nremapLegacyDeliverablePricingKeys — review fix: keep deliverablePricing from orphaning\n");

test("a pricing entry keyed by the OLD composite is folded onto the newly minted id", () => {
  const legacy = { platform: "instagram", format: "reel", quantity: 2 };
  const { legacyKeyToId } = normalizeLegacyDeliverables([legacy]);
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
  const { items, legacyKeyToId } = normalizeLegacyDeliverables([legacy]);
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

console.log("\nresolveDeliverableSave — fresh input is validated strictly, legacy carry-forward is self-healed\n");

test("a fresh, malformed item ([{}]) with no matching existing row is REJECTED, not coerced into quantity 1", () => {
  const result = resolveDeliverableSave([{}], []);
  assert.equal(result.ok, false);
});

test("a fresh, well-shaped item with quantity: 0 is REJECTED, not coerced into quantity 1", () => {
  const result = resolveDeliverableSave(
    [{ id: "new_1", platform: "instagram", format: "reel", quantity: 0 }],
    [],
  );
  assert.equal(result.ok, false);
});

test("a fresh item with an invalid platform/format combination is REJECTED, not migrated to other/other", () => {
  const result = resolveDeliverableSave(
    [{ id: "new_1", platform: "tiktok", format: "reel", quantity: 1 }],
    [],
  );
  assert.equal(result.ok, false);
});

test("a genuinely new, well-formed item (no matching existing row) is accepted as submitted", () => {
  const item = { id: "new_1", platform: "instagram", format: "reel", quantity: 3 };
  const result = resolveDeliverableSave([item], []);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 1);
    assert.equal(result.deliverables[0]!.quantity, 3);
  }
});

test("an item byte-for-byte identical to an already-stored legacy row IS self-healed (id minted, platform/format migrated)", () => {
  const legacyStored = { platform: "myspace", format: "blast", quantity: 2 };
  const result = resolveDeliverableSave([legacyStored], [legacyStored]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.deliverables.length, 1);
    assert.equal(result.deliverables[0]!.platform, "other");
    assert.equal(result.deliverables[0]!.format, "other");
    assert.ok(result.deliverables[0]!.id.length > 0, "an id must have been minted");
  }
});

test("editing a stored legacy row's quantity makes it FRESH input — validated strictly, not silently repaired", () => {
  const stored = { platform: "myspace", format: "blast", quantity: 2 };
  // The brand edited quantity from 2 -> 0 this save — no longer identical to
  // what's stored, so it must NOT be treated as a safe-to-self-heal carry
  // forward; it must be rejected outright (an invalid FRESH edit), not
  // silently coerced back to quantity 1.
  const edited = { platform: "myspace", format: "blast", quantity: 0 };
  const result = resolveDeliverableSave([edited], [stored]);
  assert.equal(result.ok, false);
});

test("key order inside a submitted object doesn't defeat the 'unchanged legacy row' match", () => {
  const stored = { platform: "myspace", format: "blast", quantity: 2 };
  const resubmittedReordered = { quantity: 2, format: "blast", platform: "myspace" };
  const result = resolveDeliverableSave([resubmittedReordered], [stored]);
  assert.equal(result.ok, true, "a mere key-order difference must still match as unchanged");
});

test("two identical items can't both hide behind ONE stored legacy row (multiset match) — the second is treated as fresh and, being raw legacy shape, fails strict validation", () => {
  const stored = { platform: "myspace", format: "blast", quantity: 2 };
  // Two items, byte-identical to each other AND to the one stored row — but
  // only ONE stored row exists to match against.
  const result = resolveDeliverableSave([stored, { ...stored }], [stored]);
  // The FIRST occurrence consumes the one stored match and self-heals. The
  // SECOND occurrence, with nothing left to match, is validated as fresh
  // input — and since the raw legacy shape (no id, unrecognized platform)
  // is not schema-valid on its own, the whole save is rejected rather than
  // silently letting the second copy through unmigrated.
  assert.equal(result.ok, false, "the second, unmatched occurrence must fail strict fresh validation");
});

test("a well-formed, schema-valid item that's ALSO fresh (not matching anything stored) still passes on its own merits", () => {
  const alreadyValid = { id: "del_x", platform: "instagram", format: "reel", quantity: 1 };
  const result = resolveDeliverableSave([alreadyValid, { ...alreadyValid, id: "del_y" }], [alreadyValid]);
  // Only ONE of the two matches the stored row; the second (del_y) is fresh
  // but is ALSO independently schema-valid, so it passes on its own merits —
  // proving "fresh" doesn't mean "always rejected," only "not coerced."
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.deliverables.length, 2);
});

// ---------------------------------------------------------------------------
// PLU-172 — DeliverableDelta (the frozen negotiation-delta contract)
// ---------------------------------------------------------------------------

console.log("\nDeliverableDelta — SET_QUANTITY / REPLACE_FORMAT / ADD / REMOVE\n");

test("SET_QUANTITY with a positive integer quantity is valid", () => {
  const r = validateDeliverableDeltas([
    { operation: "SET_QUANTITY", sourceDeliverableId: "del_1", quantity: 1, normalization: "EXACT" },
  ]);
  assert.equal(r.ok, true);
});

test("SET_QUANTITY with quantity 0 is rejected", () => {
  const r = validateDeliverableDeltas([
    { operation: "SET_QUANTITY", sourceDeliverableId: "del_1", quantity: 0, normalization: "EXACT" },
  ]);
  assert.equal(r.ok, false);
});

test("REPLACE_FORMAT with a valid platform/format combination is accepted", () => {
  const r = validateDeliverableDeltas([
    { operation: "REPLACE_FORMAT", sourceDeliverableId: "del_1", platform: "instagram", format: "story", normalization: "EXACT" },
  ]);
  assert.equal(r.ok, true);
});

test("REPLACE_FORMAT with TIKTOK + REEL (invalid combination) is rejected — reuses PLATFORM_FORMAT_MATRIX", () => {
  const r = validateDeliverableDeltas([
    { operation: "REPLACE_FORMAT", sourceDeliverableId: "del_1", platform: "tiktok", format: "reel", normalization: "EXACT" },
  ]);
  assert.equal(r.ok, false);
});

test("ADD with a fully valid new deliverable (no id — minted downstream) is accepted", () => {
  const r = validateDeliverableDeltas([
    { operation: "ADD", deliverable: { platform: "instagram", format: "reel", quantity: 1 }, normalization: "EXACT" },
  ]);
  assert.equal(r.ok, true);
});

test("ADD with an explicit id is also accepted (structural validity only — collision with an existing package item is an apply-step concern)", () => {
  const r = validateDeliverableDeltas([
    { operation: "ADD", deliverable: { id: "del_new", platform: "instagram", format: "reel", quantity: 1 }, normalization: "EXACT" },
  ]);
  assert.equal(r.ok, true);
});

test("ADD with an invalid platform/format combination on the embedded deliverable is rejected (the SAME invariants as any other deliverable)", () => {
  const r = validateDeliverableDeltas([
    { operation: "ADD", deliverable: { platform: "linkedin", format: "carousel", quantity: 1 }, normalization: "EXACT" },
  ]);
  assert.equal(r.ok, false);
});

test("ADD with platform 'other' and no customLabel is rejected (same customLabel-required invariant as deliverableSchema)", () => {
  const r = validateDeliverableDeltas([
    { operation: "ADD", deliverable: { platform: "other", format: "other", quantity: 1 }, normalization: "EXACT" },
  ]);
  assert.equal(r.ok, false);
});

test("REMOVE with just a sourceDeliverableId is valid", () => {
  const r = validateDeliverableDeltas([{ operation: "REMOVE", sourceDeliverableId: "del_1", normalization: "EXACT" }]);
  assert.equal(r.ok, true);
});

test("an unknown operation is rejected", () => {
  const r = validateDeliverableDeltas([{ operation: "REPLACE_EVERYTHING", sourceDeliverableId: "del_1", normalization: "EXACT" }]);
  assert.equal(r.ok, false);
});

test("SET_QUANTITY missing sourceDeliverableId is rejected", () => {
  const r = validateDeliverableDeltas([{ operation: "SET_QUANTITY", quantity: 2, normalization: "EXACT" }]);
  assert.equal(r.ok, false);
});

test("normalization: AMBIGUOUS is structurally valid (the SCHEMA accepts it — routing an ambiguous proposal away from auto-approval is the apply-step's/evaluator's job, not this schema's)", () => {
  const r = validateDeliverableDeltas([
    { operation: "SET_QUANTITY", sourceDeliverableId: "del_1", quantity: 1, normalization: "AMBIGUOUS" },
  ]);
  assert.equal(r.ok, true);
});

test("a delta missing normalization entirely is rejected", () => {
  const r = validateDeliverableDeltas([{ operation: "REMOVE", sourceDeliverableId: "del_1" }]);
  assert.equal(r.ok, false);
});

test("sourceText is optional and, when present, carried through", () => {
  const r = validateDeliverableDeltas([
    { operation: "REMOVE", sourceDeliverableId: "del_1", normalization: "EXACT", sourceText: "drop the story post" },
  ]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.deltas[0]!.sourceText, "drop the story post");
});

test("an unrecognized extra field on a delta is rejected (.strict())", () => {
  const r = validateDeliverableDeltas([
    { operation: "REMOVE", sourceDeliverableId: "del_1", normalization: "EXACT", extra: true },
  ]);
  assert.equal(r.ok, false);
});

test("multiple deltas in one array validate independently", () => {
  const r = validateDeliverableDeltas([
    { operation: "SET_QUANTITY", sourceDeliverableId: "del_1", quantity: 3, normalization: "EXACT" },
    { operation: "REMOVE", sourceDeliverableId: "del_2", normalization: "ALIASED" },
  ]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.deltas.length, 2);
});
