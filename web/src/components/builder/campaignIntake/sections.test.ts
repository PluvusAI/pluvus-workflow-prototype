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
  missingRequiredKeys,
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
  DELIVERABLE_CARDS,
  type CompensationShape,
  type FieldSpec,
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

function shape(
  campaignType: CampaignType,
  includesGifting = false,
  giftDeliveryMethod = "",
  selectedPlatforms: string[] = [],
): CompensationShape {
  return {
    campaignType,
    includesGifting,
    priceStrategy: "PROPOSE_STARTING_FEE",
    giftDeliveryMethod,
    selectedPlatforms,
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
  assert.equal(showsStartingFee({ campaignType: "PAID", includesGifting: false, priceStrategy: "PROPOSE_STARTING_FEE", giftDeliveryMethod: "", selectedPlatforms: [] }), true);
  assert.equal(showsStartingFee({ campaignType: "PAID", includesGifting: false, priceStrategy: "REQUEST_RATE_CARD", giftDeliveryMethod: "", selectedPlatforms: [] }), false);
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

test("Hybrid clears nothing on the reward side when all conditionals resolve", () => {
  // Fee + commission both apply (Hybrid), gifting on, AND a gift-delivery method
  // chosen so promo-code shows — every reward field is then visible.
  const cleared = clearedRewardFieldKeys(shape("HYBRID", true, "promo_code"));
  // giftContactEmail is the OTHER path (manual_contact), so it's still hidden.
  assert.deepEqual(cleared, ["giftContactEmail"], "only the unused gift path is cleared");
});

test("gift-delivery path: choosing promo_code clears the manual-contact field and vice versa", () => {
  const promo = new Set(clearedRewardFieldKeys(shape("GIFT_ONLY", false, "promo_code")));
  assert.ok(promo.has("giftContactEmail"), "manual-contact field cleared under promo_code");
  assert.ok(!promo.has("promoCode"), "promo code stays under promo_code");
  const manual = new Set(clearedRewardFieldKeys(shape("GIFT_ONLY", false, "manual_contact")));
  assert.ok(manual.has("promoCode"), "promo code cleared under manual_contact");
  assert.ok(!manual.has("giftContactEmail"), "contact email stays under manual_contact");
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
    shape("GIFT_ONLY", false), // no gift-delivery method → promo/contact both cleared
    { campaignType: "PAID", includesGifting: false, priceStrategy: "REQUEST_RATE_CARD", giftDeliveryMethod: "", selectedPlatforms: [] },
  ];
  const everCleared = new Set(structures.flatMap((s) => clearedRewardFieldKeys(s)));
  for (const f of reward.fields) {
    if (!f.visibleWhen) continue; // always-visible field, never needs clearing
    if (f.display) continue; // display-only (no column) — nothing to clear
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

// -- worksheet Stage-1 coverage ----------------------------------------------

test("every non-deferred worksheet Stage-1 question is covered by a field", () => {
  // The union of all worksheet IDs any field cites in `source` (ranges like
  // "S3.1–S3.9" and multi like "S6.3/S6.5" expand to each member).
  const cited = new Set<string>();
  for (const s of SECTIONS) {
    for (const f of s.fields) {
      // Split on / and en-dash ranges; keep S<page>.<id> tokens.
      const raw = f.source.replace(/–/g, "-");
      for (const part of raw.split(/[/,]/)) {
        const m = part.trim().match(/^S(\d)\.([A-Za-z0-9]+)(?:-S?\d?\.?([A-Za-z0-9]+))?/);
        if (!m) continue;
        const page = m[1] ?? "";
        const start = m[2] ?? "";
        const end = m[3];
        cited.add(`S${page}.${start}`);
        // Expand a numeric range like S3.1-S3.9 → S3.1..S3.9.
        if (end && /^\d+$/.test(start) && /^\d+$/.test(end)) {
          for (let i = Number(start); i <= Number(end); i++) cited.add(`S${page}.${i}`);
        }
      }
    }
  }
  // The worksheet's Stage-1 public questions, EXCLUDING the ones that are
  // deliberately out of scope: S1.C* + S4.* (Content Angles, deferred), S1.5/S1.6
  // (system actions, not fields), S2.2 sub-rows handled by BrandIdentity.
  const required = [
    "S1.1", "S1.2", "S1.4",
    "S2.1", "S2.3", "S2.4", "S2.5", "S2.6", "S2.7", "S2.8", "S2.9", "S2.10",
    "S3.1", "S3.10", "S3.11",
    "S5.1", "S5.2", "S5.3",
    "S6.1", "S6.2", "S6.3", "S6.4", "S6.5", "S6.6",
    "S7.1", "S7.2", "S7.3",
    "S7.A1", "S7.A2", "S7.A3", "S7.A4",
    "S7.G1", "S7.G3", "S7.G5", "S7.G6", "S7.G7",
    "S7.P1", "S7.P2",
    "S7.T0", "S7.T1", "S7.T2", "S7.T3",
  ];
  const missing = required.filter((id) => !cited.has(id));
  assert.deepEqual(missing, [], `uncovered worksheet Stage-1 questions: ${missing.join(", ")}`);
});

// -- brief-import candidate mapping ------------------------------------------

test("candidateFieldFor maps known parser keys to their editable campaign field", () => {
  // Free-text-backed fields (text/textarea/richText/repeatableLinks) can accept
  // extracted brief text. deliverables/contentRequirements/keyMessages qualify.
  for (const key of ["deliverables", "contentRequirements", "keyMessages"]) {
    const f = candidateFieldFor(key);
    assert.ok(f, `"${key}" should map to a field`);
    assert.equal(f!.key, key);
    assert.equal(f!.group, "campaign");
  }
});

test("candidateFieldFor returns null for unmapped / non-applicable keys", () => {
  // Unknown key → no Apply target (shown as read-only evidence).
  assert.equal(candidateFieldFor("somethingWeDontModel"), null);
  // PLU-139 (B): prohibitedClaims was dropped (off-worksheet) — the parser may
  // still emit a "restrictions" section but it has no field to apply into now.
  assert.equal(candidateFieldFor("prohibitedClaims"), null);
  // name/brand are campaign identity, not brief content → never an apply target
  // (editable on page 1, but a brief import must not retarget them).
  assert.equal(candidateFieldFor("name"), null);
  assert.equal(candidateFieldFor("brand"), null);
  // Closed-set controls aren't free-text candidates — the worksheet-spec pass
  // moved these off text controls (durationSelect/attributionWindow/radioCards).
  assert.equal(candidateFieldFor("usageRights"), null); // durationSelect (S6.5)
  assert.equal(candidateFieldFor("exclusivity"), null); // durationSelect (S6.6)
  assert.equal(candidateFieldFor("paymentTerms"), null); // radioCards (S7.P2)
  assert.equal(candidateFieldFor("attributionWindow"), null); // attributionWindow (S7.A4)
  // radioCards/select/toggle fields aren't text candidates.
  assert.equal(candidateFieldFor("campaignType"), null);
  assert.equal(candidateFieldFor("includesGifting"), null);
});

// -- deliverable cards (S3.2–S3.9) -------------------------------------------

test("DELIVERABLE_CARDS are the 8 worksheet cards, in order, with unique keys", () => {
  const expected = [
    ["instagram", "reel", "S3.2"],
    ["instagram", "carousel", "S3.3"],
    ["tiktok", "video", "S3.4"],
    ["youtube", "dedicated", "S3.5"],
    ["youtube", "integrated", "S3.6"],
    ["linkedin", "post", "S3.7"],
    ["linkedin", "video", "S3.8"],
    ["twitter", "post", "S3.9"],
  ];
  assert.equal(DELIVERABLE_CARDS.length, 8);
  DELIVERABLE_CARDS.forEach((c, i) => {
    assert.equal(c.platform, expected[i]![0]);
    assert.equal(c.format, expected[i]![1]);
    assert.equal(c.source, expected[i]![2]);
    assert.ok(c.label.length > 0, "card has a label");
  });
  // platform+format pair (the stored key) must be unique across all 8.
  const keys = new Set(DELIVERABLE_CARDS.map((c) => `${c.platform}:${c.format}`));
  assert.equal(keys.size, 8, "no duplicate platform/format pairs");
});

// -- S6.7 Instagram-collab conditional (gated on selected platforms) ---------

test("S6.7 Instagram collab shows only when Instagram is a selected platform", () => {
  const timeline = getSection("timelineRights");
  const withIg = shape("PAID", false, "", ["instagram", "tiktok"]);
  const withoutIg = shape("PAID", false, "", ["tiktok", "youtube"]);
  const noneSelected = shape("PAID"); // selectedPlatforms defaults to []
  assert.ok(
    visibleFields(timeline, withIg).some((f) => f.key === "instagramCollab"),
    "shown when Instagram selected",
  );
  assert.ok(
    !visibleFields(timeline, withoutIg).some((f) => f.key === "instagramCollab"),
    "hidden when Instagram not selected",
  );
  assert.ok(
    !visibleFields(timeline, noneSelected).some((f) => f.key === "instagramCollab"),
    "hidden when no platforms selected yet",
  );
});

// -- Page 5/6 columns now have dedicated fields ------------------------------

test("Page 5 granular brief fields (S5.2/S5.4/S5.5/S5.6) each have their own field", () => {
  const guidelines = getSection("contentGuidelines");
  const bySource = new Set(guidelines.fields.map((f) => f.source));
  for (const id of ["S5.2", "S5.4", "S5.5", "S5.6", "S5.7"]) {
    assert.ok(bySource.has(id), `${id} has a dedicated field`);
  }
  // contentRequirements is now S5.7 only — no longer the S5.2/S5.4 catch-all.
  const cr = guidelines.fields.find((f) => f.key === "contentRequirements");
  assert.equal(cr?.source, "S5.7", "contentRequirements maps to S5.7 alone");
});

test("Page 6 ad authorization (S6.3) is split out from repurpose rights (S6.5)", () => {
  const timeline = getSection("timelineRights");
  const adAuth = timeline.fields.find((f) => f.key === "adAuthorization");
  const usage = timeline.fields.find((f) => f.key === "usageRights");
  assert.equal(adAuth?.source, "S6.3", "adAuthorization maps to S6.3");
  assert.equal(usage?.source, "S6.5", "usageRights now maps to S6.5 alone (un-merged)");
});

// -- worksheet-spec controls (interaction/component matches the worksheet) ----

test("each field renders the control the worksheet specifies", () => {
  // key → expected control, per docs/campaign-question-review-worksheet.md.
  const expected: Record<string, string> = {
    name: "text", // S1.1 (+ maxCount counter)
    productType: "searchableSelect", // S2.4 searchable dropdown
    creatorAccessNeeded: "radioCards", // S2.5 two radio cards
    howToUse: "richText", // S2.9 rich-text
    brandAssets: "richText", // S2.10 rich-text/link
    minFollowers: "followerRanges", // S3.11 per-platform ranges
    briefDeliveryMethod: "radioCards", // S5.1 radio cards
    briefHighlight: "richText", // S5.2
    creativeConcept: "richText", // S5.4
    referenceVideos: "repeatableLinks", // S5.5 repeatable multi-link
    scriptSubmission: "radioCards", // S5.6
    contentRequirements: "richText", // S5.7
    timeline: "durationSelect", // S6.1
    linkInBioDuration: "durationSelect", // S6.2
    adAuthorization: "durationSelect", // S6.3
    postRetention: "durationSelect", // S6.4
    usageRights: "durationSelect", // S6.5
    exclusivity: "durationSelect", // S6.6
    instagramCollab: "radioCards", // S6.7 (No/Yes)
    priceStrategy: "radioCards", // S7.P1
    publicStartingFeeCents: "pricingGrid", // S7.P1 grid
    paymentTerms: "radioCards", // S7.P2 three cards
    publicCommissionRate: "commissionAmount", // S7.A1 number + %/flat
    variableCommission: "radioCards", // S7.A3 segmented
    attributionWindow: "attributionWindow", // S7.A4
    giftDeliveryMethod: "radioCards", // S7.G1
    giftDisposition: "radioCards", // S7.G5
    shipsPhysicalProduct: "radioCards", // S7.G6
    trackingLinkMode: "radioCards", // S7.T1
    trackingParameter: "select", // S7.T3 dropdown w/ default
    trackingPreview: "trackingPreview", // S7.T4
  };
  const byKey = new Map<string, string>();
  for (const s of SECTIONS) for (const f of s.fields) byKey.set(f.key, f.control);
  for (const [key, control] of Object.entries(expected)) {
    assert.equal(byKey.get(key), control, `${key} should render "${control}"`);
  }
});

test("S1.1 campaign name carries the 50-char counter (maxCount)", () => {
  const name = getSection("startSources").fields.find((f) => f.key === "name");
  assert.equal(name?.maxCount, 50);
});

test("trackingPreview is display-only (no persistence, excluded from clear set)", () => {
  const f = getSection("rewardStructure").fields.find((k) => k.key === "trackingPreview");
  assert.equal(f?.display, true);
  // not in any structure's cleared set (it has no column to clear)
  assert.ok(!clearedRewardFieldKeys(shape("AFFILIATE")).includes("trackingPreview"));
});

// -- required-field gate (Save & continue enforcement) -----------------------

// A value reader over a plain {key: value} map, defaulting missing keys to "".
function valuesFrom(map: Record<string, unknown>): (f: FieldSpec) => unknown {
  return (f) => (f.key in map ? map[f.key] : "");
}

test("missingRequiredKeys: empty visible required fields are flagged", () => {
  // campaignProduct has required productName (S2.3), brandDescription (S2.6),
  // productType (S2.4). All empty → all three flagged.
  const section = getSection("campaignProduct");
  const missing = missingRequiredKeys(section, shape("PAID"), valuesFrom({}));
  assert.ok(missing.includes("productName"), "productName flagged");
  assert.ok(missing.includes("brandDescription"), "brandDescription flagged");
  assert.ok(missing.includes("productType"), "productType flagged");
});

test("missingRequiredKeys: filled required fields pass; optional empties never flag", () => {
  const section = getSection("campaignProduct");
  // Fill EVERY required field of the section (derived from the model, so this
  // stays correct if PLU-159 adds/removes a required field), leave optionals blank.
  const filled: Record<string, unknown> = {};
  for (const f of section.fields) if (f.required && !f.readOnly) filled[f.key] = "x";
  const missing = missingRequiredKeys(section, shape("PAID"), valuesFrom(filled));
  assert.deepEqual(missing, [], "no required field missing → gate passes");
});

test("missingRequiredKeys: name/brand are demanded on page 1 (editable, required)", () => {
  // startSources requires name (S1.1), brand (P1.2/P2.2), and targetUrl (S1.2) —
  // all editable in the intake now (no create-time modal), so a blank page 1
  // blocks Save & continue on all three.
  const section = getSection("startSources");
  const missing = missingRequiredKeys(section, shape("PAID"), valuesFrom({}));
  assert.deepEqual(
    [...missing].sort(),
    ["brand", "name", "targetUrl"],
    "all three editable required fields are demanded",
  );
});

test("missingRequiredKeys: a hidden required field is NOT demanded until its branch shows", () => {
  // promoCode (S7.G2) is required but only visible under GIFT + promo_code. On a
  // plain Paid campaign it's hidden → must not block the gate.
  const reward = getSection("rewardStructure");
  const paid = missingRequiredKeys(reward, shape("PAID"), valuesFrom({ campaignType: "PAID" }));
  assert.ok(!paid.includes("promoCode"), "hidden promoCode not demanded on Paid");

  // Now Gift-only + promo_code path → promoCode is visible & empty → demanded.
  const gift = missingRequiredKeys(
    reward,
    shape("GIFT_ONLY", false, "promo_code"),
    valuesFrom({ campaignType: "GIFT_ONLY", rewardDescription: "A free box", giftDeliveryMethod: "promo_code" }),
  );
  assert.ok(gift.includes("promoCode"), "visible+empty promoCode demanded under promo path");
});

test("missingRequiredKeys: empty array (no deliverable cards picked) counts as missing", () => {
  // deliverableQuantities (S3.1–S3.9) is required; an empty array must flag.
  const section = getSection("platformsDeliverables");
  const empty = missingRequiredKeys(section, shape("PAID"), valuesFrom({ deliverableQuantities: [] }));
  assert.ok(empty.includes("deliverableQuantities"), "empty deliverables flagged");
  const filled = missingRequiredKeys(
    section,
    shape("PAID"),
    valuesFrom({ deliverableQuantities: [{ platform: "instagram", format: "reel", quantity: 1 }] }),
  );
  assert.ok(!filled.includes("deliverableQuantities"), "non-empty deliverables pass");
});

console.log(`\n${passed} passed\n`);
