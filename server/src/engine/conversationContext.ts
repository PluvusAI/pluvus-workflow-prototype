// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder
// ---------------------------------------------------------------------------
// `executeNegotiation` used to assemble ALL AI context inline (~220 lines):
// merge campaign fallback, load creator inbounds, load events, build prior
// context, build the both-sides transcript, resolve brief knowledge, load
// obligations, and hand-assemble a band-FULL `campaignContext`/`campaignConstraints`
// for /negotiate and a band-STRIPPED `draftConfig` for /draft. Every future AI
// node (payment reply, content submission, operator review) would duplicate it.
//
// PLU-81 extracts that into ONE reusable, purpose-aware, unit-testable read-model
// builder. The seven load-bearing design decisions (settled by three adversarial
// reviews — see .claude/spec/plu-81-.../REVIEW.md):
//
//  1. TWO compiler-separated projection types. DecisionContext carries the secret
//     band (via campaignConstraints); DraftContext STRUCTURALLY lacks any band
//     field — the compiler, not a runtime getter, prevents the draft path from
//     ever reading a bound (§4.2, §4.3).
//  2. Build-once async + PURE synchronous projections. buildConversationContext
//     does the DB reads + the single /parse-brief HTTP call ONCE per turn and
//     returns a rich AssembledContext; toDecisionContext/toDraftContext are pure
//     and do ZERO new I/O (§4.2, §4.5).
//  3. Pure assembleContext(inputs) core + thin I/O shell + injectable resolveBrief.
//     The pure core (rows in → AssembledContext out) is the unit-test target (§8).
//  4. Injectable async LOADERS for creatorMemory (PLU-113) and conversationSummary
//     (PLU-112), defaulting to stubs that return undefined. The forward-compat seam
//     is the loader, NOT a static field — so PLU-113/112 light up by swapping the
//     loader with zero negotiation.ts merge conflict. The builder body references
//     NO unbuilt flag module (§9).
//  5. buildNegotiationRequest stays the final conditional-spread shaper. The builder
//     FEEDS it a PriorNegotiationContext; it does not replace it. Byte-identical
//     request shapes are protected by a golden matrix (§5.7, §10).
//  6. Observability = fold a sanitized contextRecord onto the NEGOTIATION_TURN
//     payload (the PLU-82 mapKnowledge pattern). Band VALUES never enter debug/logs;
//     presence only (§7).
//  7. Pure-config preconditions (escalateNoCeiling, maxRounds) and post-decision
//     derivations (openQuestions/questionPlan/changedFields/warmth) stay in the
//     executor, OUTSIDE the builder (§5.2, §5.6).
//
// This is a pure REFACTOR: nothing changes behaviorally. The optional slots stay
// undefined until their owning issues (PLU-112/113) land.

import { db, type Db, type DbTx } from "../db/drizzle.js";
import {
  listMessagesByInstance,
  listEventsByInstance,
  listOpenObligationsByInstance,
} from "../db/index.js";
import type {
  Campaign,
  ConversationObligation,
  Creator,
  Event,
  ExecutionInstance,
  Message,
} from "../db/schema.js";
import type { NodeSnapshot, PriorNegotiationContext } from "./types.js";
import type { DraftHistoryEntry } from "../adapters/negotiation/types.js";
import {
  buildPriorContextFromEvents,
  buildDraftHistory,
  buildOpenObligations,
  buildStructuredObligations,
  type StructuredObligation,
} from "./executors/negotiationHistory.js";
import {
  resolveBriefKnowledge,
  deriveBriefAvailability,
  type ResolvedBrief,
  type BriefKnowledgeResult,
} from "./executors/briefKnowledge.js";
import { extractReplyText } from "./executors/replyText.js";
import { mergeCampaignFallback } from "./campaignContext.js";
// §4.3: the band-key list is the ONE source of truth. toDraftContext strips using
// this exact list rather than re-listing the keys (BAND_CONTEXT_KEYS strips the raw
// minBudget/maxBudget too — the real leak surface).
import { stripBandFromContext } from "./providerFactory.js";

// ---------------------------------------------------------------------------
// Purpose
// ---------------------------------------------------------------------------

export type ContextPurpose =
  | "NEGOTIATION_DECISION"
  | "EMAIL_DRAFT"
  | "PAYMENT_REPLY"
  | "CONTENT_SUBMISSION"
  | "OPERATOR_REVIEW";

// ---------------------------------------------------------------------------
// Forward-compat optional-slot types (§9)
// ---------------------------------------------------------------------------

/**
 * PLU-113 §9.2 — forward-declared to PLU-113's EXACT branch shape (canonical owner:
 * PLU-113; `creatorMemory.ts:235`). PLU-113 makes it canonical on merge (a type
 * move, not a re-implementation), and rebases by supplying `loadCreatorMemory` to
 * the builder deps and DELETING its inline read spreads (§9.3 rebase contract).
 * PLU-81 only declares the READ slot's shape; PLU-113's WRITE path is out of scope.
 */
export interface CreatorMemoryConflict {
  field: string;
  priorValue: string;
  newValue: string;
  source?: string;
}

export interface CreatorMemoryPayload {
  requestedRate?: number;
  minimumRate?: number;
  availability?: string;
  logisticsConstraints: string[];
  objections: string[];
  deliverablePreferences: string[];
  compensationPreferences: string[];
  managerInvolved?: boolean;
  managerContact?: string;
  conflicts: CreatorMemoryConflict[];
}

/**
 * PLU-112 §9.4 — shape UNVERIFIED (canonical owner: PLU-112; adjust on that issue).
 * PLU-112 is not built anywhere; this is a minimal placeholder so the slot + the
 * `summaryVersion` observability field have a type. No budget logic ships (§3).
 */
export interface ConversationSummary {
  text: string;
  version?: string;
  tokensSaved?: number;
}

// ---------------------------------------------------------------------------
// The rich internal read-model (band-FULL). Never sent to an agent directly.
// ---------------------------------------------------------------------------
// A DERIVED read model (PLU-69 constraint): it holds references/derivations, it
// does NOT persist a second copy of Message/Event/Campaign.

/** The decision-only compartment: the internal band + the non-negotiable money
 *  terms buildNegotiationRequest resolves. PRESENT on AssembledContext; STRUCTURALLY
 *  ABSENT from DraftContext (§4.3). Kept physically distinct from the knowledge
 *  compartment (`campaignContext`) which is documented "NEVER a money input" (§5.3).
 *
 *  v1 keeps this deliberately minimal: the band VALUES live in `mergedConfig`
 *  (from which buildNegotiationRequest resolves them at request-build time, §5.7),
 *  so this compartment only records band PRESENCE — the money-safety property is
 *  that DraftContext has no field of this type at all, not that it hides values. */
export interface CampaignConstraints {
  /** Whether a usable price band was resolved from the merged config. Presence
   *  only — the floor/ceiling numbers themselves never ride this object (they stay
   *  in mergedConfig and are resolved by buildNegotiationRequest, §5.3/§5.7). */
  bandPresent: boolean;
}

export interface AssembledContext {
  // The purpose this context was built for. Drives the debug/token estimate; both
  // projections are derivable regardless (§4.5).
  purpose: ContextPurpose;

  // Identity (already-loaded rows — the executor has these in ExecutionContext).
  instance: ExecutionInstance;
  creator: Creator;
  campaign?: Campaign | null | undefined;

  // The merged node config (mergeCampaignFallback applied ONCE — §5.1). Band-FULL.
  mergedConfig: Record<string, unknown>;

  // Decision history (event-sourced) — PriorNegotiationContext WITHOUT campaignContext
  // (knowledge is assembled separately below so the two compartments stay distinct).
  decisionHistory: PriorNegotiationContext;

  // The NEGOTIATION_TURN events (chronological) the decision history was built from.
  // Supplied so the executor's POST-decision reads (computeOpenQuestions empty-ledger
  // fallback — §5.6) run against the same events the builder already loaded, with NO
  // extra query. The events remain the separate decision history; the builder does
  // not compute the post-decision reads itself (they depend on this turn's return).
  priorEvents: Event[];

  // Communication transcript (PLU-85 — Message-sourced, both sides).
  recentMessages: DraftHistoryEntry[];

  // The creator's latest inbound + its derived reply text (§5.4). One source of truth.
  latestInbound?: Message | undefined;
  creatorReply: string;
  brandReplyMsgIds: Set<string>;
  classifiedIntent?: string | undefined;

  // Obligations (PLU-111).
  openObligationRows: ConversationObligation[];
  openCommitments: string[];
  structuredObligations: StructuredObligation[];

  // Knowledge (PLU-107/114) — the FULL ResolvedBrief (conflicts included — §5.5),
  // plus the projected inputs the agent knowledge-router consumes.
  brief: ResolvedBrief;
  flatKnowledge: Record<string, string>; // usageRights/exclusivity/paymentTerms/attributionWindow
  briefSections?: Record<string, string> | undefined; // projectBriefSections(brief.sections)
  /** The band-free knowledge campaignContext threaded into BOTH endpoints (§5.3).
   *  Assembled ONCE here so decision + draft see the same keys. */
  knowledgeContext: Record<string, unknown>;
  briefAvailability: BriefKnowledgeResult; // four-state (PLU-82 §4.4)

  // Forward-compat optional slots (undefined until PLU-112/113 land — §9).
  creatorMemory?: CreatorMemoryPayload | undefined; // PLU-113
  conversationSummary?: ConversationSummary | undefined; // PLU-112

  // Decision-only compartment: band presence + non-negotiable money terms.
  // STRUCTURALLY ABSENT from DraftContext (§4.3).
  campaignConstraints: CampaignConstraints;
}

// ---------------------------------------------------------------------------
// Debug / sanitized observability record (§7) — labels/keys/counts, NEVER values
// ---------------------------------------------------------------------------

export interface ContextDebug {
  purpose: ContextPurpose;
  /** Deduped provenance labels (§7.4). "available" sources — what was OFFERED to
   *  the agent, not what its router rendered. Never row-ids-with-values, never the
   *  band number: `"band:present"` is a flag label, never `"band:200-500"`. */
  sourcesUsed: string[];
  /** §7.3 — a LABELED coarse chars/4 proxy over the projected view (over-counts;
   *  excludes agent template boilerplate + PLU-114 retrieval pruning). Per-purpose:
   *  the DECISION view (band-full) and DRAFT view (band-stripped) yield different
   *  counts. For real token truth, operators look at LlmCall.inputTokens. */
  estimatedTokens: number;
  /** Band PRESENCE only — never the floor/ceiling values (§7.5). */
  bandPresent: boolean;
}

/** The sanitized record folded onto the NEGOTIATION_TURN payload (§7.2). Every
 *  field is labels/keys/counts, never values. Band values NEVER enter this. */
export interface ContextRecord {
  purpose: ContextPurpose;
  messageIdsIncluded: string[]; // Message row ids in the transcript
  eventCount: number; // NEGOTIATION_TURN events used for decision history
  campaignFieldsSelected: string[]; // knowledge KEYS only, e.g. ["usageRights"]
  briefSectionsUsed: string[]; // brief section KEYS only
  openObligationIds: string[]; // obligation row ids included
  summaryVersion?: string; // PLU-112 (undefined today)
  estimatedTokens: number; // §7.3 coarse proxy, labeled as such
  sourcesUsed: string[]; // §7.4 provenance labels
  bandPresent: boolean; // band PRESENCE only — never values (§7.5)
  briefAvailability: BriefKnowledgeResult; // already surfaced by PLU-82
}

// ---------------------------------------------------------------------------
// The two projections (purpose-gating by TYPE, not by getter) — §4.2
// ---------------------------------------------------------------------------

/** NEGOTIATION_DECISION view: band-FULL. */
export interface DecisionContext {
  /** The prior-negotiation context threaded into agent.negotiate. Its
   *  `.campaignContext` is the band-FREE knowledge compartment; the band is resolved
   *  by buildNegotiationRequest from mergedConfig at request-build time (§5.7). */
  decisionHistory: PriorNegotiationContext;
  /** Band presence + money terms live HERE (never on DraftContext, §4.3). */
  campaignConstraints: CampaignConstraints;
  creatorReply: string;
  round: number;
  debug: ContextDebug;
}

/** EMAIL_DRAFT view: band-STRIPPED. NOTE: NO `campaignConstraints` field exists —
 *  the compiler forbids reading a bound here (§4.3, money-safety core). */
export interface DraftContext {
  /** stripBandFromContext(mergedConfig) merged with the knowledge keys. Contains
   *  NONE of BAND_CONTEXT_KEYS (asserted by the golden + unit tests). */
  draftConfig: Record<string, unknown>;
  history: DraftHistoryEntry[];
  /** SHARED base only. The executor fills the final post-decision openQuestions
   *  read (§5.6) — the builder exposes the slot but does not compute it. */
  openCommitments: string[];
  creatorMemory?: CreatorMemoryPayload | undefined;
  debug: ContextDebug;
  // NO campaignConstraints, NO termFloor/termCeiling.
}

// ---------------------------------------------------------------------------
// Deps + pure-core inputs (§8, §9)
// ---------------------------------------------------------------------------

export interface ContextDeps {
  /** Injectable brief resolver (defaults to the real HTTP fn). A pure/shell test
   *  passes a stub so no HTTP fires (§8). */
  resolveBrief?: typeof resolveBriefKnowledge;
  /** PLU-113 loader. Default stub returns undefined; the CREATOR_MEMORY_ENABLED
   *  flag check lives INSIDE PLU-113's loader, never here (§9.1). */
  loadCreatorMemory?: (instanceId: string) => Promise<CreatorMemoryPayload | undefined>;
  /** PLU-112 loader. Default stub returns undefined (§9.1). */
  loadConversationSummary?: (
    instanceId: string,
    purpose: ContextPurpose,
  ) => Promise<ConversationSummary | undefined>;
}

/** The already-fetched rows + resolved brief + loaded optional slots. assembleContext
 *  is pure over these (no DB, no HTTP) — the unit-test target (§8). */
export interface AssembleInputs {
  purpose: ContextPurpose;
  instance: ExecutionInstance;
  creator: Creator;
  campaign?: Campaign | null | undefined;
  node: NodeSnapshot;
  nodeGraph: NodeSnapshot[];
  messages: Message[];
  events: Event[];
  obligationRows: ConversationObligation[];
  resolvedBrief: ResolvedBrief;
  creatorMemory?: CreatorMemoryPayload | undefined;
  conversationSummary?: ConversationSummary | undefined;
  latestMessageId?: string | undefined;
}

/** Typed error thrown when a caller-supplied `latestMessageId` fails the §5.4
 *  consistency check (points at a non-inbound or brand-reply row). It is a check,
 *  not an authoritative override — the builder always derives "latest" internally. */
export class LatestMessageMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LatestMessageMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (mirrors of the inline negotiation.ts logic, kept byte-identical)
// ---------------------------------------------------------------------------

// The four authoritative flat knowledge fields (§ negotiation.ts FLAT_KNOWLEDGE_KEYS).
const FLAT_KNOWLEDGE_KEYS = [
  "usageRights",
  "exclusivity",
  "paymentTerms",
  "attributionWindow",
] as const;

function projectFlatKnowledge(config: Record<string, unknown>): Record<string, string> {
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
function estimateTokens(view: unknown): number {
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
 * §5.1: mergeCampaignFallback runs FIRST, ONCE — mergedConfig is the canonical
 * source for band resolution, conflict detection, flat-knowledge, AND draftConfig.
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
    node,
    messages,
    events,
    obligationRows,
    resolvedBrief,
    creatorMemory,
    conversationSummary,
    latestMessageId,
  } = inputs;

  // §5.1 — merge exactly once, node wins.
  const mergedConfig = mergeCampaignFallback(node.config, campaign);

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

  // PLU-85 both-sides transcript from Message rows (events only enrich).
  const recentMessages = buildDraftHistory(messages, brandReplyMsgIds, priorEvents);

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
  const briefAvailability = deriveBriefAvailability(resolvedBrief, expectedSections);

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

// ---------------------------------------------------------------------------
// Pure projections (§4.2) — no I/O
// ---------------------------------------------------------------------------

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
  if (ctx.campaignConstraints.bandPresent) sources.push("band:present");
  sources.push(...extraSources);

  return {
    purpose: ctx.purpose,
    sourcesUsed: dedupe(sources),
    estimatedTokens: estimateTokens(view),
    bandPresent: ctx.campaignConstraints.bandPresent,
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
  };
  const debug = buildDebug(ctx, decisionHistory, ["intent:decision-only"]);
  return {
    decisionHistory,
    campaignConstraints: ctx.campaignConstraints,
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
  };
  const debug = buildDebug(ctx, draftConfig, ["dealDescription:draft-only"]);
  return {
    draftConfig,
    history: ctx.recentMessages,
    openCommitments: ctx.openCommitments,
    creatorMemory: ctx.creatorMemory,
    debug,
  };
}

// ---------------------------------------------------------------------------
// Observability record (§7.2) — folded onto the NEGOTIATION_TURN payload
// ---------------------------------------------------------------------------

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
    briefAvailability: ctx.briefAvailability,
  };
}

// ---------------------------------------------------------------------------
// Async I/O shell — does the reads ONCE (§4.2, §4.5)
// ---------------------------------------------------------------------------

/**
 * Build the band-FULL internal read-model for a turn. Does ALL the reads ONCE:
 * the DB reads (messages, events, obligations), the single /parse-brief HTTP call,
 * and the two injectable optional-slot loaders. Returns a rich AssembledContext;
 * the callers project it with the PURE toDecisionContext/toDraftContext — never
 * calling this builder twice per turn (§4.2 build-once).
 *
 * The executor already holds `instance`/`creator`/`campaign`/`node`/`nodeGraph`
 * (from ExecutionContext) — they're passed in to avoid re-reading.
 *
 * `client` is injectable (defaults to `db`) so the reads can enlist a test tx.
 */
export async function buildConversationContext(
  args: {
    instanceId: string;
    purpose: ContextPurpose;
    nodeGraph: NodeSnapshot[];
    node: NodeSnapshot;
    campaign?: Campaign | null | undefined;
    instance: ExecutionInstance;
    creator: Creator;
    latestMessageId?: string | undefined;
    client?: Db | DbTx | undefined;
  },
  deps: ContextDeps = {},
): Promise<AssembledContext> {
  const client = args.client ?? db;
  const resolveBrief = deps.resolveBrief ?? resolveBriefKnowledge;
  // §9.1 — the default loaders are undefined-returning stubs. The unbuilt PLU-112/
  // 113 flag checks live INSIDE their loader impls, never referenced here — so the
  // builder compiles with those modules absent from the tree.
  const loadCreatorMemory =
    deps.loadCreatorMemory ?? (async (): Promise<CreatorMemoryPayload | undefined> => undefined);
  const loadConversationSummary =
    deps.loadConversationSummary ??
    (async (): Promise<ConversationSummary | undefined> => undefined);

  // §5.1 — the merged config drives the brief conflict-detection fields; merge once
  // here for the resolver's campaignFields (assembleContext merges again from the
  // SAME inputs — deterministic, node-wins — so there's no precedence drift).
  const mergedForFields = mergeCampaignFallback(args.node.config, args.campaign);

  // The reads — ONCE. The obligation + message + event reads run in parallel; the
  // brief resolve is best-effort (never throws — §5.5); the optional loaders default
  // to undefined stubs.
  const [messages, events, obligationRows, resolvedBrief, creatorMemory, conversationSummary] =
    await Promise.all([
      listMessagesByInstance(args.instanceId, client),
      listEventsByInstance(args.instanceId, undefined, client),
      listOpenObligationsByInstance(args.instanceId, client),
      resolveBrief(args.nodeGraph, {
        usageRights:
          typeof mergedForFields["usageRights"] === "string"
            ? (mergedForFields["usageRights"] as string)
            : undefined,
        exclusivity:
          typeof mergedForFields["exclusivity"] === "string"
            ? (mergedForFields["exclusivity"] as string)
            : undefined,
        paymentTerms:
          typeof mergedForFields["paymentTerms"] === "string"
            ? (mergedForFields["paymentTerms"] as string)
            : undefined,
        attributionWindow:
          typeof mergedForFields["attributionWindow"] === "string"
            ? (mergedForFields["attributionWindow"] as string)
            : undefined,
      }),
      loadCreatorMemory(args.instanceId),
      loadConversationSummary(args.instanceId, args.purpose),
    ]);

  return assembleContext({
    purpose: args.purpose,
    instance: args.instance,
    creator: args.creator,
    campaign: args.campaign,
    node: args.node,
    nodeGraph: args.nodeGraph,
    messages,
    events,
    obligationRows,
    resolvedBrief,
    creatorMemory,
    conversationSummary,
    latestMessageId: args.latestMessageId,
  });
}
