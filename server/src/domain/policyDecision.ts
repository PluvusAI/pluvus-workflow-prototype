// ---------------------------------------------------------------------------
// PLU-172 — the frozen CounterDelta -> PolicyDecision contract
// ---------------------------------------------------------------------------
// This file defines SHAPES ONLY. The deterministic evaluator(s) that
// actually produce a PolicyDecision from a CounterDelta are PLU-175
// (compensation/reward), PLU-176 (rights/exclusivity/script), and PLU-178
// (deliverables/posting-date) — none of that logic lives here, and none of
// it should be added here. Changing this contract requires coordinating all
// three; treat it as frozen once those tickets start.
//
// Why types-only, deliberately: this is the one shared surface three
// independent tickets each build against. Keeping it pure data (no
// evaluator class, no routing/dispatch logic) is what lets them build
// concurrently without one ticket's implementation choices leaking into
// another's — see docs/plu-172-private-policy-contract-plan.md §3.4.

import type { DeliverableDelta } from "./deliverablesValidator.js";
import type { RightsTerm } from "./rightsPolicyRules.js";

export type PolicyTermCategory =
  | "fee"
  | "commission"
  | "commissionDuration"
  | "giftSubstitution"
  | "giftCashReplacement"
  | "deliverables"
  | "posting"
  | RightsTerm // usageRights | exclusivity | adAuthorization | postRetention | contentRepurposeRights
  // Calvin review: scriptSubmission is listed explicitly here, NOT via
  // RightsTerm — it has its own dedicated mode (ScriptWaiverMode, no
  // ALLOW_TO_MINIMUM) and its own NegotiationPolicy column
  // (scriptWaiverMode), not a rightsPolicyRules entry. It's still a real
  // routing category for PLU-176's evaluator, just not part of the
  // duration-bearing rights-rule shape.
  | "scriptSubmission";

export const COUNTER_DELTA_UNITS = [
  "CENTS",
  "PERCENT",
  "FLAT_AMOUNT_CENTS",
  "DAYS",
  "LIFETIME",
  "COUNT",
] as const;
export type CounterDeltaUnit = (typeof COUNTER_DELTA_UNITS)[number];

export const NORMALIZATION_STATES = ["EXACT", "ALIASED", "AMBIGUOUS"] as const;
export type NormalizationState = (typeof NORMALIZATION_STATES)[number];

/**
 * What a creator (via the negotiation agent) is asking to change. One delta
 * per proposed term per turn — the agent may emit several in one turn.
 */
export interface CounterDelta {
  category: PolicyTermCategory;
  /** Single-value categories (fee/commission/duration/posting/cash
   *  replacement/rights minimums). Absent for "deliverables" — that
   *  category uses deliverableDeltas instead, never a bare number. */
  proposedValue?: number | string;
  proposedUnit?: CounterDeltaUnit;
  /** "deliverables" category only. */
  deliverableDeltas?: DeliverableDelta[];
  /** How confidently this proposal was understood — same three states as
   *  DeliverableDelta.normalization (deliverablesValidator.ts), generalized
   *  to every category so a non-deliverable proposal can ALSO be flagged
   *  ambiguous before it ever reaches an evaluator. */
  normalization: NormalizationState;
  sourceText?: string;
}

export const POLICY_DECISION_OUTCOMES = [
  "AUTO_APPROVED", // within the configured limit / matches a KEEP mode — no human needed
  "REQUIRES_BRAND_APPROVAL", // mode says ASK_FOR_APPROVAL, or outOfPolicyAction defaults here
  "REJECTED", // outOfPolicyAction = REJECT_REQUEST and the proposal is out of policy
  "UNSUPPORTED", // no evaluator wired yet for this category (capability map: evaluated=false), or the delta isn't something the current evaluator handles
  "AMBIGUOUS", // normalization was AMBIGUOUS — never silently resolved either way
] as const;
export type PolicyDecisionOutcome = (typeof POLICY_DECISION_OUTCOMES)[number];

export const POLICY_DECISION_REASON_CODES = [
  "within_limit",
  "matches_public_offer",
  "explicitly_fixed", // KEEP_* mode, or listed in nonNegotiableTerms
  "exceeds_limit",
  "no_limit_configured", // mode is ALLOW_* but the limit field itself is null — fail closed, never "unlimited"
  "mode_requires_approval",
  "unsupported_operation",
  "ambiguous_proposal",
  "unknown_deliverable_id",
  "conflicting_deltas",
  "invalid_platform_format",
  "missing_unit",
  "out_of_policy_reject", // outOfPolicyAction = REJECT_REQUEST
] as const;
/** Creator-SAFE reason codes only — none of these may ever be paired with a
 *  raw floor/ceiling/limit VALUE in anything creator-facing. See
 *  CREATOR_SAFE_REASON_KEYS below for the (separate, stricter) rule about
 *  which of these codes may drive creator-facing COPY at all. */
export type PolicyDecisionReasonCode = (typeof POLICY_DECISION_REASON_CODES)[number];

export interface PolicyDecision {
  category: PolicyTermCategory;
  outcome: PolicyDecisionOutcome;
  /** INTERNAL / audit-only. Never serialize this field into anything
   *  creator-facing — see CREATOR_SAFE_REASON_KEYS. */
  reasonCode: PolicyDecisionReasonCode;
  /** The value actually granted — only set when outcome = AUTO_APPROVED. */
  appliedValue?: number | string;
  /** A short, pre-approved, creator-safe sentence-template key. The ONLY
   *  field a creator-facing renderer may read for this decision. */
  creatorSafeReasonKey?: string;
}

// ---------------------------------------------------------------------------
// Creator-safety rule (review fix — see plan §3.4/§5.6)
// ---------------------------------------------------------------------------
// reasonCode alone, even with no raw number attached, is a signal: across
// several negotiation rounds, a creator lowering their ask each time and
// watching "exceeds_limit" flip to something else can binary-search the
// brand's real ceiling using nothing but which reason code came back. The
// fix is that a creator must NEVER be able to distinguish "you're over my
// configured limit" from "I don't auto-decide this at all" from the
// response alone — both collapse to the same generic copy.
//
// creatorSafeReasonKey MUST be looked up through this map (never invented
// ad hoc by a caller) so the collapsing rule can't be silently bypassed by
// a new call site choosing its own key for "exceeds_limit".
export const CREATOR_SAFE_REASON_KEYS: Partial<Record<PolicyDecisionReasonCode, string>> = {
  // "requires_approval_generic" is intentionally the SAME key for all
  // three — see the rule above. Do not split these back apart.
  exceeds_limit: "requires_approval_generic",
  explicitly_fixed: "requires_approval_generic",
  mode_requires_approval: "requires_approval_generic",
  out_of_policy_reject: "not_available",
  within_limit: "approved",
  matches_public_offer: "approved",
};

/** The only sanctioned way to derive a creator-facing key from a
 *  PolicyDecision — returns undefined (render nothing creator-facing) for
 *  any reasonCode not in the map, rather than falling back to the raw
 *  internal code. */
export function creatorSafeReasonKeyFor(reasonCode: PolicyDecisionReasonCode): string | undefined {
  return CREATOR_SAFE_REASON_KEYS[reasonCode];
}

// ---------------------------------------------------------------------------
// Frozen evaluator rule (review fix — relocated from a comment inside an
// unreachable branch of the PATCH route's validation, where PLU-175 would
// never have read it)
// ---------------------------------------------------------------------------
/**
 * PLU-172 (worksheet, Paid/Hybrid fee policy): "A Request Rate Card
 * campaign has no numeric public starting fee. A submitted creator rate
 * must not be treated as autonomously approved unless an explicit limit
 * authorizes it; otherwise it requires brand approval."
 *
 * Binding on the FEE evaluator (PLU-175): when the pinned snapshot's
 * priceStrategy is "REQUEST_RATE_CARD" (no publicStartingFeeCents exists to
 * compare a submitted rate against) AND feeMode is anything other than
 * ALLOW_WITHIN_LIMIT with an explicit ceilingCents set, a submitted rate's
 * PolicyDecision.outcome MUST be REQUIRES_BRAND_APPROVAL (reasonCode
 * "no_limit_configured"), NEVER AUTO_APPROVED — there is no public number
 * and no configured limit for "within limit" to mean anything against.
 */
export const REQUEST_RATE_CARD_REQUIRES_EXPLICIT_LIMIT = true;

// ---------------------------------------------------------------------------
// Multi-term counters (Calvin review, point C)
// ---------------------------------------------------------------------------
// A single creator reply can change several unrelated terms in one message
// — "I'll do 1 Reel instead of 2, but I need $650 and 5 extra days" is a
// deliverables delta + a fee CounterDelta + a posting CounterDelta, all in
// one turn. `CounterDelta` already models ONE category per object (§ above)
// precisely so a turn is naturally `CounterDelta[]`, one entry per term
// touched — nothing further is needed to CAPTURE multiple simultaneous
// asks. What's missing is the OUTPUT side: PLU-175/176/178's evaluators
// each decide their own category independently, but the engine needs both
// (a) every individual decision, preserved, for the eventual reply/audit
// trail, AND (b) ONE aggregate outcome to route the turn on (does this
// whole reply auto-approve, or does ANY part of it need a human/brand?).

/**
 * The complete result of evaluating every CounterDelta from one creator
 * turn. `decisions` preserves each individual PolicyDecision (one per
 * CounterDelta, same order) — nothing is collapsed or discarded.
 * `aggregateOutcome` is the SINGLE outcome the engine routes the turn on,
 * computed via `aggregateOutcome()` below — never set independently of the
 * individual decisions it's derived from.
 */
export interface AggregatePolicyDecision {
  decisions: PolicyDecision[];
  aggregateOutcome: PolicyDecisionOutcome;
}

// Most-restrictive-wins precedence: if ANY individual decision needs a
// human/brand or can't be evaluated at all, the WHOLE turn is routed that
// way — a turn is never auto-approved just because most of its terms were
// fine. REJECTED is the most restrictive because it's a hard stop; AMBIGUOUS
// and UNSUPPORTED both mean "we don't actually know," which must outrank a
// mere "needs approval" (a known, actionable state); AUTO_APPROVED only
// wins when EVERY decision independently auto-approved.
const OUTCOME_PRECEDENCE: readonly PolicyDecisionOutcome[] = [
  "REJECTED",
  "AMBIGUOUS",
  "UNSUPPORTED",
  "REQUIRES_BRAND_APPROVAL",
  "AUTO_APPROVED",
];

/**
 * Reduces a turn's individual PolicyDecisions to the ONE outcome the engine
 * routes on. Empty input has no meaningful aggregate — callers should not
 * invoke this for a turn with zero decisions (nothing was proposed).
 */
export function aggregateOutcome(decisions: readonly PolicyDecision[]): PolicyDecisionOutcome {
  let worst = "AUTO_APPROVED" as PolicyDecisionOutcome;
  let worstRank = OUTCOME_PRECEDENCE.indexOf(worst);
  for (const d of decisions) {
    const rank = OUTCOME_PRECEDENCE.indexOf(d.outcome);
    if (rank < worstRank) {
      worst = d.outcome;
      worstRank = rank;
    }
  }
  return worst;
}

/** Convenience wrapper — builds the full AggregatePolicyDecision from a
 *  turn's individual decisions in one call. */
export function buildAggregatePolicyDecision(decisions: PolicyDecision[]): AggregatePolicyDecision {
  return { decisions, aggregateOutcome: aggregateOutcome(decisions) };
}
