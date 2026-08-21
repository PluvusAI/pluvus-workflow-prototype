// ---------------------------------------------------------------------------
// PLU-172 — the Stage-1 Draft revision-identity primitive
// ---------------------------------------------------------------------------
// A pure, deterministic function: given the same tracked field values, it
// always produces the same id; given a different value in any tracked
// field, it always produces a different one. That determinism IS "the exact
// revision identity" the ticket asks for — it requires no storage of its
// own to be true.
//
// This module has NO route, NO storage, and NO caller within PLU-172 — it
// is exported for PLU-180 ("[2f.2] Add exact-revision approval and
// concurrency safety") to build its approval workflow on top of. PLU-172's
// own job stops at "this function is correct and its field lists are
// frozen"; PLU-180 decides where an "approved revision" is stored, how
// public/private approvals stay independently invalidatable, and how
// concurrency/staleness is enforced. See
// docs/plu-172-private-policy-contract-plan.md §3.5/§7.

import { createHash } from "node:crypto";
import type { CampaignDetails, NegotiationPolicy, CampaignType } from "../db/schema.js";
import { canonicalizeForComparison } from "./jsonCanonicalize.js";
import {
  projectActivePublicFields,
  projectActivePrivatePolicyFields,
  buildRightsPublicValues,
  type PublicProjectionInput,
  type PrivateProjectionInput,
} from "./compensationShape.js";

// `satisfies readonly (keyof T)[]` ties every entry to a REAL column name at
// the type level — a typo or a column renamed later is a compile error, not
// a silently-dropped field. A dropped field means an edit to it no longer
// invalidates approval, which is exactly the failure mode this whole
// mechanism exists to prevent (review fix — the v1 draft of this module
// used a bare `readonly string[]`, which caught nothing).
export const PUBLIC_REVISION_FIELDS = [
  "campaignType",
  "includesGifting",
  "giftDisposition",
  "objective",
  "productOrOffer",
  "timeline",
  "usageRights",
  "exclusivity",
  "attributionWindow",
  "publicStartingFeeCents",
  "priceStrategy",
  "publicCommissionRate",
  "commissionDurationDays",
  "commissionDurationUnit",
  "commissionConditions",
  "deliverableQuantities",
  "adAuthorization",
  "postRetention",
  "contentRepurposeRights",
  "scriptSubmission",
] as const satisfies readonly (keyof CampaignDetails)[];
// NOTE: `deliverables` (free text) is DELIBERATELY excluded.
// deliverableQuantities (the structured Deliverable[] shape, PLU-169) is the
// authoritative source FinalAgreement.finalDeliverables already reads from
// — `deliverables` is a legacy, display-only free-text summary of the same
// underlying fact, not a second governing term. Hashing both would mean an
// edit to the free-text summary ALONE (no structured change) invalidates
// approval for no material reason, while a structured change with a stale,
// unedited summary wouldn't necessarily be caught by the summary field at
// all. deliverableQuantities alone is the one frozen representation the
// "not competing representations" acceptance criterion asks for.

export const PRIVATE_REVISION_FIELDS = [
  "floorCents",
  "ceilingCents",
  "preferredFeeCents",
  "feeMode",
  "commissionFloorRate",
  "commissionCeilingRate",
  "commissionCeilingAmountCents",
  "preferredCommissionRate",
  "commissionNegotiationMode",
  "commissionDurationMode",
  "commissionDurationLimitValue",
  "commissionDurationLimitUnit",
  "giftSubstitutionAllowed",
  "giftSubstitutionMode",
  "giftApprovedSubstitutes",
  "giftValueFlexibilityCents",
  "giftCashReplacementMode",
  "giftCashReplacementLimitCents",
  "deliverableNegotiationMode",
  "deliverablePolicyRules",
  "postingNegotiationMode",
  "postingMaxDelayDays",
  "rightsPolicyRules",
  "scriptWaiverMode",
  "outOfPolicyAction",
  "negotiableTerms",
  "nonNegotiableTerms",
  "negotiationGuidance",
  "maxRounds",
  "overCeilingTolerance",
] as const satisfies readonly (keyof NegotiationPolicy)[];

function stableProjection<T extends Record<string, unknown>>(
  row: T,
  fields: readonly (keyof T)[],
): string {
  const projected: Record<string, unknown> = {};
  // Sort the FIELD NAMES themselves so the same field set always serializes
  // in the same order regardless of how `fields` was declared or iterated —
  // the projected VALUES are canonicalized separately (nested key order
  // included) so a jsonb array-of-objects field (giftApprovedSubstitutes,
  // deliverablePolicyRules, rightsPolicyRules) doesn't depend on the
  // undocumented fact that Postgres jsonb happens to normalize key order on
  // storage.
  for (const f of [...fields].map(String).sort()) {
    const v = row[f as keyof T];
    projected[f] = canonicalizeForComparison(v === undefined ? null : v);
  }
  return JSON.stringify(projected);
}

/**
 * Deterministic content hash of `row` projected onto `fields`. 24 hex
 * chars (96 bits sha256) — short enough to be a sane column value / audit
 * token, effectively zero collision risk at this volume, matching cuid2's
 * own length convention elsewhere in this schema.
 */
export function computeRevisionId<T extends Record<string, unknown>>(
  row: T,
  fields: readonly (keyof T)[],
): string {
  return createHash("sha256").update(stableProjection(row, fields)).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Active-projection revision ids (Calvin review, point B)
// ---------------------------------------------------------------------------
// The revision hash and the activation snapshot MUST be computed from the
// exact same canonical "active policy" projection — otherwise an inactive
// value sitting dormant in Draft (e.g. an AFFILIATE campaign's commission
// settings, still present after the brand switches to PAID) could change
// the approved revision id, or the launch-time snapshot, without the other
// agreeing — a brand could be asked to re-approve Stage 1 for a change that
// has zero effect on what actually gets frozen at activation, or vice
// versa. These two functions are the ONE place "active policy projection ->
// revision hash" happens, reused by whatever PLU-180 builds for approval
// AND by launchCampaign()'s own snapshot construction (db/campaigns.ts) —
// both call the SAME projectActive*Fields (compensationShape.ts) before
// hashing/freezing, so Page 9 approval and the eventual frozen policy stay
// exactly aligned by construction, not by convention.

/** `details` must be a full CampaignDetails-shaped row (or a superset of
 *  PublicProjectionInput) — the raw row is projected to its ACTIVE fields
 *  first, then hashed. Two Draft rows that differ ONLY in an inactive
 *  field (e.g. a dormant, not-currently-applicable campaignType's
 *  leftover values) hash IDENTICALLY. */
export function computeActivePublicRevisionId(details: CampaignDetails & PublicProjectionInput): string {
  return computeRevisionId(
    projectActivePublicFields(details) as unknown as Record<string, unknown>,
    PUBLIC_REVISION_FIELDS as unknown as readonly string[],
  );
}

/** Same idea for the private policy row — `details` supplies the campaignType/
 *  includesGifting/rights-public-values context the projection needs to
 *  decide what's active; only `policy`'s fields are hashed. */
export function computeActivePrivateRevisionId(
  policy: NegotiationPolicy & PrivateProjectionInput,
  details: { campaignType: CampaignType; includesGifting: boolean } & Record<string, unknown>,
): string {
  const projected = projectActivePrivatePolicyFields(policy, {
    campaignType: details.campaignType,
    includesGifting: details.includesGifting,
    rightsPublicValues: buildRightsPublicValues(details),
  });
  return computeRevisionId(
    projected as unknown as Record<string, unknown>,
    PRIVATE_REVISION_FIELDS as unknown as readonly string[],
  );
}
