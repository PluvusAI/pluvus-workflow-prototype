// ---------------------------------------------------------------------------
// PLU-176 — deterministic rights, exclusivity, and script-submission
// evaluator
// ---------------------------------------------------------------------------
// Consumes the frozen CounterDelta -> PolicyDecision contract PLU-172 froze
// in domain/policyDecision.ts — the same contract PLU-175's
// compensationPolicyEvaluator.ts already builds against. This module is the
// evaluator for exactly five PolicyTermCategory values: exclusivity,
// adAuthorization, postRetention, contentRepurposeRights, scriptSubmission.
//
// usageRights is DELIBERATELY not evaluated here despite sharing
// rightsPolicyRules.ts's RIGHTS_TERMS storage shape — see
// docs/plu-176-rights-policy-evaluator-plan.md §4.1 for the full argument
// (it predates the Page-6 structured duration fields and has no reliable
// duration semantics; the ticket's own enabled-terms list omits it).
//
// Pure, table-driven, no DB/executor/state-machine imports. See
// docs/plu-176-rights-policy-evaluator-plan.md for the full design
// rationale, including every place this ticket's text needed resolving and
// why several small helpers below are reimplemented locally rather than
// imported from compensationPolicyEvaluator.ts (§2 of that doc).

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
import {
  type RightsTerm,
  type RightsPolicyRule,
  type ScriptWaiverModeValue,
  type DurationUnitValue,
} from "./rightsPolicyRules.js";
import type { OutOfPolicyAction } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------
// Deliberately its OWN narrow interface (same posture as PLU-175's
// CompensationPolicySnapshot) — a flat mirror of the relevant
// CampaignDetails + NegotiationPolicy fields, identical whether the caller
// hands in a live row or a frozen snapshot read.

export interface RightsPolicySnapshot {
  // --- public terms (CampaignDetails-shaped) ---
  /** S6.3 — free text (e.g. "6 months"), never parsed for a numeric value.
   *  See rightsPolicyEvaluator plan doc §4.3 for why. */
  adAuthorization: string | null;
  /** S6.4 — same free-text posture as adAuthorization. */
  postRetention: string | null;
  /** PLU-172; no intake page collects this yet (compensationShape.ts's own
   *  activation projection already excludes it from any real snapshot for
   *  that reason) — supported here anyway so it starts working the moment
   *  an intake page ships, with zero evaluator changes. */
  contentRepurposeRights: string | null;
  /** Pre-PLU-139 free text. The literal string "None" (case/whitespace
   *  insensitive) is a recognized sentinel meaning "no exclusivity
   *  requirement" — see plan doc §4.5. No other "no exclusivity" phrasing
   *  is recognized; this is a deliberate, documented limitation, not a
   *  bug. */
  exclusivity: string | null;
  /** S5.6 — "require" | "skip" | null. Script-submission terms are only
   *  applicable when this is exactly "require". */
  scriptSubmission: string | null;

  // --- private policy (NegotiationPolicy-shaped) ---
  /** One entry per term with a NON-conservative mode; a term with no entry
   *  reads as KEEP_REQUESTED (rightsPolicyRules.ts's own
   *  resolveRightsMode rule — reapplied here directly since this file
   *  reads the raw array, not through that helper, to also access
   *  minimumValue/minimumUnit in the same lookup). */
  rightsPolicyRules: readonly RightsPolicyRule[];
  scriptWaiverMode: ScriptWaiverModeValue;
  outOfPolicyAction: OutOfPolicyAction;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
// Reimplemented locally rather than imported from
// compensationPolicyEvaluator.ts — see plan doc §2 for why (the PR
// boundary scopes this ticket to its own new files; extracting a shared
// helper module is a real option for a THIRD evaluator to justify, not
// this one).

/** Builds a PolicyDecision with creatorSafeReasonKey ALWAYS derived through
 *  the frozen creatorSafeReasonKeyFor() map — identical discipline to
 *  compensationPolicyEvaluator.ts's decide(). */
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
 * S8.E1's outOfPolicyAction fallback, identical to
 * compensationPolicyEvaluator.ts's own outOfPolicyDecision — see that
 * file's doc comment, and plan doc §4.2 for why this ticket makes the same
 * call on the same still-open cross-ticket question rather than diverging.
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
 *  resolved either way, for ANY category — checked first, uniformly,
 *  before any category-specific logic runs. This is also this evaluator's
 *  ENTIRE answer to "novel clauses, contradictory wording, ... ambiguous
 *  legal meaning must escalate" (plan doc §4.7) — this module does no
 *  natural-language analysis of its own; it trusts the upstream
 *  normalization signal. */
function checkAmbiguous(delta: CounterDelta): PolicyDecision | null {
  if (delta.normalization === "AMBIGUOUS") {
    return decide(delta.category, "AMBIGUOUS", "ambiguous_proposal");
  }
  return null;
}

/** Every numeric proposal this evaluator reads is a non-negative duration
 *  quantity (days or a count) — identical guard and reasoning to
 *  compensationPolicyEvaluator.ts's asNonNegativeFiniteNumber. Never
 *  coerces a numeric-looking string. */
function asNonNegativeFiniteNumber(v: number | string | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

const DURATION_UNITS: readonly DurationUnitValue[] = ["DAYS", "LIFETIME", "COUNT"];
function isDurationUnit(v: unknown): v is DurationUnitValue {
  return typeof v === "string" && (DURATION_UNITS as readonly string[]).includes(v);
}

function hasTextValue(v: string | null): v is string {
  return v != null && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// The four duration-bearing rights-family terms (S8.C3)
// ---------------------------------------------------------------------------

// as const + satisfies keeps this a NARROW literal tuple (needed for
// EvaluatedDurationTerm below) while statically guaranteeing every entry is
// a real RightsTerm — a typo here would be a compile error, not a silent
// dispatch gap.
const EVALUATED_DURATION_TERMS = [
  "exclusivity",
  "adAuthorization",
  "postRetention",
  "contentRepurposeRights",
] as const satisfies readonly RightsTerm[];
type EvaluatedDurationTerm = (typeof EVALUATED_DURATION_TERMS)[number];
const EVALUATED_DURATION_TERM_SET: ReadonlySet<string> = new Set(EVALUATED_DURATION_TERMS);

function getPublicDurationValue(term: EvaluatedDurationTerm, snap: RightsPolicySnapshot): string | null {
  return snap[term];
}

/** exclusivity's own "None" sentinel (plan doc §4.5) — checked in addition
 *  to, not instead of, the ordinary has-a-value check every term gets. */
function isNoneSentinel(value: string): boolean {
  return value.trim().toLowerCase() === "none";
}

function isActivePublicTerm(term: EvaluatedDurationTerm, value: string | null): boolean {
  if (!hasTextValue(value)) return false;
  if (term === "exclusivity" && isNoneSentinel(value)) return false;
  return true;
}

/**
 * S8.C3: KEEP_REQUESTED / ALLOW_TO_MINIMUM / ASK_FOR_APPROVAL for one
 * duration-bearing rights-family term. See plan doc §4.3 for why the
 * public free-text value is used only as an ACTIVE/INACTIVE gate, never
 * parsed for a numeric comparison — every numeric comparison here is
 * against the STRUCTURED private minimum only.
 */
function evaluateDurationRightsTerm(
  term: EvaluatedDurationTerm,
  delta: CounterDelta,
  snap: RightsPolicySnapshot,
): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (!isActivePublicTerm(term, getPublicDurationValue(term, snap))) {
    return decide(term, "UNSUPPORTED", "unsupported_operation");
  }

  // Absence is conservative (rightsPolicyRules.ts's own resolveRightsMode
  // rule, reapplied directly here so this same lookup also yields
  // minimumValue/minimumUnit for the ALLOW_TO_MINIMUM branch below).
  const rule = snap.rightsPolicyRules.find((r) => r.term === term);
  const mode = rule?.mode ?? "KEEP_REQUESTED";

  switch (mode) {
    case "ALLOW_TO_MINIMUM": {
      // Review fix (C1): the unit check used to run unconditionally before
      // the mode was even looked up, so a KEEP_REQUESTED or ASK_FOR_APPROVAL
      // term with a malformed/missing unit incorrectly short-circuited to
      // UNSUPPORTED/missing_unit instead of reaching its own mode branch —
      // contradicting "any proposal under KEEP_REQUESTED is treated as a
      // request to relax the term, full stop" (plan doc §4.3), and (under
      // outOfPolicyAction: REJECT_REQUEST) silently swapping a REJECTED
      // result for UNSUPPORTED, which ranks differently in
      // buildAggregatePolicyDecision's precedence. A unit is only ever
      // actually USED in this ALLOW_TO_MINIMUM branch, so the check now
      // lives here, and only here.
      if (!isDurationUnit(delta.proposedUnit)) {
        return decide(term, "UNSUPPORTED", "missing_unit");
      }
      const proposedUnit = delta.proposedUnit;
      const minimumUnit = rule?.minimumUnit;
      if (minimumUnit == null) {
        // Deliberate asymmetry (review fix, documented per C3): an
        // out-of-bound proposal (below) is routed through
        // outOfPolicyDecision and can become REJECTED under
        // outOfPolicyAction: REJECT_REQUEST. A MISCONFIGURED rule — mode
        // says ALLOW_TO_MINIMUM but no minimum was ever set — always asks
        // instead, never rejects, regardless of outOfPolicyAction: a
        // config gap is not the creator's fault, so it never produces a
        // hard REJECTED. Same rule PLU-175 already applies for
        // no_limit_configured throughout compensationPolicyEvaluator.ts.
        return decide(term, "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      // Never silently convert DAYS <-> COUNT <-> LIFETIME.
      if (proposedUnit !== minimumUnit) {
        return decide(term, "UNSUPPORTED", "missing_unit");
      }
      if (minimumUnit === "LIFETIME") {
        // LIFETIME is the most restrictive possible FLOOR (plan doc §4.4)
        // — matching it exactly is the only way "at or above" can ever be
        // satisfied. appliedValue is deliberately left UNSET here (review
        // fix, B2): delta.proposedValue is unvalidated at this point (no
        // asNonNegativeFiniteNumber guard applies when the unit is
        // LIFETIME, since there is no numeric floor to check it against),
        // so passing it straight through as appliedValue would let a
        // malformed/negative/non-numeric proposedValue leak into the
        // decision. The unit match alone is the grant; no numeric value is
        // ever read OR recorded on this path.
        return decide(term, "AUTO_APPROVED", "within_limit");
      }
      const minimumValue = rule?.minimumValue;
      if (minimumValue == null) {
        return decide(term, "REQUIRES_BRAND_APPROVAL", "no_limit_configured");
      }
      const proposedValue = asNonNegativeFiniteNumber(delta.proposedValue);
      if (proposedValue === null) {
        return decide(term, "UNSUPPORTED", "missing_unit");
      }
      if (proposedValue >= minimumValue) {
        return decide(term, "AUTO_APPROVED", "within_limit", proposedValue);
      }
      // Reused reasonCode, same posture as PLU-175 reusing exceeds_limit
      // for gift-substitution's "not on the approved list" — the code is
      // internal/audit-only and both situations mean "outside the
      // authorized bound."
      return outOfPolicyDecision(term, snap.outOfPolicyAction, "exceeds_limit");
    }
    case "ASK_FOR_APPROVAL":
      return decide(term, "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "KEEP_REQUESTED":
    default:
      // No structured public value to compare against (plan doc §4.3) — a
      // KEEP_REQUESTED term treats ANY proposal as a request to relax it,
      // regardless of what unit (or no unit at all) it was expressed in.
      return outOfPolicyDecision(term, snap.outOfPolicyAction, "explicitly_fixed");
  }
}

// ---------------------------------------------------------------------------
// Script/idea submission waiver (S8.C5)
// ---------------------------------------------------------------------------

/**
 * scriptWaiverMode has no minimum concept at all (rightsPolicyRules.ts's
 * own comment: "ALLOW_TO_MINIMUM has no meaning for a boolean-ish 'require
 * the script or not' term") — a scriptSubmission CounterDelta carries no
 * numeric value; its mere presence, once checkAmbiguous passes, IS the ask
 * (plan doc §4.6).
 */
function evaluateScriptSubmission(delta: CounterDelta, snap: RightsPolicySnapshot): PolicyDecision {
  const ambiguous = checkAmbiguous(delta);
  if (ambiguous) return ambiguous;

  if (snap.scriptSubmission !== "require") {
    return decide("scriptSubmission", "UNSUPPORTED", "unsupported_operation");
  }

  switch (snap.scriptWaiverMode) {
    case "ALLOW_WAIVER":
      return decide("scriptSubmission", "AUTO_APPROVED", "within_limit");
    case "ASK_FOR_APPROVAL":
      return decide("scriptSubmission", "REQUIRES_BRAND_APPROVAL", "mode_requires_approval");
    case "KEEP_SUBMISSION_REQUIRED":
    default:
      return outOfPolicyDecision("scriptSubmission", snap.outOfPolicyAction, "explicitly_fixed");
  }
}

// ---------------------------------------------------------------------------
// Dispatch + package (multi-term, atomic) evaluation
// ---------------------------------------------------------------------------

/** Evaluates ONE CounterDelta. usageRights (plan doc §4.1) and every
 *  category this evaluator doesn't own (fee/commission/deliverables/
 *  posting/etc.) return UNSUPPORTED rather than being silently skipped or
 *  guessed at — identical posture to compensationPolicyEvaluator.ts's own
 *  dispatcher. */
export function evaluateRightsTerm(
  delta: CounterDelta,
  snapshot: RightsPolicySnapshot,
): PolicyDecision {
  if (delta.category === "scriptSubmission") {
    return evaluateScriptSubmission(delta, snapshot);
  }
  if (EVALUATED_DURATION_TERM_SET.has(delta.category)) {
    return evaluateDurationRightsTerm(delta.category as EvaluatedDurationTerm, delta, snapshot);
  }
  return decide(delta.category, "UNSUPPORTED", "unsupported_operation");
}

/**
 * Evaluates every CounterDelta from one creator turn against ONE
 * RightsPolicySnapshot and reduces them to a single package-level outcome
 * via policyDecision.ts's own most-restrictive-wins
 * buildAggregatePolicyDecision — reused verbatim, not reimplemented,
 * identical to compensationPolicyEvaluator.ts's evaluateCompensationPackage.
 */
export function evaluateRightsPackage(
  deltas: readonly CounterDelta[],
  snapshot: RightsPolicySnapshot,
): AggregatePolicyDecision {
  const decisions = deltas.map((delta) => evaluateRightsTerm(delta, snapshot));
  return buildAggregatePolicyDecision(decisions);
}
