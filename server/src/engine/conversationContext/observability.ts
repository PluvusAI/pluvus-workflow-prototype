// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: OBSERVABILITY (§7.2)
// ---------------------------------------------------------------------------
// The sanitized contextRecord folded onto the NEGOTIATION_TURN payload (the PLU-82
// mapKnowledge pattern). Every field is labels/keys/counts, never values; band
// values NEVER enter this (§7.5).

import { toDecisionContext } from "./projections.js";
import { isAuthorizedDecisionPurpose } from "./types.js";
import type { AssembledContext, ContextRecord } from "./types.js";

/**
 * Build the sanitized contextRecord (§7.2). Every field is labels/keys/counts,
 * never values. Band values NEVER enter this (§7.5). Computed on the DECISION
 * projection's debug (per-purpose §7.3). Folded onto the turn payload by the
 * executor exactly where the knowledgeRecord is folded today (the PLU-82 pattern).
 */
export function buildContextRecord(ctx: AssembledContext): ContextRecord {
  const decision = toDecisionContext(ctx);
  return {
    purpose: ctx.purpose,
    messageIdsIncluded: ctx.recentMessages
      .map((m) => m.messageId)
      .filter((id): id is string => typeof id === "string"),
    eventCount: ctx.decisionHistory.history.length,
    campaignFieldsSelected: Object.keys(ctx.flatKnowledge),
    briefSectionsUsed: ctx.briefSections ? Object.keys(ctx.briefSections) : [],
    openObligationIds: ctx.openObligationRows.map((o) => o.id),
    ...(ctx.conversationSummary?.version
      ? { summaryVersion: ctx.conversationSummary.version }
      : {}),
    estimatedTokens: decision.debug.estimatedTokens,
    sourcesUsed: decision.debug.sourcesUsed,
    bandPresent: ctx.campaignConstraints.bandPresent,
    // PLU-137 §4a — snapshot ids + booleans + reason string ONLY, never policy VALUES.
    // termsSnapshotId is a public-terms pointer (always safe); policySnapshotId is a
    // PRIVATE-authority pointer, emitted ONLY for an authorized decision purpose
    // (Defect 4) — reads `purpose` only, never a fee field (E12). The guidance/floor/
    // ceiling VALUES never enter this record (same rule the band follows).
    ...(ctx.termsSnapshot ? { termsSnapshotId: ctx.termsSnapshot.id } : {}),
    ...(ctx.policySnapshot && isAuthorizedDecisionPurpose(ctx.purpose)
      ? { policySnapshotId: ctx.policySnapshot.id }
      : {}),
    legacyFallbackUsed: ctx.legacyFallbackUsed,
    ...(ctx.integrityFailure ? { integrityFailureReason: ctx.integrityFailure.reason } : {}),
  };
}
