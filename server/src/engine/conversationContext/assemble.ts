// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: PURE ASSEMBLE CORE (§8)
// ---------------------------------------------------------------------------
// The unit-testable heart: rows in → AssembledContext out, NO DB, NO HTTP. Mirrors
// the inline assembly negotiation.ts used to do (§5), so the projections feed
// byte-identical request shapes (§10). Internal derivation helpers live here too.

import type { Event, Message } from "../../db/schema.js";
import {
  buildPriorContextFromEvents,
  buildDatedDraftHistory,
  buildOpenObligations,
  buildStructuredObligations,
} from "../executors/negotiationHistory.js";
import {
  briefRefFromGraph,
  deriveBriefAvailability,
  type ResolvedBrief,
} from "../executors/briefKnowledge.js";
import { extractReplyText } from "../executors/replyText.js";
import type { AssembledContext, AssembleInputs } from "./types.js";
import { LatestMessageMismatchError } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers (kept byte-identical to the former inline negotiation logic)
// ---------------------------------------------------------------------------

// The four authoritative flat knowledge fields. Exported through the barrel and
// re-exported from negotiation.ts for backward-compatible tests/callers, so the
// builder's live projection and its regression tests share one implementation.
export const FLAT_KNOWLEDGE_KEYS = [
  "usageRights",
  "exclusivity",
  "paymentTerms",
  "attributionWindow",
] as const;

export function projectFlatKnowledge(
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FLAT_KNOWLEDGE_KEYS) {
    const v = config[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

// PLU-114: project ResolvedBrief.sections ({key: CampaignBriefSection}) to the
// {key: text} map the agent's AvailableSections.brief consumes. Returns undefined
// when there are no non-empty sections so the caller omits the wire key entirely.
function projectBriefSections(
  sections: ResolvedBrief["sections"],
): Record<string, string> | undefined {
  if (!sections) return undefined;
  const out: Record<string, string> = {};
  for (const [key, section] of Object.entries(sections)) {
    const text = section?.text;
    if (typeof text === "string" && text.trim()) {
      out[key] = text;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// The brief-into-negotiate gating flags (read at ASSEMBLE time — the same reads
// negotiation.ts did inline, so flag-off assembly is byte-identical). These read
// process.env exactly as the executor did (not an unbuilt module), so the builder
// still compiles (§9 MED-6 is about PLU-112/113 flags, not these).
function briefIntoNegotiateEnabled(): boolean {
  return process.env["BRIEF_INTO_NEGOTIATE"] === "true";
}
function knowledgeRetrievalEnabled(): boolean {
  return process.env["KNOWLEDGE_RETRIEVAL_ENABLED"] === "true";
}

// The creator's most recent inbound message, EXCLUDING brand-reply-tagged inbounds.
// Mirrors loadCreatorInbounds' latest-selection so the builder derives "latest"
// identically (§5.4). `brandReplyMsgIds` is built from INBOUND_REPLY_RECEIVED events
// tagged brandDecisionReply.
function deriveBrandReplyMsgIds(events: Event[]): Set<string> {
  return new Set(
    events
      .filter((e) => e.type === "INBOUND_REPLY_RECEIVED")
      .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
      .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
      .filter((id): id is string => typeof id === "string"),
  );
}

function selectLatestInbound(
  messages: Message[],
  brandReplyMsgIds: Set<string>,
): Message | undefined {
  return messages
    .filter((m) => m.direction === "INBOUND")
    .filter((m) => !(m.externalMessageId && brandReplyMsgIds.has(m.externalMessageId)))
    .at(-1);
}

// A coarse chars/4 token proxy over an arbitrary object (§7.3). Labeled as a proxy
// by its consumers; deterministic key order via JSON.stringify of the built view.
// Exported so the projections' buildDebug computes the per-purpose estimate.
export function estimateTokens(view: unknown): number {
  const serialized = JSON.stringify(view) ?? "";
  return Math.ceil(serialized.length / 4);
}

// ---------------------------------------------------------------------------
// Pure assemble core — the unit-testable heart (no DB, no HTTP) — §8
// ---------------------------------------------------------------------------

/**
 * Assemble the band-FULL internal read-model from already-fetched rows + a resolved
 * brief + loaded optional slots. PURE — no I/O. Mirrors the inline assembly
 * negotiation.ts did (§5), so the projections feed byte-identical request shapes
 * (§10).
 *
 * §5.1 / §6.2: mergeCampaignFallback already ran ONCE in the executor and was threaded
 * in via inputs.mergedConfig — the canonical source for band resolution, conflict
 * detection, flat-knowledge, AND draftConfig.
 * §5.4: "latest" is derived internally; a supplied latestMessageId is a validated
 * consistency check, never an authoritative override.
 * §5.5: brief carries the FULL ResolvedBrief (conflicts included).
 */
export function assembleContext(inputs: AssembleInputs): AssembledContext {
  const {
    purpose,
    instance,
    creator,
    campaign,
    messages,
    events,
    obligationRows,
    resolvedBrief,
    creatorMemory,
    conversationSummary,
    latestMessageId,
    mergedConfig,
  } = inputs;

  // §6.2 — the merge already ran ONCE in the executor and was
  // threaded in via inputs.mergedConfig. assembleContext no longer re-calls
  // mergeCampaignFallback: one merge site, no precedence drift.

  // Decision history (event-sourced) — WITHOUT campaignContext (knowledge is a
  // separate compartment). buildNegotiationRequest is the final shaper (§5.7); the
  // builder must not pre-populate empty objects (invariant that keeps requests
  // byte-identical), so campaignContext is attached ONLY when non-empty below.
  const priorEvents = events.filter((e) => e.type === "NEGOTIATION_TURN");
  const priorContext = buildPriorContextFromEvents(events);

  // §5.4 — brand-reply set + latest inbound derived internally (one source of truth).
  const brandReplyMsgIds = deriveBrandReplyMsgIds(events);
  const derivedLatest = selectLatestInbound(messages, brandReplyMsgIds);

  // §5.4 — a supplied latestMessageId is a VALIDATED consistency check, not an
  // override: it must be the same INBOUND, non-brand-reply row the builder derived.
  // Never let a caller point "latest" at a brand-reply row (would feed the brand's
  // "approve" as creator words) or skew the present-offer idempotency key.
  if (latestMessageId !== undefined) {
    const row = messages.find((m) => m.id === latestMessageId);
    if (!row) {
      throw new LatestMessageMismatchError(
        `latestMessageId ${latestMessageId} is not a message on this instance`,
      );
    }
    if (row.direction !== "INBOUND") {
      throw new LatestMessageMismatchError(
        `latestMessageId ${latestMessageId} is not an INBOUND message`,
      );
    }
    if (row.externalMessageId && brandReplyMsgIds.has(row.externalMessageId)) {
      throw new LatestMessageMismatchError(
        `latestMessageId ${latestMessageId} is a brand-reply row, not a creator message`,
      );
    }
    if (derivedLatest && row.id !== derivedLatest.id) {
      throw new LatestMessageMismatchError(
        `latestMessageId ${latestMessageId} is not the latest creator inbound (${derivedLatest.id})`,
      );
    }
  }

  const latestInbound = derivedLatest;
  // §5.4 — creatorReply stays co-located with latest-row selection so they can
  // never diverge.
  const creatorReply = latestInbound?.body ? extractReplyText(latestInbound.body) : "";
  const classifiedIntent =
    typeof latestInbound?.replyIntent === "string" ? latestInbound.replyIntent : undefined;

  // PLU-85 both-sides transcript from Message rows (events only enrich). Keep the
  // dated form too — PLU-112's draft windowing needs each entry's sentAt cursor,
  // which the plain transcript discards. `recentMessages` stays byte-identical.
  const datedRecentMessages = buildDatedDraftHistory(messages, brandReplyMsgIds, priorEvents);
  const recentMessages = datedRecentMessages.map((d) => d.entry);

  // PLU-111 obligations.
  const ledgerSplit = buildOpenObligations(obligationRows);
  const openCommitments = ledgerSplit.openCommitments;
  const structuredObligations = buildStructuredObligations(obligationRows);

  // §5.5 — the FULL ResolvedBrief. flatText + gating for whether it reaches the
  // negotiate knowledge blob (BRIEF_INTO_NEGOTIATE OR KNOWLEDGE_RETRIEVAL_ENABLED).
  const briefKnowledge = resolvedBrief.flatText;
  const negotiateBrief =
    (briefIntoNegotiateEnabled() || knowledgeRetrievalEnabled()) && briefKnowledge
      ? briefKnowledge
      : undefined;
  const briefSections = projectBriefSections(resolvedBrief.sections);
  const flatKnowledge = projectFlatKnowledge(mergedConfig);

  // The band-free knowledge campaignContext (§5.3) — assembled ONCE so decision +
  // draft see the same additive keys. This is DATA, NEVER a money input.
  const knowledgeContext: Record<string, unknown> = {
    ...flatKnowledge,
    ...(negotiateBrief ? { briefKnowledge: negotiateBrief } : {}),
    ...(briefSections ? { briefSections } : {}),
    ...(structuredObligations.length ? { structuredObligations } : {}),
  };

  // PLU-82 four-state availability, over the campaign's DECLARED knowledge fields.
  const expectedSections = FLAT_KNOWLEDGE_KEYS.filter(
    (k) => typeof mergedConfig[k] === "string" && (mergedConfig[k] as string).trim(),
  );
  const briefAvailability = deriveBriefAvailability(
    resolvedBrief,
    expectedSections,
    briefRefFromGraph(inputs.nodeGraph),
  );

  // §5.3 — the decision-only compartment. Band PRESENCE only; the floor/ceiling
  // VALUES stay in mergedConfig (buildNegotiationRequest resolves them at
  // request-build time, §5.7). The money-safety property is that DraftContext has
  // no field of this type at all.
  const bandPresent =
    mergedConfig["termFloor"] !== undefined ||
    mergedConfig["termCeiling"] !== undefined ||
    typeof mergedConfig["minBudget"] === "number" ||
    typeof mergedConfig["maxBudget"] === "number";

  return {
    purpose,
    instance,
    creator,
    campaign,
    mergedConfig,
    decisionHistory: priorContext,
    priorEvents,
    recentMessages,
    datedRecentMessages,
    latestInbound,
    creatorReply,
    brandReplyMsgIds,
    classifiedIntent,
    openObligationRows: obligationRows,
    openCommitments,
    structuredObligations,
    brief: resolvedBrief,
    flatKnowledge,
    briefSections,
    knowledgeContext,
    briefAvailability,
    creatorMemory,
    conversationSummary,
    campaignConstraints: { bandPresent },
  };
}
