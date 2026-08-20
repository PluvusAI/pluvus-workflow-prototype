import type { NodeResult } from "../types.js";
import { maskGuardHits, type GuardHit } from "../guards/outputGuard.js";

// ---------------------------------------------------------------------------
// Shared output-guard escalation (FIX-4)
// ---------------------------------------------------------------------------
// When the output guard blocks an AI-generated draft (a leaked floor/ceiling or
// internal term), the email is NOT sent and the instance routes to MANUAL_REVIEW
// so a human reviews before anything reaches the creator. The negotiation
// executor has an equivalent inline helper; this standalone version lets other
// executors (e.g. Reward Setup) apply the same policy without importing from a
// node module. The offending draft body is deliberately not persisted — only the
// leaked tokens are recorded for audit.
export function blockedByGuard(round: number, hits: GuardHit[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "output_guard_blocked",
      round,
      // EASY-S2: mask the band VALUE — record only which KIND leaked.
      leaks: maskGuardHits(hits),
    },
  };
}

// BUG-E2: the payout-form submission mints the Partnership + fee Obligation (the
// money ledger). If that mint fails (a DB blip, or resolvePartnership returns
// null), the OLD code swallowed it and STILL returned the success terminal
// (CONTENT_BRIEF_SENT / PAYMENT_RECEIVED) — a "completed" deal with no
// Partnership, no link, and no Obligation: the creator is owed money with no
// ledger row, no retry, and no reconciliation (the terminal state is excluded
// from RECONCILE_STATES). Instead, route to MANUAL_REVIEW: the deal is NOT
// falsely completed, the brand is emailed (runtime does this on entry), and a
// human can re-run the node to complete the mint. The creator's payout data is
// already persisted (PaymentInfo is PAYMENT_RECEIVED), so nothing is lost.
export function blockedByAttributionMint(node: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "attribution_mint_failed",
      node,
    },
  };
}

// PLU-137/138: the same MANUAL_REVIEW shape the four post-accept executors
// (contentBrief / rewardSetup / operatorHandoff / brandApproval) each need when
// loadPinnedTermsSnapshotForExecutor reports an integrity failure (a missing or
// cross-campaign pinned terms snapshot). Pulled out here — the exact same
// precedent as blockedByMissingBrand/blockedByAttributionMint below — instead
// of repeating the identical object literal at all 4 call sites.
export function blockedBySnapshotIntegrity(node: string, reason: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: {
      outcome: "ESCALATE",
      reason,
      node,
    },
  };
}

// PLU-169 (1f) — Review fix (PR #48): resolveFinalDeliverables now fails the
// WHOLE resolution (instead of silently dropping only the invalid items) when
// the pinned snapshot's deliverableQuantities don't pass the shared
// deliverablesSchema (an invalid platform/format combination, or a genuinely
// malformed item). Escalate BEFORE the accept email is drafted/sent — same
// NEGOTIATION_TURN/round shape as blockedByGuard above, since this fires from
// negotiation.ts's own "accept" case, not a separate post-accept node.
export function blockedByInvalidFinalDeliverables(round: number, reason: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "invalid_final_deliverables",
      detail: reason,
      round,
    },
  };
}

// L4: fail loud when a creator-facing email has no resolvable brand name (config
// AND campaign both missing it). Rather than send "Thanks, your brand" to a real
// creator, route the instance to MANUAL_REVIEW so a human fixes the config. This
// only fires on a genuinely mis-stamped / orphaned instance (restampBrand
// normally always sets brandName).
export function blockedByMissingBrand(node: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "missing_brand_name",
      node,
    },
  };
}
