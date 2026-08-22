// ---------------------------------------------------------------------------
// PLU-175 — deterministic Paid/Affiliate/Hybrid/Gift compensation evaluator
// ---------------------------------------------------------------------------
// Consumes the frozen CounterDelta -> PolicyDecision contract PLU-172 froze
// in domain/policyDecision.ts (types only there, deliberately — see that
// file's own header). This module is the evaluator for exactly the five
// compensation-shaped categories: fee, commission, commissionDuration,
// giftSubstitution, giftCashReplacement. Every other PolicyTermCategory
// (deliverables, posting, the rights family, scriptSubmission) belongs to
// PLU-176/178 and is deliberately returned as UNSUPPORTED here, never
// guessed at.
//
// Pure, table-driven, no DB/executor/state-machine imports — the module
// takes a plain CompensationPolicySnapshot (below) built by whatever caller
// eventually wires this in (out of scope for this ticket), so it composes
// through PLU-172's frozen types without adding a runtime dependency on
// db/schema.ts, db/campaigns.ts, or the negotiation engine. See
// docs/plu-175-compensation-policy-evaluator-plan.md for the full design
// rationale, including every place the worksheet text was ambiguous and how
// it was resolved.

import {
  type PolicyTermCategory,
  type CounterDelta,
  type PolicyDecision,
  type PolicyDecisionOutcome,
  type PolicyDecisionReasonCode,
  type AggregatePolicyDecision,
  creatorSafeReasonKeyFor,
  buildAggregatePolicyDecision,
} from "./policyDecision.js";
import { needsFee, needsCommission, wantsGifting } from "./compensationShape.js";
import type {
  CampaignType,
  PriceStrategy,
  DurationUnit,
  FeeNegotiationMode,
  CommissionNegotiationMode,
  CommissionDurationMode,
  GiftSubstitutionMode,
  GiftCashReplacementMode,
  OutOfPolicyAction,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------
// Deliberately its OWN narrow interface, not the CampaignDetails/
// NegotiationPolicy DB row types — field-for-field identical whether the
// caller hands in a live row or a frozen NegotiationPolicySnapshot /
// CampaignTermsSnapshot.detailsSnapshot read, but this module never imports
// either table shape directly. This also enforces the "free-text guidance
// or legacy floor/preferred values cannot override the typed policy result"
// requirement structurally: floorCents, preferredFeeCents,
// commissionFloorRate, preferredCommissionRate, and negotiationGuidance
// simply have no field on this interface, so there is no way for this
// evaluator to read them even by accident.

export interface CompensationPolicySnapshot {
  // --- public terms (CampaignDetails-shaped) ---
  campaignType: CampaignType;
  includesGifting: boolean;
  priceStrategy: PriceStrategy | null;
  publicStartingFeeCents: number | null;
  /** campaignDetails.commissionMode (S7.A1) — a plain text column, not a
   *  pgEnum, so typed as a bare string here. Only "percent" is evaluated by
   *  this ticket; see evaluateCommission's own comment. */
  commissionMode: string | null;
  /** Whole-number percent, e.g. 15 for 15% — NOT a 0-1 fraction. Matches the
   *  convention already established elsewhere in this codebase (see
   *  db/campaigns.compensationReadiness.db.test.ts's fixtures:
   *  publicCommissionRate: 15, commissionFloorRate: 10,
   *  commissionCeilingRate: 20). A CounterDelta with category "commission"
   *  and proposedUnit "PERCENT" must carry its proposedValue in this SAME
   *  whole-number-percent representation — this evaluator does no scale
   *  conversion, so a caller feeding a 0-1 fraction here would silently
   *  auto-approve or reject every commission proposal, deterministically
   *  and wrongly. */
  publicCommissionRate: number | null;
  commissionDurationUnit: DurationUnit | null;
  commissionDurationDays: number | null;

  // --- private policy (NegotiationPolicy-shaped) ---
  feeMode: FeeNegotiationMode;
  ceilingCents: number | null;
  commissionNegotiationMode: CommissionNegotiationMode;
  /** Same whole-number-percent convention as publicCommissionRate above. */
  commissionCeilingRate: number | null;
  commissionDurationMode: CommissionDurationMode;
  commissionDurationLimitValue: number | null;
  commissionDurationLimitUnit: DurationUnit | null;
  giftSubstitutionMode: GiftSubstitutionMode;
  giftApprovedSubstitutes: readonly string[] | null;
  giftCashReplacementMode: GiftCashReplacementMode;
  giftCashReplacementLimitCents: number | null;
  outOfPolicyAction: OutOfPolicyAction;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Builds a PolicyDecision with creatorSafeReasonKey ALWAYS derived through
 *  the frozen creatorSafeReasonKeyFor() map — no evaluator branch below ever
 *  sets creatorSafeReasonKey by hand, so the creator-safety collapsing rule
 *  (policyDecision.ts's CREATOR_SAFE_REASON_KEYS) can't be bypassed here. */
function decide(
  category: PolicyTermCategory,
  outcome: PolicyDecisionOutcome,
  reasonCode: PolicyDecisionReasonCode,
  appliedValue?: number | string,
): PolicyDecision {
  const d: PolicyDecision = { category, outcome, reasonCode };
  const safeKey = creatorSafeReasonKeyFor(reasonCode);
  if (safeKey !== undefined) d.creatorSafeReasonKey = safeKey;
  if (appliedValue !== undefined) d.appliedValue = appliedValue;
  return d;
}

/**
 * S8.E1's outOfPolicyAction fallback: a request that falls OUTSIDE a term's
 * own configured authority (a KEEP mode asked to be something else, or an
 * ALLOW_WITHIN_LIMIT value past its ceiling) resolves to REJECTED when the
 * campaign is configured to reject out-of-policy asks outright, or
 * REQUIRES_BRAND_APPROVAL (with the situation-specific reason code) when
 * it's configured to ask instead — outOfPolicyAction's own worksheet text
 * ("what happens when a creator's request falls outside every configured
 * authority above") describes exactly this fork. NOT used for a mode's OWN
 * dedicated terminal state (ASK_FOR_APPROVAL, giftCashReplacementMode
 * REJECT) — those are already-authorized outcomes, not "outside authority."
 */
function outOfPolicyDecision(
  category: PolicyTermCategory,
  outOfPolicyAction: OutOfPolicyAction,
  approvalReasonCode: PolicyDecisionReasonCode,
): PolicyDecision {
  if (outOfPolicyAction === "REJECT_REQUEST") {
    return decide(category, "REJECTED", "out_of_policy_reject");
  }
  return decide(category, "REQUIRES_BRAND_APPROVAL", approvalReasonCode);
}

/** CounterDelta.normalization === "AMBIGUOUS" must never be silently
 *  resolved either way, for ANY category — checked first, uniformly, before
 *  any category-specific logic runs. "ALIASED" is treated the same as
 *  "EXACT" (a resolved value, just reached via an alias) — only AMBIGUOUS
 *  blocks. */
function checkAmbiguous(delta: CounterDelta): PolicyDecision | null {
  if (delta.normalization === "AMBIGUOUS") {
    return decide(delta.category, "AMBIGUOUS", "ambiguous_proposal");
  }
  return null;
}

/**
 * Every numeric proposal this evaluator reads (fee/gift-cash cents,
 * commission percent, duration days/count) represents a real-world
 * non-negative quantity — there is no category where a negative value is
 * ever meaningful. A negative or non-finite value (and, deliberately, a
 * numeric-looking STRING like "500" — CounterDelta.proposedValue is typed
 * `number | string`, and this evaluator never coerces a string to a
 * number; only an actual `number` passes) fails closed to UNSUPPORTED
 * rather than being silently accepted by a bare `<=` comparison (e.g. a
 * proposed fee of -50000 is NOT "within" any positive ceiling in any
 * meaningful sense, even though -50000 <= 60000 is arithmetically true).
 */
function asNonNegativeFiniteNumber(v: number | string | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

const DURATION_UNITS: readonly DurationUnit[] = ["DAYS", "LIFETIME", "COUNT"];
function isDurationUnit(v: unknown): v is DurationUnit {
  return typeof v === "string" && (DURATION_UNITS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Paid / Hybrid fee changes (S8.P1)
// ---------------------------------------------------------------------------

function evaluateFee(delta: CounterDelta, snap: CompensationPolicySnapshot): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (!needsFee(snap.campaignType)) {
    return decide("fee", "UNSUPPORTED", "unsupported_operation");
  }
  if (delta.proposedUnit !== "CENTS") {
    return decide("fee", "UNSUPPORTED", "missing_unit");
  }
  const value = asNonNegativeFiniteNumber(delta.proposedValue);
  if (value === null) {
    return decide("fee", "UNSUPPORTED", "missing_unit");
  }

  // Frozen rule (policyDecision.ts REQUEST_RATE_CARD_REQUIRES_EXPLICIT_LIMIT):
  // Request Rate Card has no numeric public starting fee to compare a
  // submitted rate against, so it is NEVER auto-approved unless an explicit
  // ALLOW_WITHIN_LIMIT ceiling authorizes it — this check runs BEFORE the
  // normal per-mode switch below because it overrides what KEEP_PUBLIC_OFFER
  // would otherwise mean (there is no public value to "keep" here).
  const hasExplicitFeeLimit = snap.feeMode === "ALLOW_WITHIN_LIMIT" && snap.ceilingCents != null;
  if (snap.priceStrategy === "REQUEST_RATE_CARD" && !hasExplicitFeeLimit) {
    return decide("fee", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
  }

  switch (snap.feeMode) {
    case "ALLOW_WITHIN_LIMIT": {
      // priceStrategy === REQUEST_RATE_CARD with an explicit limit already
      // passed the guard above; PROPOSE_STARTING_FEE reaches here directly.
      if (snap.ceilingCents == null) {
        return decide("fee", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      if (value <= snap.ceilingCents) {
        return decide("fee", "AUTO_APPROVED", "within_limit", value);
      }
      return outOfPolicyDecision("fee", snap.outOfPolicyAction, "exceeds_limit");
    }
    case "ASK_FOR_APPROVAL":
      return decide("fee", "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "KEEP_PUBLIC_OFFER":
    default: {
      if (snap.publicStartingFeeCents == null) {
        // Data-integrity gap (PROPOSE_STARTING_FEE with no fee configured),
        // not a creator error — fail closed rather than guess.
        return decide("fee", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      if (value === snap.publicStartingFeeCents) {
        return decide("fee", "AUTO_APPROVED", "matches_public_offer", value);
      }
      return outOfPolicyDecision("fee", snap.outOfPolicyAction, "explicitly_fixed");
    }
  }
}

// ---------------------------------------------------------------------------
// Affiliate / Hybrid commission changes (S8.A1)
// ---------------------------------------------------------------------------

function evaluateCommission(delta: CounterDelta, snap: CompensationPolicySnapshot): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (!needsCommission(snap.campaignType)) {
    return decide("commission", "UNSUPPORTED", "unsupported_operation");
  }
  // Worksheet: "Unsupported flat or Two-level public structures remain
  // unavailable or escalate until their complete public/private contract is
  // enabled." Only the percent variant is wired by this ticket (see
  // policyCapabilities.ts's commission.supportedUnits = ["percent"] after
  // this PR) — "flat" and any other/unrecognized commissionMode (there is no
  // distinct schema value for "two-level" today; this check covers it
  // uniformly with flat) fall through to UNSUPPORTED rather than being
  // silently evaluated against the wrong unit.
  if (snap.commissionMode !== "percent") {
    return decide("commission", "UNSUPPORTED", "unsupported_operation");
  }
  if (delta.proposedUnit !== "PERCENT") {
    return decide("commission", "UNSUPPORTED", "missing_unit");
  }
  const value = asNonNegativeFiniteNumber(delta.proposedValue);
  if (value === null) {
    return decide("commission", "UNSUPPORTED", "missing_unit");
  }

  switch (snap.commissionNegotiationMode) {
    case "ALLOW_WITHIN_LIMIT": {
      if (snap.commissionCeilingRate == null) {
        return decide("commission", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      if (value <= snap.commissionCeilingRate) {
        return decide("commission", "AUTO_APPROVED", "within_limit", value);
      }
      return outOfPolicyDecision("commission", snap.outOfPolicyAction, "exceeds_limit");
    }
    case "ASK_FOR_APPROVAL":
      return decide("commission", "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "KEEP_PUBLIC_COMMISSION":
    default: {
      if (snap.publicCommissionRate == null) {
        return decide("commission", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      if (value === snap.publicCommissionRate) {
        return decide("commission", "AUTO_APPROVED", "matches_public_offer", value);
      }
      return outOfPolicyDecision("commission", snap.outOfPolicyAction, "explicitly_fixed");
    }
  }
}

// ---------------------------------------------------------------------------
// Commission-duration changes (S8.A2) — Customer lifetime / time-span / count
// ---------------------------------------------------------------------------

function evaluateCommissionDuration(delta: CounterDelta, snap: CompensationPolicySnapshot): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (!needsCommission(snap.campaignType)) {
    return decide("commissionDuration", "UNSUPPORTED", "unsupported_operation");
  }
  if (!isDurationUnit(delta.proposedUnit)) {
    return decide("commissionDuration", "UNSUPPORTED", "missing_unit");
  }
  const proposedUnit = delta.proposedUnit;
  // schema.ts: an unset commissionDurationUnit reads as DAYS at the
  // application layer, matching commissionDurationDays' pre-existing
  // implicit meaning (rows that predate this unit column).
  const publicUnit: DurationUnit = snap.commissionDurationUnit ?? "DAYS";

  switch (snap.commissionDurationMode) {
    case "ALLOW_WITHIN_LIMIT": {
      const limitUnit = snap.commissionDurationLimitUnit;
      if (limitUnit == null) {
        return decide("commissionDuration", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      // Never silently convert DAYS <-> COUNT <-> LIFETIME.
      if (proposedUnit !== limitUnit) {
        return decide("commissionDuration", "UNSUPPORTED", "missing_unit");
      }
      if (limitUnit === "LIFETIME") {
        // LIFETIME has no numeric bound to exceed — authorizing the mode IS
        // the grant; there is nothing further to compare. appliedValue is
        // deliberately left UNSET here (review fix, mirroring
        // rightsPolicyEvaluator.ts's identical LIFETIME-floor fix):
        // delta.proposedValue is unvalidated at this point (no
        // asNonNegativeFiniteNumber guard applies when there's no numeric
        // bound to check it against), so passing it straight through would
        // let a malformed/negative/non-numeric proposedValue leak into the
        // decision. The unit match alone is the grant; no numeric value is
        // ever read OR recorded on this path.
        return decide("commissionDuration", "AUTO_APPROVED", "within_limit");
      }
      const limitValue = snap.commissionDurationLimitValue;
      if (limitValue == null) {
        return decide("commissionDuration", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      const value = asNonNegativeFiniteNumber(delta.proposedValue);
      if (value === null) {
        return decide("commissionDuration", "UNSUPPORTED", "missing_unit");
      }
      if (value <= limitValue) {
        return decide("commissionDuration", "AUTO_APPROVED", "within_limit", value);
      }
      return outOfPolicyDecision("commissionDuration", snap.outOfPolicyAction, "exceeds_limit");
    }
    case "ASK_FOR_APPROVAL":
      return decide("commissionDuration", "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "KEEP_PUBLIC_DURATION":
    default: {
      if (proposedUnit !== publicUnit) {
        return decide("commissionDuration", "UNSUPPORTED", "missing_unit");
      }
      if (publicUnit === "LIFETIME") {
        // Same review fix as the ALLOW_WITHIN_LIMIT/LIFETIME branch above —
        // appliedValue deliberately omitted, never the unvalidated raw
        // delta.proposedValue.
        return decide("commissionDuration", "AUTO_APPROVED", "matches_public_offer");
      }
      if (snap.commissionDurationDays == null) {
        return decide("commissionDuration", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      const value = asNonNegativeFiniteNumber(delta.proposedValue);
      if (value === null) {
        return decide("commissionDuration", "UNSUPPORTED", "missing_unit");
      }
      if (value === snap.commissionDurationDays) {
        return decide("commissionDuration", "AUTO_APPROVED", "matches_public_offer", value);
      }
      return outOfPolicyDecision("commissionDuration", snap.outOfPolicyAction, "explicitly_fixed");
    }
  }
}

// ---------------------------------------------------------------------------
// Gift / access — substitution (S8.G1)
// ---------------------------------------------------------------------------
// Fulfillment/shipping (giftDisposition, requiresShippingInfo) is explicitly
// deferred by the worksheet from the first prototype and is NOT touched by
// this evaluator at all.

function evaluateGiftSubstitution(delta: CounterDelta, snap: CompensationPolicySnapshot): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (!wantsGifting(snap.campaignType, snap.includesGifting)) {
    return decide("giftSubstitution", "UNSUPPORTED", "unsupported_operation");
  }
  const proposed = typeof delta.proposedValue === "string" ? delta.proposedValue.trim() : "";
  if (!proposed) {
    return decide("giftSubstitution", "UNSUPPORTED", "missing_unit");
  }

  switch (snap.giftSubstitutionMode) {
    case "ALLOW_EQUIVALENT_APPROVED_OPTION": {
      const approved = snap.giftApprovedSubstitutes;
      if (!approved || approved.length === 0) {
        return decide("giftSubstitution", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      const isApproved = approved.some((s) => s.trim().toLowerCase() === proposed.toLowerCase());
      if (isApproved) {
        return decide("giftSubstitution", "AUTO_APPROVED", "within_limit", proposed);
      }
      return outOfPolicyDecision("giftSubstitution", snap.outOfPolicyAction, "exceeds_limit");
    }
    case "ASK_FOR_APPROVAL":
      return decide("giftSubstitution", "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "KEEP_OFFERED_BENEFIT":
    default:
      return outOfPolicyDecision("giftSubstitution", snap.outOfPolicyAction, "explicitly_fixed");
  }
}

// ---------------------------------------------------------------------------
// Gift / access — cash replacement (S8.G2)
// ---------------------------------------------------------------------------

function evaluateGiftCashReplacement(delta: CounterDelta, snap: CompensationPolicySnapshot): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (!wantsGifting(snap.campaignType, snap.includesGifting)) {
    return decide("giftCashReplacement", "UNSUPPORTED", "unsupported_operation");
  }
  if (delta.proposedUnit !== "CENTS") {
    return decide("giftCashReplacement", "UNSUPPORTED", "missing_unit");
  }
  const value = asNonNegativeFiniteNumber(delta.proposedValue);
  if (value === null) {
    return decide("giftCashReplacement", "UNSUPPORTED", "missing_unit");
  }

  switch (snap.giftCashReplacementMode) {
    case "ALLOW_UP_TO_AMOUNT": {
      if (snap.giftCashReplacementLimitCents == null) {
        return decide("giftCashReplacement", "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      if (value <= snap.giftCashReplacementLimitCents) {
        return decide("giftCashReplacement", "AUTO_APPROVED", "within_limit", value);
      }
      return outOfPolicyDecision("giftCashReplacement", snap.outOfPolicyAction, "exceeds_limit");
    }
    case "ASK_FOR_APPROVAL":
      return decide("giftCashReplacement", "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "REJECT":
    default:
      // S8.G2's own dedicated REJECT mode is a hard stop by itself — never
      // routed through outOfPolicyDecision, which is for requests OUTSIDE a
      // term's configured authority; REJECT here IS the configured
      // authority, the same way ASK_FOR_APPROVAL above is.
      return decide("giftCashReplacement", "REJECTED", "out_of_policy_reject");
  }
}

// ---------------------------------------------------------------------------
// Dispatch + package (multi-term, atomic) evaluation
// ---------------------------------------------------------------------------

type CategoryEvaluator = (delta: CounterDelta, snap: CompensationPolicySnapshot) => PolicyDecision;

const EVALUATORS: Partial<Record<PolicyTermCategory, CategoryEvaluator>> = {
  fee: evaluateFee,
  commission: evaluateCommission,
  commissionDuration: evaluateCommissionDuration,
  giftSubstitution: evaluateGiftSubstitution,
  giftCashReplacement: evaluateGiftCashReplacement,
};

/** Evaluates ONE CounterDelta. A category this module doesn't own
 *  (deliverables/posting/the rights family/scriptSubmission — PLU-176/178's
 *  job) returns UNSUPPORTED rather than being silently skipped or guessed
 *  at, matching every other "no evaluator wired" case in this file. */
export function evaluateCompensationTerm(
  delta: CounterDelta,
  snapshot: CompensationPolicySnapshot,
): PolicyDecision {
  const evaluator = EVALUATORS[delta.category];
  if (!evaluator) {
    return decide(delta.category, "UNSUPPORTED", "unsupported_operation");
  }
  return evaluator(delta, snapshot);
}

/**
 * Evaluates every CounterDelta from one creator turn against ONE
 * CompensationPolicySnapshot and reduces them to a single package-level
 * outcome via policyDecision.ts's own most-restrictive-wins
 * buildAggregatePolicyDecision — reused verbatim, not reimplemented, so a
 * rejected/approval-required/ambiguous/unsupported/unit-mismatched term
 * anywhere in a Hybrid multi-term reply is guaranteed to prevent the whole
 * package from being marked autonomous, the same way it would for any other
 * evaluator built on this same frozen contract.
 */
export function evaluateCompensationPackage(
  deltas: readonly CounterDelta[],
  snapshot: CompensationPolicySnapshot,
): AggregatePolicyDecision {
  const decisions = deltas.map((delta) => evaluateCompensationTerm(delta, snapshot));
  return buildAggregatePolicyDecision(decisions);
}
