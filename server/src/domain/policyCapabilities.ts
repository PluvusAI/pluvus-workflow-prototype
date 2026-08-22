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
// evaluated stays false for ALL of them until PLU-175/176/178 lands the
// evaluator for that category — flipped ONLY by that ticket's own PR, and
// by no other change (this file's diff in that PR IS the capability flip).
export const POLICY_CAPABILITIES: readonly PolicyCapability[] = [
  { category: "fee", persisted: true, snapshotted: true, evaluated: false },
  // "percent" backs commissionCeilingRate, "flat" backs
  // commissionCeilingAmountCents (schema.ts) — both exist today; this list
  // documents that a future evaluator MAY roll out to just one first.
  { category: "commission", persisted: true, snapshotted: true, evaluated: false, supportedUnits: ["percent", "flat"] },
  { category: "commissionDuration", persisted: true, snapshotted: true, evaluated: false, supportedUnits: ["days", "lifetime", "count"] },
  { category: "giftSubstitution", persisted: true, snapshotted: true, evaluated: false },
  { category: "giftCashReplacement", persisted: true, snapshotted: true, evaluated: false },
  { category: "deliverables", persisted: true, snapshotted: true, evaluated: false },
  { category: "posting", persisted: true, snapshotted: true, evaluated: false },
  { category: "usageRights", persisted: true, snapshotted: true, evaluated: false },
  { category: "exclusivity", persisted: true, snapshotted: true, evaluated: false },
  { category: "adAuthorization", persisted: true, snapshotted: true, evaluated: false },
  { category: "postRetention", persisted: true, snapshotted: true, evaluated: false },
  { category: "contentRepurposeRights", persisted: true, snapshotted: true, evaluated: false },
  // Calvin review: its own dedicated mode/column now (scriptWaiverMode),
  // not a rightsPolicyRules entry — still one capability entry, unchanged.
  { category: "scriptSubmission", persisted: true, snapshotted: true, evaluated: false },
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
