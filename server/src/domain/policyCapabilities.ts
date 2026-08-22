// ---------------------------------------------------------------------------
// PLU-172 — the backend capability map
// ---------------------------------------------------------------------------
// The single source of truth for "which private-policy controls this build
// of Pluvus can actually execute end-to-end." Replaces the hand-maintained
// FieldSpec.uiOnly boolean in web/.../sections.ts (PLU-173's job to consume
// this, not this ticket's — see docs/plu-172-private-policy-contract-plan.md
// §2/§9) — that flag was maintained by a human reading a 3-item checklist
// and manually flipping it, with a code comment begging future-editors not
// to jump the gun (docs/PLU-140-future-only-fields.md). A category here
// reports `executable` only when every one of `persisted`/`snapshotted`/
// `evaluated` is independently true — structurally impossible to claim
// "executable" without every leg actually present, because `executable` is
// never set directly (see isExecutable below).

import type { PolicyTermCategory } from "./policyDecision.js";

export interface PolicyCapability {
  category: PolicyTermCategory;
  /** A NegotiationPolicy column/jsonb slot exists for this category. */
  persisted: boolean;
  /** The same field is copied into NegotiationPolicySnapshot at launch. */
  snapshotted: boolean;
  /** A deterministic evaluator (PLU-175/176/178) reads this category and
   *  produces a real PolicyDecision for it. This is the ONE field in this
   *  file that must be hand-flipped when its owning ticket ships an
   *  evaluator — "does an evaluator exist" cannot be derived from the
   *  schema the way persisted/snapshotted can. */
  evaluated: boolean;
  /**
   * Calvin review (item 11): some categories can support evaluation for
   * one VARIANT before another — e.g. "commission" backs both a percentage
   * rate (commissionCeilingRate) and a flat amount
   * (commissionCeilingAmountCents), and PLU-175 could plausibly land
   * percent support before flat. `evaluated` alone can't represent "partly
   * evaluated" without becoming ambiguous, so this optional list names
   * which unit(s) `evaluated` is actually true FOR when it's true, and — if
   * a category ever needs it — lets a category be marked evaluated:true
   * while still being incomplete for one variant, without inventing a
   * second boolean per category. Absent = the category has no meaningful
   * sub-variants (evaluated applies to the whole category uniformly, the
   * common case). This is a contract addition, not a rollout mechanism —
   * PLU-172 does not use partial evaluation anywhere; it just makes the
   * TYPE able to represent it once an evaluator ticket actually needs to.
   */
  supportedUnits?: readonly string[];
}

// PLU-172 ships persisted+snapshotted storage for every category below;
// evaluated stays false until PLU-175/176/178 lands the evaluator for that
// category — flipped ONLY by that ticket's own PR, and by no other change
// (this file's diff in that PR IS the capability flip).
//
// PLU-175 (domain/compensationPolicyEvaluator.ts) flips the five
// compensation-shaped categories below. commission is evaluated:true with
// supportedUnits narrowed to ["percent"] only — the worksheet's own text
// ("Unsupported flat or Two-level public structures remain unavailable ...
// until their complete public/private contract is enabled") explicitly
// scopes flat out of THIS ticket; a commissionMode: "flat" proposal returns
// UNSUPPORTED from the evaluator, matching supportedUnits here exactly.
//
// PLU-176 (domain/rightsPolicyEvaluator.ts) flips exclusivity/
// adAuthorization/postRetention/contentRepurposeRights/scriptSubmission
// below. usageRights deliberately stays evaluated:false — it predates the
// Page-6 structured duration fields and has no reliable duration
// semantics; the ticket's own enabled-terms list omits it (see
// docs/plu-176-rights-policy-evaluator-plan.md §4.1). It shares
// rightsPolicyRules.ts's RIGHTS_TERMS storage shape with the other four
// rights-family terms, but sharing a storage shape is a write-time
// (PLU-172) concern, not an evaluation-readiness claim — this file's whole
// reason for existing is keeping those two axes independent.
export const POLICY_CAPABILITIES: readonly PolicyCapability[] = [
  { category: "fee", persisted: true, snapshotted: true, evaluated: true },
  { category: "commission", persisted: true, snapshotted: true, evaluated: true, supportedUnits: ["percent"] },
  { category: "commissionDuration", persisted: true, snapshotted: true, evaluated: true, supportedUnits: ["days", "lifetime", "count"] },
  { category: "giftSubstitution", persisted: true, snapshotted: true, evaluated: true },
  { category: "giftCashReplacement", persisted: true, snapshotted: true, evaluated: true },
  { category: "deliverables", persisted: true, snapshotted: true, evaluated: false },
  { category: "posting", persisted: true, snapshotted: true, evaluated: false },
  { category: "usageRights", persisted: true, snapshotted: true, evaluated: false },
  { category: "exclusivity", persisted: true, snapshotted: true, evaluated: true },
  { category: "adAuthorization", persisted: true, snapshotted: true, evaluated: true },
  { category: "postRetention", persisted: true, snapshotted: true, evaluated: true },
  { category: "contentRepurposeRights", persisted: true, snapshotted: true, evaluated: true },
  // Calvin review: its own dedicated mode/column now (scriptWaiverMode),
  // not a rightsPolicyRules entry — still one capability entry, unchanged.
  { category: "scriptSubmission", persisted: true, snapshotted: true, evaluated: true },
];

export function getPolicyCapability(category: PolicyTermCategory): PolicyCapability | undefined {
  return POLICY_CAPABILITIES.find((c) => c.category === category);
}

/** A category is executable only when every leg is true — never set
 *  directly on a PolicyCapability record, always derived. */
export function isExecutable(category: PolicyTermCategory): boolean {
  const cap = getPolicyCapability(category);
  return Boolean(cap?.persisted && cap.snapshotted && cap.evaluated);
}
