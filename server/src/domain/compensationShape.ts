// ---------------------------------------------------------------------------
// PLU-172 — shared compensation-structure predicates + activation-time
// private-policy projection
// ---------------------------------------------------------------------------
// needsFee/needsCommission/isGiftOnly used to live duplicated inline inside
// db/campaigns.ts's validateCompensationReadiness (and, separately, as their
// own copies in web/.../sections.ts). Pulled out here so
// validateCompensationReadiness, launchCampaign()'s snapshot projection, and
// this ticket's PATCH-route validation all share ONE definition — a
// campaignType classification can't drift between "does this need a fee"
// call sites the way it could when each one re-derived the answer.
//
// Reused nowhere else yet outside this ticket's own call sites; the web
// mirror in sections.ts is intentionally NOT replaced (this codebase's
// established server-authoritative/web-hand-mirror convention — see
// docs/plu-172-private-policy-contract-plan.md §3.8).

import type { CampaignType } from "../db/schema.js";

export function needsFee(t: CampaignType): boolean {
  return t === "PAID" || t === "HYBRID";
}
export function needsCommission(t: CampaignType): boolean {
  return t === "AFFILIATE" || t === "HYBRID";
}
export function isGiftOnly(t: CampaignType): boolean {
  return t === "GIFT_ONLY";
}
/** Gifting is active either because the structure IS gift-only, or because
 *  the additive gifting toggle is on for a PAID/AFFILIATE/HYBRID campaign. */
export function wantsGifting(campaignType: CampaignType, includesGifting: boolean): boolean {
  return isGiftOnly(campaignType) || includesGifting;
}

// ---------------------------------------------------------------------------
// Activation-time projection
// ---------------------------------------------------------------------------
// PLU-172 (review round, item 9 + its §3.6 refinement): "Maximum fee exists
// only for ALLOW_WITHIN_LIMIT," "maximum replacement amount exists only for
// ALLOW_UP_TO_AMOUNT," "maximum delay only when allowed" — a limit whose
// mode doesn't authorize it must not survive into the immutable activation
// snapshot as a stale, meaningless leftover.
//
// IMPORTANT SCOPING NOTE — read before touching this function: mode-
// conditional nulling below applies ONLY to fields this ticket introduces.
// It deliberately does NOT apply to the three fields that pre-date this
// ticket — floorCents, ceilingCents, giftValueFlexibilityCents — even
// though ceilingCents is now ALSO reused as the feeMode=ALLOW_WITHIN_LIMIT
// bound. Those three fields are read UNCONDITIONALLY today by the live
// negotiation agent (engine/executors/negotiation.ts's resolveBand()),
// which has no concept of feeMode and never will until PLU-175 lands an
// evaluator that understands it. Nulling them under a mode like
// KEEP_PUBLIC_OFFER would silently start every affected campaign's
// negotiation with no ceiling at all THE MOMENT THIS TICKET SHIPS — a
// production regression on a live feature, not a schema-only change. See
// docs/plu-172-private-policy-contract-plan.md §3.6/§11/open-question-4 for
// the full reasoning and the follow-up this leaves for PLU-175.
//
// giftValueFlexibilityCents itself is legacy/unused by any NEW mode
// (Calvin review): giftCashReplacementMode's ALLOW_UP_TO_AMOUNT bound is a
// dedicated new column, giftCashReplacementLimitCents, precisely so cash
// replacement and generic gift-value flexibility never have to permanently
// share one field. giftValueFlexibilityCents keeps its pre-existing
// campaignType-only exclusion below and is otherwise untouched by this
// ticket.

/** The subset of CampaignDetails fields the public projection reads/writes.
 *  Typed narrowly (not the full row) so callers can pass either a live
 *  CampaignDetails row or a plain object built for a test fixture. */
export interface PublicProjectionInput {
  campaignType: CampaignType;
  includesGifting: boolean;
  [key: string]: unknown;
}

/**
 * Null out every conditional PUBLIC field whose governing structure isn't
 * active, so an activation snapshot never carries stale leftovers from a
 * campaignType the brand since changed away from (e.g. a campaign switched
 * HYBRID -> GIFT_ONLY still had its old publicCommissionRate sitting in the
 * row before this fix). Returns a NEW object; does not mutate the input.
 */
export function projectActivePublicFields<T extends PublicProjectionInput>(details: T): T {
  // TS forbids writing through an indexed access on a bare generic type
  // parameter (even one constrained to an indexable interface) — `out` is
  // typed as the WIDE Record for the mutation phase, then handed back to
  // the caller as `T` at the return (a real, safe upcast: every key written
  // below already exists, optionally, in PublicProjectionInput, so no
  // property outside T's own shape is ever introduced).
  const out: Record<string, unknown> = { ...details };
  if (!needsFee(details.campaignType)) {
    out["publicStartingFeeCents"] = null;
    out["priceStrategy"] = null;
  }
  if (!needsCommission(details.campaignType)) {
    out["publicCommissionRate"] = null;
    out["commissionDurationDays"] = null;
    out["commissionDurationUnit"] = null;
    out["commissionConditions"] = null;
  }
  if (!wantsGifting(details.campaignType, details.includesGifting)) {
    out["giftDisposition"] = null;
  }
  return out as T;
}

/** The subset of NegotiationPolicy fields the private projection reads/
 *  writes, plus the two CampaignDetails facts (campaignType, rights-term
 *  public values) it needs to decide what's active. */
export interface PrivateProjectionInput {
  [key: string]: unknown;
}

export interface PrivateProjectionContext {
  campaignType: CampaignType;
  includesGifting: boolean;
  /** Public values for each rights-family term, by RightsTerm name — used
   *  to exclude a rightsPolicyRules entry whose public term has no value
   *  (a rule with nothing to constrain can't mean anything). Absent/empty
   *  string and null/undefined are both treated as "no public value." */
  rightsPublicValues: Record<string, unknown>;
}

// Calvin review: scriptSubmission is NOT one of these — it has its own
// dedicated NegotiationPolicy.scriptWaiverMode column now (see
// rightsPolicyRules.ts's own header comment for why ALLOW_TO_MINIMUM never
// applied to it), not a rightsPolicyRules entry, so it needs no public-value
// gating through this rights-rule mechanism at all.
const RIGHTS_TERM_KEYS = [
  "usageRights",
  "exclusivity",
  "adAuthorization",
  "postRetention",
  "contentRepurposeRights",
] as const;

function hasPublicValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

/**
 * Null out every conditional PRIVATE field whose governing structure or
 * mode isn't active. Two independent exclusion rules compose here:
 *   1. campaignType-conditional — the SAME three fields and the SAME rule
 *      validateCompensationReadiness already enforces (unchanged from
 *      before this ticket).
 *   2. mode-conditional — NEW fields only (see the scoping note above this
 *      function's doc comment). A limit column is nulled when its paired
 *      mode doesn't authorize it.
 * Plus: any rightsPolicyRules entry whose public term has no value is
 * dropped (a rule against an always-null public field can't mean anything —
 * e.g. contentRepurposeRights today, before any intake page collects it).
 * Returns a NEW object; does not mutate the input.
 */
export function projectActivePrivatePolicyFields<T extends PrivateProjectionInput>(
  policy: T,
  ctx: PrivateProjectionContext,
): T {
  // See projectActivePublicFields's comment on why this is Record<string,
  // unknown> during the mutation phase and cast back to T only at return.
  const out: Record<string, unknown> = { ...policy };
  const wantsGift = wantsGifting(ctx.campaignType, ctx.includesGifting);

  // --- campaignType exclusion (pre-existing fields, pre-existing rule) ---
  if (!needsFee(ctx.campaignType)) {
    out["floorCents"] = null;
    out["ceilingCents"] = null;
    out["preferredFeeCents"] = null;
  }
  if (!needsCommission(ctx.campaignType)) {
    out["commissionFloorRate"] = null;
    out["commissionCeilingRate"] = null;
    out["preferredCommissionRate"] = null;
  }
  if (!wantsGift) {
    out["giftSubstitutionAllowed"] = null;
    out["giftValueFlexibilityCents"] = null;
  }

  // --- mode exclusion (NEW fields only — see scoping note above) ---
  if (out["commissionNegotiationMode"] !== "ALLOW_WITHIN_LIMIT") {
    out["commissionCeilingAmountCents"] = null;
  }
  if (out["commissionDurationMode"] !== "ALLOW_WITHIN_LIMIT") {
    out["commissionDurationLimitValue"] = null;
    out["commissionDurationLimitUnit"] = null;
  }
  if (out["giftSubstitutionMode"] !== "ALLOW_EQUIVALENT_APPROVED_OPTION") {
    out["giftApprovedSubstitutes"] = null;
  }
  // Calvin review: giftCashReplacementLimitCents is a NEW, dedicated column
  // (not a reuse of the pre-existing giftValueFlexibilityCents — see that
  // field's own doc comment on schema.ts) — so unlike giftValueFlexibilityCents,
  // it IS mode-gated here, same as every other new limit field.
  if (out["giftCashReplacementMode"] !== "ALLOW_UP_TO_AMOUNT") {
    out["giftCashReplacementLimitCents"] = null;
  }
  if (out["postingNegotiationMode"] !== "ALLOW_DELAY_DAYS") {
    out["postingMaxDelayDays"] = null;
  }
  if (out["deliverableNegotiationMode"] !== "ALLOW_SELECTED_CHANGES") {
    out["deliverablePolicyRules"] = null;
  }
  // feeMode: the MODE itself is never nulled — only the limit it governs is
  // (ceilingCents, exempt above per the scoping note). A snapshot must
  // still be able to say "this campaign's fee mode was KEEP_PUBLIC_OFFER"
  // even with no limit attached; excluding the mode would drop real
  // information the ticket doesn't ask to exclude ("Maximum fee exists
  // only for ALLOW_WITHIN_LIMIT" — the MAXIMUM, not the mode). Same
  // reasoning applies to giftCashReplacementMode and scriptWaiverMode
  // (never nulled) — scriptWaiverMode has no limit field to gate at all.

  // --- rights rules: drop any entry whose public term has no value ---
  const rules = Array.isArray(out["rightsPolicyRules"])
    ? (out["rightsPolicyRules"] as Array<{ term: string }>)
    : [];
  if (rules.length > 0) {
    out["rightsPolicyRules"] = rules.filter((r) => hasPublicValue(ctx.rightsPublicValues[r.term]));
  }

  return out as T;
}

/** Builds the `rightsPublicValues` map projectActivePrivatePolicyFields
 *  needs, from a CampaignDetails-shaped row. Pulled into its own function so
 *  callers (launchCampaign, tests) don't have to remember the exact key
 *  list — RIGHTS_TERM_KEYS is the ONE place it's declared, shared with
 *  domain/rightsPolicyRules.ts's RIGHTS_TERMS (kept as a literal copy there,
 *  not an import, to avoid a dependency cycle between the two small modules;
 *  a test asserts the two lists stay identical). */
export function buildRightsPublicValues(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RIGHTS_TERM_KEYS) out[key] = details[key];
  return out;
}
