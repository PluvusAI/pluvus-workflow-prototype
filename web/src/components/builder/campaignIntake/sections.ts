// ---------------------------------------------------------------------------
// PLU-139 (2a) — Stage-1 Campaign Brief: declarative section/field model
// ---------------------------------------------------------------------------
// This file is the SINGLE STRUCTURAL EDIT POINT for the sectioned campaign-brief
// intake. CampaignIntake.tsx renders whatever this file declares; it holds no
// per-field knowledge of its own. When PLU-159's approved design/copy lands, the
// handoff is applied HERE (rename labels, reorder, add/remove fields, retune the
// conditionals) without touching the wizard shell.
//
// Scope: the six PUBLIC brief substages that map to the shipped PR-A1 APIs —
//   1. Start & sources          → campaign scalars (name/brand/targetUrl)
//   2. Campaign & product       → CampaignDetails + BrandIdentity
//   3. Platforms & deliverables → CampaignDetails.deliverables + CreatorRequirement
//   5. Content guidelines       → CampaignDetails content free-text fields
//   6. Timeline & rights        → CampaignDetails rights/timeline fields
//   7. Reward structure         → CampaignDetails compensation (+ conditionals)
// Substage 4 (Content Angles) is DEFERRED per the worksheet; substages 8/9
// (Private negotiation settings, Review) belong to PLU-140 (2b). Not here.
//
// ⚠️ COPY: every user-facing string in this file is PLACEHOLDER, invented to make
// the flow legible before PLU-159. Each is marked `// COPY:PLU-159`. None of it
// redefines commercial/legal semantics — the field→API mapping is the contract;
// the words are not.
//
// The worksheet question ID each field derives from is noted (e.g. S2.3) so the
// reviewer can trace every control back to docs/campaign-question-review-
// worksheet.md.

import type {
  CampaignType,
  GiftDisposition,
  PriceStrategy,
} from "../../../api/builderTypes";

// ---------------------------------------------------------------------------
// Which persisted group a field lives in. Each maps to one PR-A1 endpoint:
//   campaign          → PATCH /campaigns/:id            (scalars + CampaignDetails)
//   brandIdentity     → PATCH /campaigns/:id/brand-identity
//   creatorRequirement→ PATCH /campaigns/:id/creator-requirement
// ---------------------------------------------------------------------------
export type FieldGroup = "campaign" | "brandIdentity" | "creatorRequirement";

export type SectionKey =
  | "startSources"
  | "campaignProduct"
  | "platformsDeliverables"
  | "contentGuidelines"
  | "timelineRights"
  | "rewardStructure";

// The compensation-shape inputs the reward-structure conditionals key on. This
// is the ONLY state the visibility predicates read — keep it minimal so the
// "single edit point" stays legible.
export interface CompensationShape {
  campaignType: CampaignType;
  includesGifting: boolean;
  priceStrategy: PriceStrategy;
}

export type FieldControl =
  | "text"
  | "textarea"
  | "url"
  | "email"
  | "number"
  | "money" // number in dollars; the shell converts to cents for publicStartingFeeCents
  | "select"
  | "toggle"
  | "chips" // comma/enter-separated string[] (CreatorRequirement.platforms etc.)
  | "radioCards"; // RadioCardGroup

export interface SelectOption {
  value: string;
  label: string; // COPY:PLU-159
}

export interface FieldSpec {
  /** Stable key. For group "campaign" this is the PATCH body key
   *  (e.g. "deliverables", "publicStartingFeeCents"); for the two sub-groups it
   *  is the *Input key (e.g. "primaryColor", "platforms"). */
  key: string;
  group: FieldGroup;
  control: FieldControl;
  label: string; // COPY:PLU-159
  hint?: string; // COPY:PLU-159
  placeholder?: string; // COPY:PLU-159
  options?: SelectOption[]; // for select / radioCards
  /** Worksheet question id this derives from, for review traceability. */
  source: string;
  /** Show only when this predicate holds (reward-structure conditionals). */
  visibleWhen?: (comp: CompensationShape) => boolean;
  /** number/money bounds — validated in the shell, mirrored from create wizard. */
  min?: number;
  max?: number;
  /** Set at create and not in the PATCH surface — shown but never editable in
   *  the brief editor (e.g. name/brand). Distinct from the lifecycle read-only
   *  lock, which disables everything once the campaign is ACTIVE. */
  readOnly?: boolean;
}

export interface SectionSpec {
  key: SectionKey;
  title: string; // COPY:PLU-159
  /** One-line orientation under the section heading. */
  blurb?: string; // COPY:PLU-159
  fields: FieldSpec[];
}

// ---------------------------------------------------------------------------
// Reward-structure derivations — the ONE place structure→field logic lives.
// Mirrors validateCompensationReadiness() server-side and the create wizard's
// needsFee/needsCommission/isGiftOnly flags, kept pure so tests can assert them
// directly. Worksheet Page 7:
//   Paid       → fee + strategy, no commission
//   Affiliate  → commission, no fee
//   Hybrid     → both
//   Gift-only  → gift, no fee/commission
//   additive-gift toggle applies to the first three (S7.2)
// ---------------------------------------------------------------------------
export function needsFee(t: CampaignType): boolean {
  return t === "PAID" || t === "HYBRID";
}
export function needsCommission(t: CampaignType): boolean {
  return t === "AFFILIATE" || t === "HYBRID";
}
export function isGiftOnly(t: CampaignType): boolean {
  return t === "GIFT_ONLY";
}
/** The additive-gift toggle only exists for the non-gift-only structures; GIFT_ONLY
 *  is already all-gift. */
export function showsAdditiveGiftToggle(t: CampaignType): boolean {
  return !isGiftOnly(t);
}
/** Gift detail fields show for GIFT_ONLY or when additive gifting is on. */
export function showsGiftDetails(comp: CompensationShape): boolean {
  return isGiftOnly(comp.campaignType) || comp.includesGifting;
}
/** The disposition picker is only meaningful for a BONUS gift; GIFT_ONLY is
 *  locked to KEEP (the product is the entire payment). Mirrors the create wizard. */
export function showsGiftDispositionPicker(comp: CompensationShape): boolean {
  return comp.includesGifting && !isGiftOnly(comp.campaignType);
}
export function showsStartingFee(comp: CompensationShape): boolean {
  return needsFee(comp.campaignType) && comp.priceStrategy === "PROPOSE_STARTING_FEE";
}

export const CAMPAIGN_TYPE_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — labels only; the values are the PLU-136 contract enum.
  { value: "PAID", label: "Paid — upfront fee" },
  { value: "AFFILIATE", label: "Affiliate — commission only" },
  { value: "HYBRID", label: "Hybrid — fee + commission" },
  { value: "GIFT_ONLY", label: "Gift only — the product is the payment" },
];

export const PRICE_STRATEGY_OPTIONS: SelectOption[] = [
  // COPY:PLU-159
  { value: "REQUEST_RATE_CARD", label: "Ask the creator for their rate card" },
  { value: "PROPOSE_STARTING_FEE", label: "Propose a starting fee" },
];

export const GIFT_DISPOSITION_OPTIONS: SelectOption[] = [
  // COPY:PLU-159
  { value: "KEEP", label: "Creator keeps it" },
  { value: "LOAN", label: "Loaned — used, then returned" },
  { value: "RETURN", label: "Returned after the campaign" },
];

// ---------------------------------------------------------------------------
// The sections. Order = left-rail order = worksheet page order (4 skipped).
// ---------------------------------------------------------------------------
export const SECTIONS: SectionSpec[] = [
  {
    key: "startSources",
    title: "Start & sources", // COPY:PLU-159
    blurb:
      // COPY:PLU-159 — the extraction half (upload → AI prefill) is PR-B; this
      // substage is the manual-first entry only.
      "Name the campaign and point us at the product page. You can start manually now — brief/brand-material extraction comes later.",
    fields: [
      {
        key: "name",
        group: "campaign",
        control: "text",
        label: "Campaign name", // COPY:PLU-159
        hint: "Set when the campaign was created.", // COPY:PLU-159
        placeholder: "e.g. Summer 2026 Launch", // COPY:PLU-159
        source: "S1.1",
        readOnly: true,
      },
      {
        key: "brand",
        group: "campaign",
        control: "text",
        label: "Brand", // COPY:PLU-159
        hint: "Set when the campaign was created.", // COPY:PLU-159
        placeholder: "e.g. Acme Co", // COPY:PLU-159
        source: "P1.2/P2.2",
        readOnly: true,
      },
      {
        key: "targetUrl",
        group: "campaign",
        control: "url",
        label: "Product or campaign page", // COPY:PLU-159
        hint: "The page creators link to. Prefer a product-specific page; a service/company page is fine when there's no product page.", // COPY:PLU-159
        placeholder: "e.g. https://example.com/shop", // COPY:PLU-159
        source: "S1.2",
      },
    ],
  },
  {
    key: "campaignProduct",
    title: "Campaign & product", // COPY:PLU-159
    blurb: "The standardized facts every reward structure shares.", // COPY:PLU-159
    fields: [
      {
        key: "objective",
        group: "campaign",
        control: "textarea",
        label: "Campaign background / goal", // COPY:PLU-159
        placeholder: "e.g. Drive awareness for the new running-shoe line.", // COPY:PLU-159
        source: "S2.1",
      },
      {
        key: "brandDescription",
        group: "campaign",
        control: "textarea",
        label: "Product introduction", // COPY:PLU-159
        hint: "What the brand does or sells. The agent uses this to answer creator questions without inventing anything.", // COPY:PLU-159
        placeholder:
          "e.g. Avatar is a fintech app that helps Gen Z track spending and build credit.", // COPY:PLU-159
        source: "S2.3/S2.6",
      },
      // BrandIdentity sub-group (its own endpoint).
      {
        key: "logoRef",
        group: "brandIdentity",
        control: "text",
        label: "Product logo reference", // COPY:PLU-159
        hint: "A stored reference to the logo asset. Upload wiring is PR-B; this is the manual field for now.", // COPY:PLU-159
        source: "S2.2",
      },
      {
        key: "primaryColor",
        group: "brandIdentity",
        control: "text",
        label: "Primary brand color", // COPY:PLU-159
        placeholder: "e.g. #F0603C", // COPY:PLU-159
        source: "S2.2 (brand identity)",
      },
      {
        key: "secondaryColor",
        group: "brandIdentity",
        control: "text",
        label: "Secondary brand color", // COPY:PLU-159
        placeholder: "e.g. #17140F", // COPY:PLU-159
        source: "S2.2 (brand identity)",
      },
      {
        key: "typography",
        group: "brandIdentity",
        control: "text",
        label: "Typography", // COPY:PLU-159
        placeholder: "e.g. Inter / Fraunces", // COPY:PLU-159
        source: "S2.2 (brand identity)",
      },
    ],
  },
  {
    key: "platformsDeliverables",
    title: "Platforms, deliverables & creator requirements", // COPY:PLU-159
    blurb:
      "What content you're requesting, plus the informational creator criteria used later for sourcing.", // COPY:PLU-159
    fields: [
      {
        key: "deliverables",
        group: "campaign",
        control: "textarea",
        label: "Deliverables", // COPY:PLU-159
        hint: "What the creator produces. The agent states this as the agreed scope. Leave blank to finalize with the creator.", // COPY:PLU-159
        placeholder:
          "e.g. 3 Instagram Reels + 1 YouTube integration, 30-day usage rights.", // COPY:PLU-159
        source: "S3.1–S3.9",
      },
      // CreatorRequirement sub-group (its own endpoint). Informational only —
      // never drives matching/ranking/outreach (per the field's server doc).
      {
        key: "platforms",
        group: "creatorRequirement",
        control: "chips",
        label: "Platforms", // COPY:PLU-159
        hint: "Comma-separated. e.g. instagram, tiktok, youtube.", // COPY:PLU-159
        source: "S3.1",
      },
      {
        key: "niches",
        group: "creatorRequirement",
        control: "chips",
        label: "Niches", // COPY:PLU-159
        hint: "Comma-separated. e.g. fitness, running, wellness.", // COPY:PLU-159
        source: "S3 (creator criteria)",
      },
      {
        key: "geography",
        group: "creatorRequirement",
        control: "chips",
        label: "Countries / markets", // COPY:PLU-159
        hint: "Comma-separated. e.g. US, CA, UK.", // COPY:PLU-159
        source: "S3.10",
      },
      {
        key: "languages",
        group: "creatorRequirement",
        control: "chips",
        label: "Languages", // COPY:PLU-159
        hint: "Comma-separated. e.g. en, es.", // COPY:PLU-159
        source: "S3 (creator criteria)",
      },
      {
        key: "minFollowers",
        group: "creatorRequirement",
        control: "number",
        label: "Minimum followers", // COPY:PLU-159
        hint: "Any follower floor for creators. Leave blank for no minimum.", // COPY:PLU-159
        placeholder: "e.g. 10000", // COPY:PLU-159
        min: 0,
        // Server rejects int4 overflow (PLU-139 Greptile fix); keep under 2^31-1.
        max: 2147483647,
        source: "S3.11",
      },
      {
        key: "audienceNotes",
        group: "creatorRequirement",
        control: "textarea",
        label: "Audience notes", // COPY:PLU-159
        placeholder: "e.g. Skews 18–24, urban, sneaker-culture.", // COPY:PLU-159
        source: "S3 (creator criteria)",
      },
      {
        key: "contentStyle",
        group: "creatorRequirement",
        control: "textarea",
        label: "Content style", // COPY:PLU-159
        placeholder: "e.g. High-energy, authentic, day-in-the-life.", // COPY:PLU-159
        source: "S3 (creator criteria)",
      },
      {
        key: "brandSafety",
        group: "creatorRequirement",
        control: "textarea",
        label: "Brand safety", // COPY:PLU-159
        placeholder: "e.g. No profanity; no competing footwear brands.", // COPY:PLU-159
        source: "S3 (creator criteria)",
      },
    ],
  },
  {
    key: "contentGuidelines",
    title: "Content guidelines", // COPY:PLU-159
    blurb:
      // COPY:PLU-159 — the shipped CampaignDetails has NO dedicated content-brief
      // columns (briefHighlight/coreMessage/creativeConcept from worksheet Page 5
      // don't exist yet); this substage collects the guideline as free text on the
      // fields that DO exist. Flagged for PLU-159/backend follow-up.
      "Creative direction for the content. (Structured brief fields from worksheet Page 5 aren't in the data model yet — this collects guidelines as notes for now.)",
    fields: [
      {
        key: "notes",
        group: "campaign",
        control: "textarea",
        label: "Content requirements & guidelines", // COPY:PLU-159
        hint: "Content restrictions, music/sound, subtitles, core message, tone. Structured fields land with PLU-159's brief builder.", // COPY:PLU-159
        placeholder:
          "e.g. Show the product in use in the first 3 seconds. No competitor mentions. Add captions.", // COPY:PLU-159
        source: "S5.2–S5.7",
      },
    ],
  },
  {
    key: "timelineRights",
    title: "Timeline & rights", // COPY:PLU-159
    blurb:
      "Timing and the usage-rights / exclusivity terms that apply across every reward structure. Broader rights may raise creator pricing.", // COPY:PLU-159
    fields: [
      {
        key: "timeline",
        group: "campaign",
        control: "text",
        label: "Timeline / post deadline", // COPY:PLU-159
        hint: "When content should go live. The agent only states a timeline you provide — it never invents dates.", // COPY:PLU-159
        placeholder: "e.g. Content live by September 15, 2026", // COPY:PLU-159
        source: "S6.1",
      },
      {
        key: "usageRights",
        group: "campaign",
        control: "textarea",
        label: "Usage / repurpose rights", // COPY:PLU-159
        hint: "Permission to reuse the content beyond the original post (your channels, paid media). Blank = original post only.", // COPY:PLU-159
        placeholder: "e.g. 90 days of paid-ad usage on brand channels.", // COPY:PLU-159
        source: "S6.3/S6.5",
      },
      {
        key: "exclusivity",
        group: "campaign",
        control: "textarea",
        label: "Exclusivity", // COPY:PLU-159
        hint: "How long before the creator may work with a competing brand. Blank = none.", // COPY:PLU-159
        placeholder: "e.g. 30 days, no competing footwear brands.", // COPY:PLU-159
        source: "S6.6",
      },
    ],
  },
  {
    key: "rewardStructure",
    title: "Reward structure", // COPY:PLU-159
    blurb:
      "How creators are rewarded. The public offer only — private negotiation limits are a separate step (PLU-140).", // COPY:PLU-159
    fields: [
      {
        key: "campaignType",
        group: "campaign",
        control: "radioCards",
        label: "How will creators be rewarded?", // COPY:PLU-159
        options: CAMPAIGN_TYPE_OPTIONS,
        source: "S7.1",
      },
      // Paid / Hybrid — fee + strategy.
      {
        key: "priceStrategy",
        group: "campaign",
        control: "select",
        label: "Price strategy", // COPY:PLU-159
        hint: "Propose a starting number, or ask the creator for their rate card first.", // COPY:PLU-159
        options: PRICE_STRATEGY_OPTIONS,
        source: "S7.P1",
        visibleWhen: (c) => needsFee(c.campaignType),
      },
      {
        key: "publicStartingFeeCents",
        group: "campaign",
        control: "money",
        label: "Starting fee offer ($)", // COPY:PLU-159
        hint: "The public starting number shown to the creator — still negotiable unless marked fixed in the negotiation policy.", // COPY:PLU-159
        placeholder: "e.g. 500", // COPY:PLU-159
        min: 0,
        source: "S7.P1",
        visibleWhen: showsStartingFee,
      },
      // Affiliate / Hybrid — commission.
      {
        key: "publicCommissionRate",
        group: "campaign",
        control: "number",
        label: "Commission rate (%)", // COPY:PLU-159
        hint: "The public commission rate shown to the creator.", // COPY:PLU-159
        placeholder: "e.g. 15", // COPY:PLU-159
        min: 0,
        max: 100,
        source: "S7.A1",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      {
        key: "commissionDurationDays",
        group: "campaign",
        control: "number",
        label: "Commission duration (days)", // COPY:PLU-159
        hint: "How long the commission window runs. Leave blank if not applicable.", // COPY:PLU-159
        placeholder: "e.g. 30", // COPY:PLU-159
        min: 1,
        source: "S7.A2",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      {
        key: "commissionConditions",
        group: "campaign",
        control: "textarea",
        label: "Commission conditions", // COPY:PLU-159
        placeholder: "e.g. applies to first-time customers only", // COPY:PLU-159
        source: "S7.A2",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      // Gift — additive toggle (Paid/Affiliate/Hybrid) or implied (Gift-only).
      {
        key: "includesGifting",
        group: "campaign",
        control: "toggle",
        label: "Also include a gifted product?", // COPY:PLU-159
        hint: "When on, a product is part of the reward on top of any fee/commission.", // COPY:PLU-159
        source: "S7.2",
        visibleWhen: (c) => showsAdditiveGiftToggle(c.campaignType),
      },
      {
        key: "rewardDescription",
        group: "campaign",
        control: "textarea",
        label: "Product / gift", // COPY:PLU-159
        hint: "Describe the product the creator receives. For gift-only this IS their payment (kept, not returned).", // COPY:PLU-159
        placeholder: "e.g. a free pair of our latest running shoes (retail $140)", // COPY:PLU-159
        source: "S7.G3",
        visibleWhen: showsGiftDetails,
      },
      {
        key: "giftDisposition",
        group: "campaign",
        control: "select",
        label: "What happens to the product?", // COPY:PLU-159
        options: GIFT_DISPOSITION_OPTIONS,
        source: "S7.G5",
        visibleWhen: showsGiftDispositionPicker,
      },
      {
        key: "shipsPhysicalProduct",
        group: "campaign",
        control: "toggle",
        label: "Ships a physical product", // COPY:PLU-159
        hint: "When on, the payment form also collects a shipping address so the product can be sent.", // COPY:PLU-159
        source: "S7.G6",
        visibleWhen: showsGiftDetails,
      },
    ],
  },
];

/** Fields of a section that are visible under the current compensation shape.
 *  The single helper the shell (and tests) use to decide what to render/clear. */
export function visibleFields(section: SectionSpec, comp: CompensationShape): FieldSpec[] {
  return section.fields.filter((f) => !f.visibleWhen || f.visibleWhen(comp));
}

// The reward-section field keys, tagged with the value they must be CLEARED to
// when hidden by the current structure. The shell sends these cleared values in
// the PATCH (the backend owns truth — never leave a stale fee on an affiliate
// campaign). One tested source for the switch-and-clear contract.
const REWARD_CLEAR_VALUES: Record<string, null | false> = {
  priceStrategy: null,
  publicStartingFeeCents: null,
  publicCommissionRate: null,
  commissionDurationDays: null,
  commissionConditions: null,
  rewardDescription: null,
  giftDisposition: null,
  shipsPhysicalProduct: false,
  includesGifting: false,
};

/** The reward-section field keys that are HIDDEN under `comp` and therefore must
 *  be sent cleared. Pure — the shell's PATCH builder and the tests both rely on
 *  this being the single definition of "what a structure switch wipes". */
export function clearedRewardFieldKeys(comp: CompensationShape): string[] {
  const reward = getSection("rewardStructure");
  const visible = new Set(visibleFields(reward, comp).map((f) => f.key));
  return Object.keys(REWARD_CLEAR_VALUES).filter((k) => !visible.has(k));
}

export function getSection(key: SectionKey): SectionSpec {
  const s = SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`unknown section: ${key}`);
  return s;
}
