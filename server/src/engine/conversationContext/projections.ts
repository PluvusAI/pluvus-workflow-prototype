// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: PURE PROJECTIONS (§4.2)
// ---------------------------------------------------------------------------
// Purpose-gating by TYPE, not by getter. toDecisionContext is band-FULL;
// toDraftContext is band-STRIPPED and STRUCTURALLY lacks any band field (§4.3).
// Both are PURE — zero new I/O over the already-built AssembledContext.

import type { PriorNegotiationContext } from "../types.js";
// §4.3: the band-key list is the ONE source of truth. toDraftContext strips using
// this exact list rather than re-listing the keys (BAND_CONTEXT_KEYS strips the raw
// minBudget/maxBudget too — the real leak surface).
import { stripBandFromContext } from "../providerFactory.js";
import { estimateTokens } from "./assemble.js";
import type {
  AssembledContext,
  ContextDebug,
  DecisionContext,
  DraftContext,
  PolicyAuthority,
} from "./types.js";

// PLU-137 §3b — the PRIVATE policy-snapshot value keys. The regression net (mirror of
// BAND_CONTEXT_KEYS): a payload test asserts NONE of these appear in the draft provider
// payload. Structural exclusion is enforced by DraftContext having no policyAuthority
// field at all; this list is the explicit assert surface behind that guarantee.
export const POLICY_SNAPSHOT_KEYS = [
  "floorCents",
  "ceilingCents",
  "preferredFeeCents",
  "commissionRate",
  "maxRounds",
  "openingOfferPosition",
  "overCeilingTolerance",
  "negotiationGuidance",
  "negotiableTerms",
  "nonNegotiableTerms",
] as const;

// PLU-137 §3a — project the pinned NegotiationPolicySnapshot row to the decision-facing
// PolicyAuthority (drops db bookkeeping cols: id/campaignId/launchedAt/createdAt). Every
// value nullable — a GIFT/affiliate deal legitimately has null fee fields (E12 corollary).
function toPolicyAuthority(
  snap: NonNullable<AssembledContext["policySnapshot"]>,
): PolicyAuthority {
  return {
    floorCents: snap.floorCents,
    ceilingCents: snap.ceilingCents,
    preferredFeeCents: snap.preferredFeeCents,
    commissionRate: snap.commissionRate,
    maxRounds: snap.maxRounds,
    openingOfferPosition: snap.openingOfferPosition,
    overCeilingTolerance: snap.overCeilingTolerance,
    negotiationGuidance: snap.negotiationGuidance,
    negotiableTerms: snap.negotiableTerms,
    nonNegotiableTerms: snap.nonNegotiableTerms,
  };
}

/** Build the shared debug block for a projected view (§7). Per-purpose (§7.3):
 *  the token estimate is computed over the projected view passed in. */
function buildDebug(
  ctx: AssembledContext,
  view: unknown,
  extraSources: string[],
): ContextDebug {
  const sources: string[] = [];
  // §7.4 — provenance labels only ("available" sources), never ids-with-values.
  for (const k of Object.keys(ctx.flatKnowledge)) sources.push(`campaign:${k}`);
  if (ctx.briefSections) {
    for (const k of Object.keys(ctx.briefSections)) sources.push(`brief:${k}`);
  }
  for (const o of ctx.structuredObligations) {
    if (o.category) sources.push(`obligation:${o.category}`);
  }
  if (ctx.recentMessages.length) sources.push(`transcript:${ctx.recentMessages.length}turns`);
  if (ctx.creatorMemory) sources.push("memory:present");
  if (ctx.conversationSummary) sources.push("summary:present");
  sources.push(...extraSources);

  return {
    purpose: ctx.purpose,
    sourcesUsed: dedupe(sources),
    estimatedTokens: estimateTokens(view),
    bandPresent: ctx.campaignConstraints.bandPresent,
    // PLU-137 — policy-snapshot PRESENCE only (mirror of bandPresent), never values.
    policyPresent: ctx.policySnapshot != null,
  };
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * NEGOTIATION_DECISION projection: band-FULL. PURE — zero new I/O.
 *
 * The decisionHistory it returns carries the band-FREE knowledge on
 * `.campaignContext` (attached ONLY when non-empty — §5.7 emptiness contract), the
 * both-sides transcript on `.conversationHistory`, openCommitments, and the
 * classify `.intent` (DECISION-only — §10). The band is NOT on this object; it's
 * resolved by buildNegotiationRequest from mergedConfig at request-build time.
 */
export function toDecisionContext(ctx: AssembledContext): DecisionContext {
  const decisionHistory: PriorNegotiationContext = {
    ...ctx.decisionHistory,
    ...(ctx.recentMessages.length ? { conversationHistory: ctx.recentMessages } : {}),
    ...(ctx.openCommitments.length ? { openCommitments: ctx.openCommitments } : {}),
    ...(ctx.classifiedIntent ? { intent: ctx.classifiedIntent } : {}),
    ...(Object.keys(ctx.knowledgeContext).length
      ? { campaignContext: ctx.knowledgeContext }
      : {}),
    // PLU-113: durable creator memory as sanitized DATA (attached ONLY when present
    // — flag off / empty ⇒ omitted, so the /negotiate prompt is byte-identical).
    ...(ctx.creatorMemory ? { creatorMemory: ctx.creatorMemory } : {}),
  };
  const debug = buildDebug(ctx, decisionHistory, [
    ...(ctx.campaignConstraints.bandPresent ? ["band:present"] : []),
    ...(ctx.classifiedIntent ? ["intent:decision-only"] : []),
  ]);
  return {
    decisionHistory,
    campaignConstraints: ctx.campaignConstraints,
    // PLU-137 §3a — the private policy authority, attached ONLY when a policy snapshot
    // was loaded (emptiness contract → the no-snapshot decision payload is unchanged).
    ...(ctx.policySnapshot ? { policyAuthority: toPolicyAuthority(ctx.policySnapshot) } : {}),
    creatorReply: ctx.creatorReply,
    round: ctx.instance.negotiationRound,
    debug,
  };
}

/**
 * EMAIL_DRAFT projection: band-STRIPPED. PURE — zero new I/O.
 *
 * §4.3 — draftConfig = stripBandFromContext(mergedConfig) merged with the SAME
 * knowledge keys negotiation.ts threaded into draftConfig (briefKnowledge from the
 * FALLBACK role + briefSections + structuredObligations). Contains NONE of
 * BAND_CONTEXT_KEYS. The band strip uses the shared BAND_CONTEXT_KEYS list (§4.3).
 *
 * NOTE: this projection does NOT expose openQuestions — that read mixes THIS turn's
 * creatorQuestions (post-decision) and stays in the executor (§5.6). It also does
 * not carry the per-branch `extra` (proposedTerms/creatorRequestedRate/…) — those
 * are turn-decision outputs the executor keeps (§4.4).
 */
export function toDraftContext(ctx: AssembledContext): DraftContext {
  // The /draft FALLBACK briefKnowledge role: negotiation.ts threaded resolvedBrief
  // .flatText onto draftConfig UNCONDITIONALLY (kept exactly as today so rules-mode /
  // guard-nulled turns still answer from the brief), independent of the negotiate
  // gating flags. So we read it from the brief directly, not from knowledgeContext.
  const briefKnowledge = ctx.brief.flatText;
  const draftConfig: Record<string, unknown> = {
    ...stripBandFromContext(ctx.mergedConfig),
    ...(briefKnowledge ? { briefKnowledge } : {}),
    ...(ctx.briefSections ? { briefSections: ctx.briefSections } : {}),
    ...(ctx.structuredObligations.length
      ? { structuredObligations: ctx.structuredObligations }
      : {}),
    // PLU-113: creator memory as a draftConfig key so it survives the band strip and
    // reaches DraftRequest.campaignContext.creatorMemory (the agent renders it there).
    // Attached only when present → draft prompt byte-identical when off.
    ...(ctx.creatorMemory ? { creatorMemory: ctx.creatorMemory } : {}),
  };
  // The draft projection is band-stripped and does not receive the per-branch
  // dealDescription extras assembled later by the executor. Neither can be
  // truthfully claimed as a source here.
  const debug = buildDebug(ctx, draftConfig, []);
  return {
    draftConfig,
    history: ctx.recentMessages,
    openCommitments: ctx.openCommitments,
    creatorMemory: ctx.creatorMemory,
    // PLU-137 §3b — PRESENCE only (mirror of the band's presence flag). A top-level
    // draft-surface boolean, NOT a draftConfig key — so it never rides the provider
    // payload. Raw policy VALUES are UNREACHABLE from this projection: the draftConfig
    // above is built key-by-key from stripBandFromContext(mergedConfig) + brief/
    // obligation keys and never touches ctx.policySnapshot.
    policyPresent: ctx.policySnapshot != null,
    debug,
  };
}
