/**
 * PLU-139 (2a) — sections.ts logic tests. Pure model, no React. Run with:
 *   npx tsx src/components/builder/campaignIntake/sections.test.ts
 *
 * Asserts the reward-structure conditional contract from worksheet Page 7:
 *   Paid → fee + strategy, no commission
 *   Affiliate → commission, no fee (and Paid is NOT labeled "non-negotiated")
 *   Hybrid → both
 *   Gift-only → gift, no fee/commission, disposition locked to KEEP
 *   switching structure hides + clears the now-irrelevant fields
 */

import assert from "node:assert/strict";
import {
  SECTIONS,
  getSection,
  visibleFields,
  clearedRewardFieldKeys,
  candidateFieldFor,
  needsFee,
  needsCommission,
  isGiftOnly,
  showsGiftDetails,
  showsGiftDispositionPicker,
  showsStartingFee,
  showsAdditiveGiftToggle,
  CAMPAIGN_TYPE_OPTIONS,
  type CompensationShape,
} from "./sections";
import type { CampaignType } from "../../../api/builderTypes";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const reward = getSection("rewardStructure");

/** Visible reward-field keys under a given shape. */
function rewardKeys(comp: CompensationShape): Set<string> {
  return new Set(visibleFields(reward, comp).map((f) => f.key));
}

function shape(campaignType: CampaignType, includesGifting = false): CompensationShape {
  return {
    campaignType,
    includesGifting,
    priceStrategy: "PROPOSE_STARTING_FEE",
  };
}

console.log("\nPLU-139 sections model\n");

// -- structure completeness --------------------------------------------------

test("exactly the six shipped Stage-1 substages, in worksheet order", () => {
  assert.deepEqual(
    SECTIONS.map((s) => s.key),
    [
      "startSources",
      "campaignProduct",
      "platformsDeliverables",
      "contentGuidelines",
      "timelineRights",
      "rewardStructure",
    ],
  );
});

test("the deferred/2b substages are absent (no Content Angles / negotiation / review)", () => {
  const keys = SECTIONS.map((s) => s.key).join(",");
  assert.ok(!/angle|negotiat|review/i.test(keys), "no substage 4/8/9 leaked in");
});

// -- Paid --------------------------------------------------------------------

test("Paid: shows fee + strategy, NO commission fields", () => {
  const k = rewardKeys(shape("PAID"));
  assert.ok(k.has("priceStrategy"), "shows price strategy");
  assert.ok(k.has("publicStartingFeeCents"), "shows starting fee (PROPOSE mode)");
  assert.ok(!k.has("publicCommissionRate"), "no commission rate");
  assert.ok(!k.has("commissionDurationDays"), "no commission duration");
});

test("Paid is NOT labeled 'non-negotiated' anywhere in the reward section", () => {
  // The whole model must never call Paid non-negotiated (every structure
  // negotiates — PLU-136). Scan all reward labels/hints/blurb + the type option.
  const haystack = [
    reward.blurb ?? "",
    ...reward.fields.flatMap((f) => [f.label, f.hint ?? ""]),
    ...CAMPAIGN_TYPE_OPTIONS.map((o) => o.label),
  ]
    .join(" ")
    .toLowerCase();
  assert.ok(!haystack.includes("non-negotiat"), "no 'non-negotiated' language");
  assert.ok(!haystack.includes("no negotiation"), "no 'no negotiation' language");
});

test("Paid infers nothing from fee sign — fee visibility is keyed on structure, not amount", () => {
  // needsFee is a pure function of the type; it never reads a fee value.
  assert.equal(needsFee("PAID"), true);
  assert.equal(needsFee("AFFILIATE"), false);
});

// -- Affiliate ---------------------------------------------------------------

test("Affiliate: shows commission, requires NO fee", () => {
  const k = rewardKeys(shape("AFFILIATE"));
  assert.ok(k.has("publicCommissionRate"), "shows commission rate");
  assert.ok(!k.has("priceStrategy"), "no price strategy");
  assert.ok(!k.has("publicStartingFeeCents"), "no starting fee");
  assert.equal(needsFee("AFFILIATE"), false);
});

// -- Hybrid ------------------------------------------------------------------

test("Hybrid: shows BOTH fee and commission", () => {
  const k = rewardKeys(shape("HYBRID"));
  assert.ok(k.has("priceStrategy") && k.has("publicStartingFeeCents"), "fee side present");
  assert.ok(k.has("publicCommissionRate") && k.has("commissionDurationDays"), "commission side present");
});

// -- Gift-only ---------------------------------------------------------------

test("Gift-only: gift details shown, NO fee/commission, disposition locked to KEEP", () => {
  const comp = shape("GIFT_ONLY");
  const k = rewardKeys(comp);
  assert.ok(k.has("rewardDescription"), "shows the gift/product field");
  assert.ok(!k.has("priceStrategy") && !k.has("publicStartingFeeCents"), "no fee");
  assert.ok(!k.has("publicCommissionRate"), "no commission");
  assert.equal(showsGiftDetails(comp), true);
  // Locked to KEEP → the disposition picker is hidden for gift-only.
  assert.equal(showsGiftDispositionPicker(comp), false);
  assert.equal(isGiftOnly("GIFT_ONLY"), true);
});

test("Gift-only: no additive-gift toggle (it's already all-gift)", () => {
  assert.equal(showsAdditiveGiftToggle("GIFT_ONLY"), false);
  assert.equal(rewardKeys(shape("GIFT_ONLY")).has("includesGifting"), false);
});

// -- additive gifting on Paid/Affiliate/Hybrid -------------------------------

test("additive gift on Paid: toggle available; turning it on reveals gift + disposition", () => {
  assert.equal(showsAdditiveGiftToggle("PAID"), true);
  const off = shape("PAID", false);
  const on = shape("PAID", true);
  assert.equal(rewardKeys(off).has("rewardDescription"), false, "gift hidden when off");
  assert.equal(rewardKeys(on).has("rewardDescription"), true, "gift shown when on");
  assert.equal(showsGiftDispositionPicker(on), true, "bonus gift shows disposition picker");
});

// -- price strategy conditional ----------------------------------------------

test("starting fee only shows in PROPOSE_STARTING_FEE mode", () => {
  assert.equal(showsStartingFee({ campaignType: "PAID", includesGifting: false, priceStrategy: "PROPOSE_STARTING_FEE" }), true);
  assert.equal(showsStartingFee({ campaignType: "PAID", includesGifting: false, priceStrategy: "REQUEST_RATE_CARD" }), false);
});

// -- switching structure hides AND clears ------------------------------------

test("switch Paid→Affiliate: fee fields become hidden and are cleared", () => {
  const cleared = new Set(clearedRewardFieldKeys(shape("AFFILIATE")));
  assert.ok(cleared.has("priceStrategy"), "priceStrategy cleared");
  assert.ok(cleared.has("publicStartingFeeCents"), "starting fee cleared");
  // and commission is NOT cleared (it's the visible side)
  assert.ok(!cleared.has("publicCommissionRate"), "commission stays");
});

test("switch to Gift-only clears BOTH fee and commission fields", () => {
  const cleared = new Set(clearedRewardFieldKeys(shape("GIFT_ONLY")));
  for (const key of ["priceStrategy", "publicStartingFeeCents", "publicCommissionRate", "commissionDurationDays", "commissionConditions"]) {
    assert.ok(cleared.has(key), `${key} cleared for gift-only`);
  }
  // gift fields are the visible side → not cleared
  assert.ok(!cleared.has("rewardDescription"), "gift description stays");
});

test("Hybrid clears nothing on the reward side (both sides visible)", () => {
  const cleared = clearedRewardFieldKeys(shape("HYBRID", true));
  // with additive gifting on, every reward field is visible
  assert.deepEqual(cleared, [], "hybrid + gift shows all reward fields");
});

test("no clear-list drift: every conditional reward field is clearable on switch", () => {
  // Guard against the REWARD_CLEAR_VALUES map falling out of sync with the
  // reward section's conditional fields. Any field with a visibleWhen predicate
  // CAN be hidden by a structure switch, so it MUST be sent cleared — i.e. it
  // must appear in the cleared set for at least one structure. campaignType
  // itself is the switch and always visible, so it's exempt.
  const structures: CompensationShape[] = [
    shape("PAID", false),
    shape("AFFILIATE", false),
    shape("GIFT_ONLY", false),
    { campaignType: "PAID", includesGifting: false, priceStrategy: "REQUEST_RATE_CARD" },
  ];
  const everCleared = new Set(structures.flatMap((s) => clearedRewardFieldKeys(s)));
  for (const f of reward.fields) {
    if (!f.visibleWhen) continue; // always-visible field, never needs clearing
    assert.ok(
      everCleared.has(f.key),
      `reward field "${f.key}" is conditional but never appears in the cleared set — add it to REWARD_CLEAR_VALUES`,
    );
  }
});

test("turning additive gift OFF clears the gift fields", () => {
  const cleared = new Set(clearedRewardFieldKeys(shape("PAID", false)));
  assert.ok(cleared.has("rewardDescription"), "gift description cleared");
  assert.ok(cleared.has("giftDisposition"), "disposition cleared");
  assert.ok(cleared.has("shipsPhysicalProduct"), "ships flag cleared");
});

// -- field→group mapping is in-contract --------------------------------------

test("every field maps to a real persisted group", () => {
  const groups = new Set(["campaign", "brandIdentity", "creatorRequirement"]);
  for (const s of SECTIONS) {
    for (const f of s.fields) {
      assert.ok(groups.has(f.group), `${s.key}.${f.key} has a valid group`);
    }
  }
});

// -- brief-import candidate mapping ------------------------------------------

test("candidateFieldFor maps known parser keys to their editable campaign field", () => {
  // These parser section keys share the name of an editable campaign text field.
  for (const key of ["usageRights", "exclusivity", "paymentTerms", "attributionWindow", "deliverables"]) {
    const f = candidateFieldFor(key);
    assert.ok(f, `"${key}" should map to a field`);
    assert.equal(f!.key, key);
    assert.equal(f!.group, "campaign");
  }
});

test("candidateFieldFor returns null for unmapped / non-applicable keys", () => {
  // Unknown key → no Apply target (shown as read-only evidence).
  assert.equal(candidateFieldFor("somethingWeDontModel"), null);
  // name/brand are readOnly → never an apply target even though they exist.
  assert.equal(candidateFieldFor("name"), null);
  assert.equal(candidateFieldFor("brand"), null);
  // radioCards/select/toggle fields aren't text candidates.
  assert.equal(candidateFieldFor("campaignType"), null);
  assert.equal(candidateFieldFor("includesGifting"), null);
});

console.log(`\n${passed} passed\n`);
