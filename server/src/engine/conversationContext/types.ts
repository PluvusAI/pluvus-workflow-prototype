// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: PUBLIC TYPES
// ---------------------------------------------------------------------------
// §6.3 (Calvin review #5): the 788-line module was split into a folder so PLU-112
// and PLU-113 (which both edit the builder) have small, purpose-scoped files to
// touch. This file owns the public type surface + the pure-core input/dep types +
// the typed latest-message consistency error. No runtime logic lives here.

import type {
  Campaign,
  CampaignTermsSnapshot,
  ConversationObligation,
  Creator,
  Event,
  ExecutionInstance,
  Message,
  NegotiationPolicySnapshot,
} from "../../db/schema.js";
import type { Db, DbTx } from "../../db/drizzle.js";
import type { NodeSnapshot, PriorNegotiationContext } from "../types.js";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { StructuredObligation, DatedEntry } from "../executors/negotiationHistory.js";
import type {
  resolveBriefKnowledge,
  ResolvedBrief,
  BriefKnowledgeResult,
} from "../executors/briefKnowledge.js";

// ---------------------------------------------------------------------------
// Purpose
// ---------------------------------------------------------------------------

export type ContextPurpose =
  | "NEGOTIATION_DECISION"
  | "EMAIL_DRAFT"
  | "PAYMENT_REPLY"
  | "CONTENT_SUBMISSION"
  | "OPERATOR_REVIEW";

// PLU-137 §2a (Defect 4): the SET of purposes authorized to load the PRIVATE
// negotiation-policy snapshot. A purpose predicate — reads `purpose` ONLY, never a
// fee field, so no fee value can ever gate whether policy loads (E12 by construction).
// Only NEGOTIATION_DECISION is a live purpose today (the sole call site is
// negotiation.ts); OPERATOR_REVIEW is included for forward-safety (an authorized
// internal view). EMAIL_DRAFT / creator-facing purposes are excluded — draft context
// must never load private policy at all.
const AUTHORIZED_DECISION_PURPOSES = new Set<ContextPurpose>([
  "NEGOTIATION_DECISION",
  "OPERATOR_REVIEW",
]);

export function isAuthorizedDecisionPurpose(purpose: ContextPurpose): boolean {
  return AUTHORIZED_DECISION_PURPOSES.has(purpose);
}

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
 * PLU-112 — the rolling narrative summary of the ELIDED transcript prefix.
 * `summarizedThroughSentAt` + `summarizedThroughMessageId` are the COMPOUND coverage
 * cursor: draft turns after `(sentAt, messageId)` stay raw, earlier-or-equal ones are
 * covered here and may be windowed out. The messageId tie-breaks turns that share the
 * exact same sentAt so a same-timestamp turn can't be dropped-yet-never-summarized.
 * The wire-facing request carries only `{ text, version }` — the cursor never reaches
 * the model. Narrative-only; carries no rates/questions/commitments.
 */
export interface ConversationSummary {
  text: string;
  version?: string;
  tokensSaved?: number;
  summarizedThroughSentAt?: Date | undefined;
  summarizedThroughMessageId?: string | undefined;
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

/** PLU-137 §3a — the private negotiation-policy authority, projected from the pinned
 *  NegotiationPolicySnapshot. Lives ONLY on the decision-facing surface
 *  (DecisionContext); DraftContext has NO field of this type at all (structural
 *  exclusion — the money-safety property, mirror of `campaignConstraints`). Attached
 *  to AssembledContext / DecisionContext ONLY when a policy snapshot was loaded
 *  (emptiness contract — omitted on legacy/no-snapshot turns so the decision payload
 *  stays byte-identical). Every field independently nullable: a GIFT/affiliate deal
 *  legitimately has null floor/ceiling/preferred but still provides non-fee policy
 *  (E12 corollary — no fee field gates whether it loads). */
export interface PolicyAuthority {
  floorCents: number | null;
  ceilingCents: number | null;
  preferredFeeCents: number | null;
  // PLU-136 1b.b — the bare commissionRate scalar was split into private
  // floor/ceiling/preferred (mirroring the fee fields). publicCommissionRate
  // is the PUBLIC number and lives on CampaignTermsSnapshot, never here.
  commissionFloorRate: number | null;
  commissionCeilingRate: number | null;
  preferredCommissionRate: number | null;
  maxRounds: number | null;
  openingOfferPosition: number | null;
  overCeilingTolerance: number | null;
  negotiationGuidance: string | null;
  // PLU-136 1b.b — private gift-negotiation authority (only meaningful when the
  // campaign includes gifting / is GIFT_ONLY). Nullable like every other field.
  giftSubstitutionAllowed: boolean | null;
  giftValueFlexibilityCents: number | null;
  negotiableTerms: unknown;
  nonNegotiableTerms: unknown;
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
  // Same transcript with each entry's sentAt cursor (PLU-112 draft windowing).
  datedRecentMessages: DatedEntry[];

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

  // PLU-137 §2a — the pinned launch snapshots (undefined on legacy/no-snapshot
  // turns). `termsSnapshot` = frozen PUBLIC terms; `policySnapshot` = frozen PRIVATE
  // authority, loaded ONLY for an authorized decision purpose (build.ts gate).
  termsSnapshot?: CampaignTermsSnapshot | undefined;
  policySnapshot?: NegotiationPolicySnapshot | undefined;
  // PLU-137 §5 — true when a material term fell back to nodeGraph/mergedConfig
  // because no valid snapshot was pinned (legacy compatibility, logged via §4a).
  legacyFallbackUsed: boolean;
  // PLU-137 §2b/§3d (Defect 1) — set (NOT thrown) when a pinned id is missing/
  // mismatched/cross-campaign. The executor RETURNS a MANUAL_REVIEW NodeResult; the
  // builder never throws across the executor boundary (a throw dead-letters the job).
  integrityFailure?: { reason: string } | undefined;
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
  /** PLU-137 — policy-snapshot PRESENCE only (mirror of bandPresent), never values. */
  policyPresent: boolean;
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
  // PLU-137 §4a — snapshot ids + booleans + reason string ONLY, never policy VALUES.
  termsSnapshotId?: string; // pinned CampaignTermsSnapshot id (undefined = legacy)
  policySnapshotId?: string; // pinned NegotiationPolicySnapshot id — authorized-decision purposes ONLY
  legacyFallbackUsed: boolean; // a material term came from nodeGraph (no snapshot)
  integrityFailureReason?: string; // §3d — set when a pinned snapshot was missing/mismatched
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
  /** PLU-137 §3a — the private policy authority from the pinned snapshot. Present
   *  ONLY when a policy snapshot was loaded (emptiness contract); DraftContext has
   *  NO field of this type at all (structural exclusion, §3b). */
  policyAuthority?: PolicyAuthority | undefined;
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
  /** PLU-137 §3b — policy-snapshot PRESENCE only (mirror of the band's presence
   *  flag). Raw policy VALUES live only on DecisionContext.policyAuthority and are
   *  UNREACHABLE from this projection — the type has no field for them. */
  policyPresent: boolean;
  debug: ContextDebug;
  // NO campaignConstraints, NO policyAuthority, NO termFloor/termCeiling.
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
  /** PLU-137 §2b loader. Loads the two pinned launch snapshots off the instance.
   *  Gates the PRIVATE policy load on isAuthorizedDecisionPurpose(purpose) — reads
   *  `purpose` only, never a fee field (E12). Returns `integrityFailure` (NOT a
   *  throw, Defect 1) when a pinned id is set but its row is missing or belongs to a
   *  different campaign. Default stub returns `{}` (builder byte-identical when unused). */
  loadSnapshots?: (
    instance: ExecutionInstance,
    purpose: ContextPurpose,
    client: Db | DbTx,
  ) => Promise<SnapshotLoadResult>;
}

/** PLU-137 §2b — the loadSnapshots result. All fields optional/absent for a legacy
 *  no-snapshot turn. `policy` present ONLY for an authorized decision purpose. */
export interface SnapshotLoadResult {
  terms?: CampaignTermsSnapshot | undefined;
  policy?: NegotiationPolicySnapshot | undefined;
  integrityFailure?: { reason: string } | undefined;
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
  // PLU-137 §2b — the loaded pinned snapshots (absent on a legacy no-snapshot turn)
  // + the integrity outcome, threaded from the shell into the pure core.
  termsSnapshot?: CampaignTermsSnapshot | undefined;
  policySnapshot?: NegotiationPolicySnapshot | undefined;
  integrityFailure?: { reason: string } | undefined;
  latestMessageId?: string | undefined;
  /** §6.2 — mergeCampaignFallback(node.config, campaign), computed ONCE by the
   *  executor before its preconditions and threaded through the I/O shell. Fed to
   *  the brief resolver's
   *  campaignFields AND consumed here, so the merge runs exactly once per turn (no
   *  precedence drift, no second future change point). Pure callers/tests build it
   *  directly (they can call mergeCampaignFallback in the fixture, or pass a literal). */
  mergedConfig: Record<string, unknown>;
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
