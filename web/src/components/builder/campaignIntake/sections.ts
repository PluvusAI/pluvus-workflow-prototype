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
  // PLU-139: which gift-delivery path is chosen (S7.G1), so the promo-code vs
  // manual-contact fields show conditionally. "" = not yet chosen.
  giftDeliveryMethod: string;
  // PLU-139: the distinct platforms across the selected deliverable cards
  // (S3.1–S3.9). Drives the S6.7 Instagram-collab conditional — that control is
  // only relevant when Instagram is one of the requested platforms.
  selectedPlatforms: string[];
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
  | "quantityRows" // PLU-139: repeatable {platform, format, quantity} rows (S3.2–S3.9)
  | "deliverableCards" // PLU-139 (B): the 8 worksheet platform/format checkbox cards (S3.2–S3.9)
  | "countryPicker" // PLU-139 (B): searchable multi-select country picker → string[] of ISO codes (S3.10)
  | "file" // PLU-139 (B): upload a file via /uploads; stores the returned reference
  | "radioCards" // RadioCardGroup
  // --- worksheet-spec controls (PLU-139: match the worksheet's stated component) ---
  | "richText" // rich-text editor — worksheet wants WYSIWYG; multi-line text until PLU-159 wires a real editor. Same string column.
  | "durationSelect" // dropdown of preset durations + an "Others" custom escape (S6.1–S6.6). Stores the picked option value OR the custom string.
  | "searchableSelect" // a filterable dropdown (S2.4 product type). Same string column as select.
  | "commissionAmount" // number + %/flat-amount mode (S7.A1). Stores the number; a companion *_mode field holds "percent"|"flat".
  | "attributionWindow" // 2 cards (Days / Customer lifetime) + conditional days number (S7.A4). Stores "lifetime" or a day count string.
  | "pricingGrid" // one currency row per selected deliverable format (S7.P1). Stores { "<platform>:<format>": cents }.
  | "followerRanges" // per-platform min/max numeric ranges (S3.11). Stores { "<platform>": { min, max } }.
  | "repeatableLinks" // repeatable multi-link input (S5.5). Stores newline-joined links in the existing string column.
  | "trackingPreview"; // read-only creator-code preview (S7.T4). Renders, never edits.

export interface SelectOption {
  value: string;
  label: string; // COPY:PLU-159
}

// The 8 platform/format cards from the worksheet (S3.2–S3.9), verbatim. The
// `platform`/`format` pair is what gets stored in a deliverableQuantities row,
// so these strings ARE the contract — not placeholder copy. `label` is the
// card's display text (worksheet's user-facing label). Ordered as the worksheet.
export interface DeliverableCard {
  platform: string;
  format: string;
  label: string;
  source: string;
}
export const DELIVERABLE_CARDS: DeliverableCard[] = [
  { platform: "instagram", format: "reel", label: "Instagram Reel", source: "S3.2" },
  { platform: "instagram", format: "carousel", label: "Instagram carousel post", source: "S3.3" },
  { platform: "tiktok", format: "video", label: "TikTok video", source: "S3.4" },
  { platform: "youtube", format: "dedicated", label: "YouTube dedicated video", source: "S3.5" },
  { platform: "youtube", format: "integrated", label: "YouTube integrated video", source: "S3.6" },
  { platform: "linkedin", format: "post", label: "LinkedIn posts", source: "S3.7" },
  { platform: "linkedin", format: "video", label: "LinkedIn video post", source: "S3.8" },
  { platform: "twitter", format: "post", label: "Twitter(X) post", source: "S3.9" },
];

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
  /** For control "file": the input's accept filter (e.g. "image/*"). */
  accept?: string;
  /** Show a required (*) marker. Visual only — the intake is Draft-first, so an
   *  incomplete draft still saves; "required" means required to launch/approve
   *  Stage 1, per the worksheet's "Required" rows. For fields inside a reward
   *  branch this only reads as required once `visibleWhen` shows them. */
  required?: boolean;
  /** Worksheet question id this derives from, for review traceability. */
  source: string;
  /** Show only when this predicate holds (reward-structure conditionals). */
  visibleWhen?: (comp: CompensationShape) => boolean;
  /** number/money bounds — validated in the shell, mirrored from create wizard. */
  min?: number;
  max?: number;
  /** For text controls: show a live character counter and soft over-limit state
   *  at this length (worksheet S1.1 = 50). Display only; does not truncate. */
  maxCount?: number;
  /** Set at create and not in the PATCH surface — shown but never editable in
   *  the brief editor (e.g. name/brand). Distinct from the lifecycle read-only
   *  lock, which disables everything once the campaign is ACTIVE. */
  readOnly?: boolean;
  /** Display-only: derived from other fields, has no column, never persisted
   *  (e.g. S7.T4 tracking preview). Excluded from clear/validation contracts. */
  display?: boolean;
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
// PLU-139 gift-delivery path (S7.G1). The method picker shows whenever gift
// details show; the promo-code / manual-contact fields show per chosen method.
export function showsGiftDelivery(comp: CompensationShape): boolean {
  return showsGiftDetails(comp);
}
export function showsPromoCode(comp: CompensationShape): boolean {
  return showsGiftDetails(comp) && comp.giftDeliveryMethod === "promo_code";
}
export function showsManualContact(comp: CompensationShape): boolean {
  return showsGiftDetails(comp) && comp.giftDeliveryMethod === "manual_contact";
}
// PLU-139 public affiliate tracking (T-series) — shown for Affiliate/Hybrid.
export function showsTracking(comp: CompensationShape): boolean {
  return needsCommission(comp.campaignType);
}
// PLU-139 S6.7: the Instagram-collaborative-post invite only makes sense when
// Instagram is one of the requested platforms (from the S3 deliverable cards).
export function showsInstagramCollab(comp: CompensationShape): boolean {
  return comp.selectedPlatforms.includes("instagram");
}

export const GIFT_DELIVERY_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.G1
  { value: "promo_code", label: "Promo code" },
  { value: "manual_contact", label: "Manual contact" },
];

export const BRIEF_DELIVERY_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S5.1
  { value: "pluvus_builder", label: "Use Pluvus's brief builder" },
  { value: "own_doc", label: "Use your own content brief doc" },
];

export const SCRIPT_SUBMISSION_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S5.6: whether creators must submit a script before posting.
  { value: "require", label: "Require it" },
  { value: "skip", label: "Skip it" },
];

export const TRACKING_MODE_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.T1
  { value: "pluvus", label: "Let Pluvus generate unique links" },
  { value: "own", label: "Use my own unique links" },
];

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
  // COPY:PLU-159 — S7.G5 is two cards (keep-as-reward / supplied-to-create); the
  // 3-value disposition enum below is the persisted contract. KEEP = kept as
  // reward; LOAN/RETURN = supplied to create. Rendered as 2 cards in the shell.
  { value: "KEEP", label: "Yes — it's part of their reward" },
  { value: "RETURN", label: "No — only supplied to create content" },
];

// --- worksheet duration option lists (S6.*) --------------------------------
// The value IS the stored string (single-string-column persistence). "Others"
// is not an option here — it's the durationSelect control's built-in custom
// escape. Options are verbatim from the worksheet, in worksheet order.
export const POST_DEADLINE_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.1: "As soon as approved" then Within 1–30 days.
  { value: "As soon as approved", label: "As soon as approved" },
  ...Array.from({ length: 30 }, (_, i) => {
    const d = i + 1;
    return { value: `Within ${d} day${d === 1 ? "" : "s"}`, label: `Within ${d} day${d === 1 ? "" : "s"}` };
  }),
];
export const LINK_IN_BIO_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.2
  { value: "As long as they want", label: "As long as they want" },
  { value: "7 days", label: "7 days" },
  { value: "14 days", label: "14 days" },
  { value: "30 days", label: "30 days" },
  { value: "60 days", label: "60 days" },
  { value: "90 days", label: "90 days" },
];
export const AD_AUTHORIZATION_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.3
  { value: "None", label: "None" },
  { value: "30 days", label: "30 days" },
  { value: "60 days", label: "60 days" },
  { value: "90 days", label: "90 days" },
  { value: "6 months", label: "6 months" },
  { value: "12 months", label: "12 months" },
];
export const POST_RETENTION_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.4
  { value: "No minimum", label: "No minimum" },
  { value: "30 days", label: "30 days" },
  { value: "60 days", label: "60 days" },
  { value: "90 days", label: "90 days" },
  { value: "6 months", label: "6 months" },
  { value: "12 months", label: "12 months" },
  { value: "Indefinitely", label: "Indefinitely" },
];
export const REPURPOSE_RIGHTS_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.5
  { value: "None", label: "None" },
  { value: "30 days", label: "30 days" },
  { value: "60 days", label: "60 days" },
  { value: "90 days", label: "90 days" },
  { value: "6 months", label: "6 months" },
  { value: "12 months", label: "12 months" },
  { value: "Unlimited", label: "Unlimited" },
];
export const EXCLUSIVITY_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.6
  { value: "None", label: "None" },
  { value: "30 days", label: "30 days" },
  { value: "60 days", label: "60 days" },
  { value: "90 days", label: "90 days" },
  { value: "6 months", label: "6 months" },
];
export const INSTAGRAM_COLLAB_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S6.7 (No / Yes). Boolean column; "true"/"false" string values
  // so the shared BOOL_RADIO_KEYS coercion applies.
  { value: "false", label: "No" },
  { value: "true", label: "Yes" },
];

// --- S2.5 creator access (two radio cards over a boolean column) -----------
// The column is Boolean; the radio values are "true"/"false" strings that the
// shell coerces. "" (unset) leaves the column null.
export const CREATOR_ACCESS_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S2.5
  { value: "true", label: "Enable access" },
  { value: "false", label: "No access needed" },
];

// --- S7.G6 physical product (two radio cards over a boolean column) --------
export const SHIPS_PHYSICAL_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.G6
  { value: "true", label: "Yes — it needs to be shipped" },
  { value: "false", label: "No — it's digital or nothing ships" },
];

// The set of boolean-backed fields rendered as two radio cards (string
// "true"/"false" in the draft, coerced to Boolean at save). One source of truth
// so the shell's seed/coercion and the renderer agree.
export const BOOL_RADIO_KEYS = new Set([
  "creatorAccessNeeded", // S2.5
  "shipsPhysicalProduct", // S7.G6
  "instagramCollab", // S6.7 (No/Yes)
]);

// --- S2.4 product type (searchable dropdown) -------------------------------
// COPY:PLU-159 — the worksheet says "exact option list still needs evidence/
// product decision", so this is a starter set; the searchableSelect control
// also allows a typed custom value so the list isn't a hard constraint.
export const PRODUCT_TYPE_OPTIONS: SelectOption[] = [
  { value: "Web app", label: "Web app" },
  { value: "Mobile app", label: "Mobile app" },
  { value: "SaaS", label: "SaaS" },
  { value: "Physical product", label: "Physical product" },
  { value: "Consumer electronics", label: "Consumer electronics" },
  { value: "Apparel", label: "Apparel" },
  { value: "Beauty & personal care", label: "Beauty & personal care" },
  { value: "Food & beverage", label: "Food & beverage" },
  { value: "Health & wellness", label: "Health & wellness" },
  { value: "Financial service", label: "Financial service" },
  { value: "Education", label: "Education" },
  { value: "Other", label: "Other" },
];

// --- S7.P2 payment terms (3 cards) -----------------------------------------
export const PAYMENT_TERMS_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.P2
  { value: "Pay after post", label: "Pay after post" },
  { value: "50% upfront / 50% after", label: "50% upfront / 50% after" },
  { value: "Full upfront", label: "Full upfront" },
];

// --- S7.A2 commission length (3 cards) -------------------------------------
export const COMMISSION_LENGTH_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.A2
  { value: "customer_lifetime", label: "Customer lifetime" },
  { value: "time_span", label: "By time span" },
  { value: "count", label: "By count" },
];

// --- S7.A3 variable commission (segmented) ---------------------------------
export const VARIABLE_COMMISSION_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.A3
  { value: "no", label: "No" },
  { value: "two_levels", label: "Two levels" },
];

// --- S7.T3 tracking parameter (dropdown w/ recommended default) ------------
export const TRACKING_PARAMETER_OPTIONS: SelectOption[] = [
  // COPY:PLU-159 — S7.T3, preserve `_from (Recommended)` from Pluvus P1.5.
  { value: "_from", label: "_from (Recommended)" },
  { value: "ref", label: "ref" },
  { value: "utm_source", label: "utm_source" },
  { value: "via", label: "via" },
];

// ---------------------------------------------------------------------------
// The sections. Order = left-rail order = worksheet page order (4 skipped).
// ---------------------------------------------------------------------------
export const SECTIONS: SectionSpec[] = [
  {
    key: "startSources",
    title: "Start & sources", // COPY:PLU-159
    blurb:
      // COPY:PLU-159 — upload wiring is live (brief PDF, supporting materials,
      // logo). AI prefill FROM an uploaded asset is still a later step.
      "Name the campaign, point us at the product page, and upload any supporting materials.",
    fields: [
      {
        key: "name",
        group: "campaign",
        control: "text",
        label: "Campaign name", // COPY:PLU-159
        hint: "Set when the campaign was created.", // COPY:PLU-159
        placeholder: "e.g. Summer 2026 Launch", // COPY:PLU-159
        source: "S1.1",
        maxCount: 50, // S1.1 worksheet 50-char counter
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
        required: true,
      },
      {
        key: "brandMaterialsRef",
        group: "campaign",
        control: "file",
        accept: "application/pdf,.pdf",
        label: "Supporting materials", // COPY:PLU-159
        hint: "Upload brand guidelines / supporting materials (PDF).", // COPY:PLU-159
        source: "S1.4",
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
        key: "productName",
        group: "campaign",
        control: "text",
        label: "Product name", // COPY:PLU-159
        hint: "The name of the product or service this campaign promotes.", // COPY:PLU-159
        placeholder: "e.g. Avatar", // COPY:PLU-159
        source: "S2.3",
        required: true,
      },
      {
        key: "brandDescription",
        group: "campaign",
        control: "textarea",
        label: "Product introduction", // COPY:PLU-159
        hint: "What the brand does or sells. The agent uses this to answer creator questions without inventing anything.", // COPY:PLU-159
        placeholder:
          "e.g. Avatar is a fintech app that helps Gen Z track spending and build credit.", // COPY:PLU-159
        source: "S2.6",
        required: true,
      },
      {
        key: "productType",
        group: "campaign",
        control: "searchableSelect",
        label: "Product type", // COPY:PLU-159
        hint: "The product category. Type to filter, or enter your own.", // COPY:PLU-159
        placeholder: "e.g. Running shoes", // COPY:PLU-159
        options: PRODUCT_TYPE_OPTIONS,
        source: "S2.4",
        required: true,
      },
      {
        key: "creatorAccessNeeded",
        group: "campaign",
        control: "radioCards",
        label: "Does the creator need product or account access to create content?", // COPY:PLU-159
        hint: "Operational access for content creation only — not automatically part of the reward (that's the gift toggle in Reward structure).", // COPY:PLU-159
        options: CREATOR_ACCESS_OPTIONS,
        source: "S2.5",
      },
      {
        key: "uniqueSellingPoints",
        group: "campaign",
        control: "textarea",
        label: "Unique selling points & features", // COPY:PLU-159
        placeholder: "e.g. Lightest in class, carbon plate, recycled upper.", // COPY:PLU-159
        source: "S2.7",
        required: true,
      },
      {
        key: "whyTrust",
        group: "campaign",
        control: "textarea",
        label: "Why creators should trust you", // COPY:PLU-159
        hint: "Optional but recommended — helps the outreach land.", // COPY:PLU-159
        source: "S2.8",
      },
      {
        key: "howToUse",
        group: "campaign",
        control: "richText",
        label: "How to use the product", // COPY:PLU-159
        source: "S2.9",
      },
      {
        key: "brandAssets",
        group: "campaign",
        control: "richText",
        label: "Brand assets", // COPY:PLU-159
        hint: "Links to logos, imagery, or a shared drive (Google Drive or other).", // COPY:PLU-159
        placeholder: "e.g. https://drive.google.com/…", // COPY:PLU-159
        source: "S2.10",
      },
      // BrandIdentity sub-group (its own endpoint).
      {
        key: "logoRef",
        group: "brandIdentity",
        control: "file",
        accept: "image/*",
        label: "Product logo", // COPY:PLU-159
        hint: "Upload the brand/product logo (PNG, JPG, GIF or WebP).", // COPY:PLU-159
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
        key: "deliverableQuantities",
        group: "campaign",
        control: "deliverableCards",
        label: "Platforms & content types", // COPY:PLU-159
        hint: "Select each content type you want and set how many. This is the requested deliverable scope.", // COPY:PLU-159
        source: "S3.1–S3.9",
        required: true,
      },
      {
        key: "deliverables",
        group: "campaign",
        control: "textarea",
        label: "Additional deliverable notes", // COPY:PLU-159
        hint: "Optional free-text scope the cards above don't capture. The agent states this alongside the agreed deliverables.", // COPY:PLU-159
        placeholder:
          "e.g. include 30-day usage rights; post within launch week.", // COPY:PLU-159
        source: "S3.1–S3.9",
      },
      // CreatorRequirement sub-group (its own endpoint). Informational only —
      // never drives matching/ranking/outreach (per the field's server doc).
      // NB: platforms (S3.1) has no field here — it's DERIVED from the selected
      // deliverable cards at save (see buildCreatorPayload), since the cards
      // already carry which platforms are chosen. No double entry.
      {
        key: "geography",
        group: "creatorRequirement",
        control: "countryPicker",
        label: "Countries / markets", // COPY:PLU-159
        hint: "Search and select the markets you're targeting.", // COPY:PLU-159
        source: "S3.10",
      },
      {
        // S3.11 — per-platform follower min/max ranges (worksheet component).
        // The control's own value is minFollowers (creatorRequirement int, the
        // launch-relevant floor); the full per-platform map persists to the
        // followerRanges CampaignDetails column via onExtraChange.
        key: "minFollowers",
        group: "creatorRequirement",
        control: "followerRanges",
        label: "Follower requirements for influencers", // COPY:PLU-159
        hint: "Set a min/max per platform. Leave a max blank for no upper limit.", // COPY:PLU-159
        placeholder: "e.g. 10000", // COPY:PLU-159
        min: 0,
        // Server rejects int4 overflow (PLU-139 Greptile fix); keep under 2^31-1.
        max: 2147483647,
        source: "S3.11",
      },
    ],
  },
  {
    key: "contentGuidelines",
    title: "Content guidelines", // COPY:PLU-159
    blurb:
      // COPY:PLU-159 — the granular worksheet Page-5 fields (briefHighlight /
      // creativeConcept / reference-videos / script-submission) still have no
      // dedicated columns; the through-line, requirements, and prohibited-claims
      // fields below DO map to real CampaignDetails columns.
      "Creative direction for the content — the message, what's required, and what creators must not say.",
    fields: [
      {
        key: "briefDeliveryMethod",
        group: "campaign",
        control: "radioCards",
        label: "How should influencers receive this brief?", // COPY:PLU-159
        options: BRIEF_DELIVERY_OPTIONS,
        source: "S5.1",
        required: true,
      },
      {
        key: "briefHighlight",
        group: "campaign",
        control: "richText",
        label: "Brief highlight", // COPY:PLU-159
        hint: "The must-know points, shown first.", // COPY:PLU-159
        placeholder: "e.g. Feature the product in the first 3 seconds; tag @brand.", // COPY:PLU-159
        source: "S5.2",
      },
      {
        key: "keyMessages",
        group: "campaign",
        control: "textarea",
        label: "Core message", // COPY:PLU-159
        hint: "The campaign through-line every piece of content should reflect. The agent only states messaging you provide.", // COPY:PLU-159
        placeholder: "e.g. Our shoes are the lightest running shoe under $120.", // COPY:PLU-159
        source: "S5.3",
      },
      {
        key: "creativeConcept",
        group: "campaign",
        control: "richText",
        label: "Creative concept", // COPY:PLU-159
        hint: "Tone, treatment, and style only — not a second topic.", // COPY:PLU-159
        placeholder: "e.g. Warm, upbeat, shot handheld; day-in-the-life framing.", // COPY:PLU-159
        source: "S5.4",
      },
      {
        key: "referenceVideos",
        group: "campaign",
        control: "repeatableLinks",
        label: "Reference videos from other influencers", // COPY:PLU-159
        hint: "Optional but recommended — add one link per row.", // COPY:PLU-159
        placeholder: "e.g. https://www.tiktok.com/@creator/video/123", // COPY:PLU-159
        source: "S5.5",
      },
      {
        key: "scriptSubmission",
        group: "campaign",
        control: "radioCards",
        label: "Script / idea submission", // COPY:PLU-159
        hint: "Whether creators must submit a script before posting. Execution only — not an alternative Content Angle.", // COPY:PLU-159
        options: SCRIPT_SUBMISSION_OPTIONS,
        source: "S5.6",
      },
      {
        key: "contentRequirements",
        group: "campaign",
        control: "richText",
        label: "Content requirements — all platforms", // COPY:PLU-159
        hint: "Content restrictions, music/sound, subtitles, retention.", // COPY:PLU-159
        placeholder:
          "e.g. Show the product in use in the first 3 seconds. No competitor mentions. Add captions.", // COPY:PLU-159
        source: "S5.7",
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
        control: "durationSelect",
        label: "Influencer post deadline", // COPY:PLU-159
        hint: "When must the creator publish their post?", // COPY:PLU-159
        placeholder: "e.g. September 15, 2026", // COPY:PLU-159 — the "Others" custom placeholder
        options: POST_DEADLINE_OPTIONS,
        source: "S6.1",
      },
      {
        key: "linkInBioDuration",
        group: "campaign",
        control: "durationSelect",
        label: "Link in bio duration", // COPY:PLU-159
        hint: "How long should the link stay in the creator's bio?", // COPY:PLU-159
        placeholder: "e.g. 45 days", // COPY:PLU-159
        options: LINK_IN_BIO_OPTIONS,
        source: "S6.2",
      },
      {
        key: "adAuthorization",
        group: "campaign",
        control: "durationSelect",
        label: "Ad authorization", // COPY:PLU-159
        hint: "Permission to run ads using the influencer's post.", // COPY:PLU-159
        placeholder: "e.g. 18 months", // COPY:PLU-159
        options: AD_AUTHORIZATION_OPTIONS,
        source: "S6.3",
      },
      {
        key: "postRetention",
        group: "campaign",
        control: "durationSelect",
        label: "Post retention", // COPY:PLU-159
        hint: "How long will the influencer commit to keeping the post live on their profile?", // COPY:PLU-159
        placeholder: "e.g. 18 months", // COPY:PLU-159
        options: POST_RETENTION_OPTIONS,
        source: "S6.4",
      },
      {
        key: "usageRights",
        group: "campaign",
        control: "durationSelect",
        label: "Content repurpose rights", // COPY:PLU-159
        hint: "Permission to reuse the content beyond the original post, e.g. on your own channels or in paid media.", // COPY:PLU-159
        placeholder: "e.g. 18 months", // COPY:PLU-159
        options: REPURPOSE_RIGHTS_OPTIONS,
        source: "S6.5",
      },
      {
        key: "exclusivity",
        group: "campaign",
        control: "durationSelect",
        label: "Exclusivity", // COPY:PLU-159
        hint: "How long before the creator can work with a competing brand or promote a competing product?", // COPY:PLU-159
        placeholder: "e.g. 4 months", // COPY:PLU-159
        options: EXCLUSIVITY_OPTIONS,
        source: "S6.6",
      },
      {
        key: "instagramCollab",
        group: "campaign",
        control: "radioCards",
        label: "Instagram collaborative post", // COPY:PLU-159
        hint: "Invite the creator to publish as a collaborative post so it appears on both accounts.", // COPY:PLU-159
        options: INSTAGRAM_COLLAB_OPTIONS,
        source: "S6.7",
        visibleWhen: showsInstagramCollab,
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
        required: true,
      },
      // Paid / Hybrid — fee + strategy.
      {
        key: "priceStrategy",
        group: "campaign",
        control: "radioCards",
        label: "Price strategy", // COPY:PLU-159
        hint: "Propose a starting number, or ask the creator for their rate card first.", // COPY:PLU-159
        options: PRICE_STRATEGY_OPTIONS,
        source: "S7.P1",
        visibleWhen: (c) => needsFee(c.campaignType),
      },
      {
        key: "publicStartingFeeCents",
        group: "campaign",
        control: "pricingGrid",
        label: "Price per content type", // COPY:PLU-159
        hint: "Set the fixed price for each selected deliverable. The first row's price is the public starting fee.", // COPY:PLU-159
        source: "S7.P1",
        required: true,
        visibleWhen: showsStartingFee,
      },
      {
        key: "paymentTerms",
        group: "campaign",
        control: "radioCards",
        label: "Payment terms", // COPY:PLU-159
        options: PAYMENT_TERMS_OPTIONS,
        source: "S7.P2",
        visibleWhen: (c) => needsFee(c.campaignType),
      },
      // Affiliate / Hybrid — commission.
      {
        key: "publicCommissionRate",
        group: "campaign",
        control: "commissionAmount",
        label: "Commission amount", // COPY:PLU-159
        hint: "The public commission shown to the creator. Choose percentage or a flat amount.", // COPY:PLU-159
        placeholder: "e.g. 15", // COPY:PLU-159
        min: 0,
        source: "S7.A1",
        required: true,
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      {
        // S7.A2 "Commission length" (Customer lifetime / By time span / By count).
        // `commissionConditions` is the existing column that carries this — the
        // 3 cards write their choice here; the numeric span/count uses
        // commissionDurationDays below. No new column (single-column decision).
        key: "commissionConditions",
        group: "campaign",
        control: "radioCards",
        label: "Commission length", // COPY:PLU-159
        hint: "How long the creator keeps earning commission.", // COPY:PLU-159
        options: COMMISSION_LENGTH_OPTIONS,
        source: "S7.A2",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      {
        key: "commissionDurationDays",
        group: "campaign",
        control: "number",
        label: "Commission duration (days / count)", // COPY:PLU-159
        hint: "The time-span or count value, when the length above is By time span or By count.", // COPY:PLU-159
        placeholder: "e.g. 30", // COPY:PLU-159
        min: 1,
        source: "S7.A2",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      {
        key: "attributionWindow",
        group: "campaign",
        control: "attributionWindow",
        label: "Attribution window", // COPY:PLU-159
        hint: "How long a click/sale is credited to the creator.", // COPY:PLU-159
        placeholder: "e.g. 30", // COPY:PLU-159 — the "Days" custom placeholder
        source: "S7.A4",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      {
        key: "variableCommission",
        group: "campaign",
        control: "radioCards",
        label: "Variable commission amount over time", // COPY:PLU-159
        hint: "Two levels reveals a second rate and a change point.", // COPY:PLU-159
        options: VARIABLE_COMMISSION_OPTIONS,
        source: "S7.A3",
        visibleWhen: (c) => needsCommission(c.campaignType),
      },
      // Public affiliate tracking (T-series) — Affiliate/Hybrid only.
      {
        key: "affiliateTrackingUrl",
        group: "campaign",
        control: "url",
        label: "Affiliate tracking URL", // COPY:PLU-159
        hint: "Pre-populated from the product page; edit if the tracked destination differs.", // COPY:PLU-159
        placeholder: "e.g. https://example.com/shop", // COPY:PLU-159
        source: "S7.T0",
        visibleWhen: showsTracking,
      },
      {
        key: "trackingLinkMode",
        group: "campaign",
        control: "radioCards",
        label: "How you want to provide the link to the influencer", // COPY:PLU-159
        options: TRACKING_MODE_OPTIONS,
        source: "S7.T1",
        visibleWhen: showsTracking,
      },
      {
        key: "trackingDestinationUrl",
        group: "campaign",
        control: "url",
        label: "Provide the link where the audience will be taken when they click", // COPY:PLU-159
        hint: "Required when Pluvus generates unique links.", // COPY:PLU-159
        placeholder: "e.g. https://example.com/landing", // COPY:PLU-159
        source: "S7.T2",
        visibleWhen: showsTracking,
      },
      {
        key: "trackingParameter",
        group: "campaign",
        control: "select",
        label: "Tracking parameter", // COPY:PLU-159
        hint: "The query-string key appended to each creator's link.", // COPY:PLU-159
        options: TRACKING_PARAMETER_OPTIONS,
        source: "S7.T3",
        visibleWhen: showsTracking,
      },
      {
        // S7.T4 — read-only preview of the creator-specific tracking URL. Derived
        // from the fields above; not persisted, not editable.
        key: "trackingPreview",
        group: "campaign",
        control: "trackingPreview",
        label: "Tracking URL preview", // COPY:PLU-159
        hint: "Shows the creator-specific affiliate link that will be generated.", // COPY:PLU-159
        source: "S7.T4",
        display: true,
        visibleWhen: showsTracking,
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
        required: true,
        visibleWhen: showsGiftDetails,
      },
      {
        key: "giftDisposition",
        group: "campaign",
        control: "radioCards",
        label: "Does the creator keep the product or benefit?", // COPY:PLU-159
        options: GIFT_DISPOSITION_OPTIONS,
        source: "S7.G5",
        visibleWhen: showsGiftDispositionPicker,
      },
      {
        key: "shipsPhysicalProduct",
        group: "campaign",
        control: "radioCards",
        label: "Is this a physical product?", // COPY:PLU-159
        hint: "Tells Pluvus whether shipping is relevant to this campaign.", // COPY:PLU-159
        options: SHIPS_PHYSICAL_OPTIONS,
        source: "S7.G6",
        visibleWhen: showsGiftDetails,
      },
      // Gift delivery path (S7.G1 → promo-code / manual-contact).
      {
        key: "giftDeliveryMethod",
        group: "campaign",
        control: "radioCards",
        label: "How will creators receive it?", // COPY:PLU-159
        options: GIFT_DELIVERY_OPTIONS,
        source: "S7.G1",
        required: true,
        visibleWhen: showsGiftDelivery,
      },
      {
        key: "promoCode",
        group: "campaign",
        control: "text",
        label: "Promo code", // COPY:PLU-159
        hint: "The code the creator enters to redeem the benefit.", // COPY:PLU-159
        placeholder: "e.g. CREATOR30", // COPY:PLU-159
        source: "S7.G2",
        required: true,
        visibleWhen: showsPromoCode,
      },
      {
        key: "giftContactEmail",
        group: "campaign",
        control: "email",
        label: "Creator contact email", // COPY:PLU-159
        hint: "The address Pluvus shares so the brand can arrange the benefit directly.", // COPY:PLU-159
        placeholder: "e.g. partnerships@acme.com", // COPY:PLU-159
        source: "S7.G4",
        required: true,
        visibleWhen: showsManualContact,
      },
      {
        key: "requiresShippingInfo",
        group: "campaign",
        control: "toggle",
        label: "Require shipping info from the creator", // COPY:PLU-159
        hint: "When on, the creator is asked for name and address as part of accepting, so the brand can fulfill.", // COPY:PLU-159
        source: "S7.G7",
        visibleWhen: (c) => showsGiftDetails(c),
      },
      // Shared onboarding control (S7.3).
      {
        key: "requireApproval",
        group: "campaign",
        control: "toggle",
        label: "Require approval", // COPY:PLU-159
        hint: "Whether a creator must be approved before onboarding.", // COPY:PLU-159
        source: "S7.3",
      },
    ],
  },
];

/** Fields of a section that are visible under the current compensation shape.
 *  The single helper the shell (and tests) use to decide what to render/clear. */
export function visibleFields(section: SectionSpec, comp: CompensationShape): FieldSpec[] {
  return section.fields.filter((f) => !f.visibleWhen || f.visibleWhen(comp));
}

/** Is a raw draft control value "empty" for required-field validation? Blank
 *  string, null/undefined, or an empty array count as missing. A boolean is
 *  never missing — `false` is a valid answer to a toggle, so a required toggle
 *  is always satisfied (and none are marked required today). Numbers-as-strings
 *  ("0") are present. Kept here so the shell and tests share one definition. */
function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "boolean") return false;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** The keys of a section's *visible, required* fields whose draft value is empty
 *  — i.e. what blocks `Save & continue` off this substage. `readOnly` fields
 *  (name/brand, set at create) are never validated here: they aren't editable in
 *  the brief editor, so blocking on them would strand the user. Pure so the
 *  shell's gate and the tests rely on one definition of "what's still required".
 *  `getValue` reads the raw control value for a field key (the shell threads its
 *  per-group drafts through it). */
export function missingRequiredKeys(
  section: SectionSpec,
  comp: CompensationShape,
  getValue: (f: FieldSpec) => unknown,
): string[] {
  return visibleFields(section, comp)
    .filter((f) => f.required && !f.readOnly && isEmptyValue(getValue(f)))
    .map((f) => f.key);
}

// The reward-section field keys, tagged with the value they must be CLEARED to
// when hidden by the current structure. The shell sends these cleared values in
// the PATCH (the backend owns truth — never leave a stale fee on an affiliate
// campaign). One tested source for the switch-and-clear contract.
const REWARD_CLEAR_VALUES: Record<string, null | false> = {
  priceStrategy: null,
  publicStartingFeeCents: null,
  paymentTerms: null,
  publicCommissionRate: null,
  commissionDurationDays: null,
  commissionConditions: null,
  attributionWindow: null,
  variableCommission: null,
  affiliateTrackingUrl: null,
  trackingLinkMode: null,
  trackingDestinationUrl: null,
  trackingParameter: null,
  rewardDescription: null,
  giftDisposition: null,
  shipsPhysicalProduct: false,
  includesGifting: false,
  giftDeliveryMethod: null,
  promoCode: null,
  giftContactEmail: null,
  requiresShippingInfo: false,
};

/** The reward-section field keys that are HIDDEN under `comp` and therefore must
 *  be sent cleared. Pure — the shell's PATCH builder and the tests both rely on
 *  this being the single definition of "what a structure switch wipes". */
export function clearedRewardFieldKeys(comp: CompensationShape): string[] {
  const reward = getSection("rewardStructure");
  const visible = new Set(visibleFields(reward, comp).map((f) => f.key));
  return Object.keys(REWARD_CLEAR_VALUES).filter((k) => !visible.has(k));
}

// PLU-139 import review: map a parser section key (usageRights, paymentTerms,
// deliverables, …) to the editable campaign FieldSpec it can fill, if any. The
// parser's canonical keys are the SAME strings as the campaign field keys, so
// this is a direct lookup — a candidate for an unknown/unmapped key is shown as
// read-only evidence with no Apply target. Single edit point: if PLU-159 renames
// a field key, the candidate mapping follows automatically.
export function candidateFieldFor(sectionKey: string): FieldSpec | null {
  for (const section of SECTIONS) {
    for (const f of section.fields) {
      if (
        f.key === sectionKey &&
        f.group === "campaign" &&
        !f.readOnly &&
        // Free-text-backed controls can accept extracted brief text verbatim.
        // Closed-set controls (durationSelect / radioCards / attributionWindow /
        // select) cannot, so those parser sections show as read-only evidence.
        (f.control === "text" ||
          f.control === "textarea" ||
          f.control === "richText" ||
          f.control === "repeatableLinks")
      ) {
        return f;
      }
    }
  }
  return null;
}

export function getSection(key: SectionKey): SectionSpec {
  const s = SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`unknown section: ${key}`);
  return s;
}
