import type {
  ExecutionInstance,
  Creator,
  Campaign,
  InstanceState,
  EventType,
  ReplyIntent,
} from "../db/schema.js";
// F-H1: the full both-sides transcript entry, reused from the draft seam so the
// negotiator receives the same conversation shape the copywriter already gets.
import type {
  DraftHistoryEntry,
  CreatorMemoryPayload,
  ExtractedFact,
} from "../adapters/negotiation/types.js";
// PLU-111: the pure obligation write-plan the executor returns and the runtime
// applies in-tx.
import type { QuestionObligationPlanItem } from "./executors/negotiationHistory.js";
// PLU-113: the pure memory write-plan the executor returns and the runtime applies
// in-tx (mirrors obligationWrites).
import type { MemoryWritePlanItem } from "./executors/creatorMemory.js";

// NodeSnapshot — matches what is stored in WorkflowVersion.nodeGraph
export interface NodeSnapshot {
  id: string;
  type: string;
  order: number;
  config: Record<string, unknown>;
}

// ExecutionContext — everything a node executor needs
export interface ExecutionContext {
  instance: ExecutionInstance;
  node: NodeSnapshot;
  nodeGraph: NodeSnapshot[];
  creator: Creator;
  // H5: the parent campaign, when the workflow is linked to one. Used as a
  // FALLBACK source of brand context (brandDescription/deliverables/timeline/
  // rewardDescription/senderName) for the LLM when a node's config wasn't stamped
  // with them (e.g. imported/legacy workflows). Null for seeded/legacy workflows
  // that predate campaigns (campaignId is null) — those rely on node config.
  campaign?: Campaign | null;
}

// NodeResult — what a node executor returns
export interface NodeResult {
  nextState: InstanceState;
  nextNodeId: string | null;
  followUpCount?: number;
  negotiationRound?: number;
  dueAt?: Date | null;
  completedAt?: Date | null;
  eventType: EventType;
  eventPayload?: Record<string, unknown>;
  /**
   * Randomized Send Delay (§4.3a option A): a reserved-but-unsent OUTBOUND row
   * whose delayed flush must be enqueued by the runtime AFTER the OCC transaction
   * commits — never before. An executor that reserved an AI reply sets this; the
   * runtime enqueues `enqueueDelayedSend({ messageId }, delayMs)` only when
   * `updated` is non-null. On a StaleInstanceError (rolled-back turn) the runtime
   * enqueues nothing, so a phantom send is impossible; the reserved row is an
   * orphan for the poller sweep/GC to reclaim.
   *
   * Absent when nothing was reserved (escalate/reject/guard-block paths) or when
   * reserveOutbound found the send already delivered (P2002 case a → no re-enqueue).
   */
  deferredSend?: {
    /** The reserved Message DB row id to flush. */
    messageId: string;
    /** The drawn delay in ms (0 when the feature is disabled). */
    delayMs: number;
  };
  /**
   * PLU-111: the conversation-obligation write-plan for this turn, applied by the
   * runtime INSIDE stepInstance's db.transaction — alongside the NEGOTIATION_TURN
   * event + OCC state write — so a rolled-back turn (StaleInstanceError) leaves no
   * half-written obligation (invariant #5, §4.6). The executor keeps the plan pure
   * (build-only); the runtime owns the tx-scoped DB writes, mirroring how
   * `deferredSend` is returned and actioned. Absent on turns with no obligation
   * activity (escalate/reject with no questions, etc.).
   *
   * The create/update runs here; the ANSWERED/COMPLETED transition fires LATER at
   * flush (when sentAt is stamped) — see resolveObligationsByResolutionMessage.
   */
  obligationWrites?: {
    /** Create/update creator-question obligations (§4.4). */
    questionPlan: QuestionObligationPlanItem[];
    /** The inbound Message row that raised this turn's questions, if any. */
    sourceMessageId?: string | undefined;
    /** The reserved outbound Message id to LINK as the intended resolver of the
     *  open questions this turn's draft was meant to answer (§4.5 step 1). The
     *  status is left unchanged — the terminal transition is at flush. */
    reservedResolutionMessageId?: string | undefined;
    /** §4.2: when this turn ESCALATED (an always-escalate topic), move ALL of the
     *  instance's non-terminal obligations — including the ones this plan just
     *  created — to ESCALATED (non-terminal). Nothing is lost: they stay in the AI
     *  context AND surface in the Manual Queue. The runtime resolves the ids AFTER
     *  applying questionPlan (so newly-minted rows are included). */
    escalateAfterWrite?: boolean | undefined;
  };
  /**
   * PLU-113: the campaign-creator-memory write-plan for this turn, applied by the
   * runtime INSIDE stepInstance's db.transaction — alongside the NEGOTIATION_TURN
   * event + obligation writes — so a rolled-back turn (StaleInstanceError) leaves no
   * half-written fact (§4.7). The executor keeps the plan pure (build-only); the
   * runtime owns the tx-scoped writes (mirrors obligationWrites). Wrapped in a
   * try/catch so a memory-write failure degrades to "no memory this turn" and never
   * costs a reply (invariant #9). Absent when CREATOR_MEMORY_ENABLED is off or the
   * turn extracted no facts.
   */
  memoryWrites?: {
    /** The per-fact write plan (§4.5). */
    plan: MemoryWritePlanItem[];
    /** The inbound Message row that stated this turn's facts (provenance, §4.5). */
    sourceMessageId?: string | undefined;
  };
}

// EmailAttachment — an out-of-body file to send alongside an email (Phase 16).
// Bytes are carried as a Buffer; the provider is responsible for encoding them
// for the wire (Nylas expects base64). Only the Content Brief node sets this
// today; every other draft omits it, so the send path is unchanged for them.
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

// EmailDraft — returned by MockEmailProvider.draft()
export interface EmailDraft {
  subject: string;
  body: string;
  /** Optional file attachments. Absent for all nodes except Content Brief. */
  attachments?: EmailAttachment[];
}

// ClassifyResult — returned by MockAgentProvider.classify()
export interface ClassifyResult {
  intent: ReplyIntent;
  confidence: number;
  /**
   * Phase E (#5): an always-escalate topic reason code from the agent's topic
   * gate. When present, reply detection routes to MANUAL_REVIEW regardless of
   * intent/confidence, recording this as the escalation reason.
   */
  escalationReason?: string;
}

// NegotiateResult — returned by MockAgentProvider.negotiate()
//   present_offer: the creator asked about terms (no number proposed); present
//   the fee+commission but do NOT consume a negotiation round (informational).
export type NegotiateOutcome = "accept" | "counter" | "reject" | "escalate" | "present_offer";

export interface NegotiateResult {
  outcome: NegotiateOutcome;
  message: string;
  /**
   * The rate the agent proposed/agreed on this turn, if any. Surfaced so the
   * executor can persist it in the NEGOTIATION_TURN event and thread it back as
   * `currentOffer` on the next turn (FIX-2). Undefined for reject/escalate or
   * when the provider returned no numeric term.
   */
  proposedRate?: number;
  /**
   * Comprehension threaded from /negotiate across the seam (spec §6.1): the
   * executor destructures these and spreads them into the /draft `extra` so the
   * SENT email answers every question and acknowledges pushed fixed terms.
   * Undefined when the provider emitted none (e.g. rules mode).
   *   creatorQuestions — every question/request the creator raised this turn.
   *   pushedFixedTerms — fixed terms (commission|perk|deliverables|timeline) the
   *     creator tried to change.
   */
  creatorQuestions?: string[];
  pushedFixedTerms?: string[];
  /**
   * MED-N3: the creator's OWN stated ask this turn, as comprehended by the
   * /negotiate model and validated in the agent (digits must appear verbatim in
   * the reply; ranges rejected). This is the number the MONEY path may record
   * (context.creatorRate on a brand decision → the deal rate on APPROVE) — the
   * executor must not substitute a regex read for it. Undefined when the
   * creator named no single figure.
   */
  creatorRequestedRate?: number;
  /**
   * Phase E (#5): when outcome is "escalate" and it was driven by an
   * always-escalate topic, the topic reason code (e.g. legal_or_contract). The
   * executor uses it as the MANUAL_REVIEW reason instead of the generic
   * "escalated". Undefined for a normal over-ceiling / unreadable-rate escalate.
   */
  escalationReason?: string;
  /**
   * Q3 (founder, autonomous launch): true when this is the LAST negotiation round
   * (round + 1 >= maxRounds). The executor threads it into the /draft `extra` for
   * the offer email so the SENT copy states finality to the creator ("this is our
   * final rate — we can't negotiate further"), making the auto-close on a
   * decline/no-reply expected rather than abrupt. Undefined/false on every
   * non-final turn.
   */
  isFinalRound?: boolean;
  /**
   * Option A (negotiate→draft answer sync): the /negotiate model's OWN written
   * reply (its responseDraft) — the vetted answers to every creator question this
   * turn. DISTINCT from `message`: `message` always has a fallback string, whereas
   * this is set ONLY when the agent returned a genuine advisory draft — i.e. the
   * LLM strategy ran AND the money guards did NOT alter the decision (a guard-
   * altered decision nulls responseDraft upstream so the copy can never restate a
   * number that contradicts the recorded deal; rules mode emits only a placeholder).
   * The executor threads it into the /draft `extra` as `negotiatorAnswers` so the
   * copy model rephrases these approved answers instead of re-deriving (and
   * hallucinating) them. Undefined when there is no genuine draft to pass.
   */
  negotiatorAnswers?: string;
  /**
   * PLU-113: the durable creator facts the /negotiate model extracted from THIS
   * turn's inbound (§4.4) — availability, objections, logistics, manager,
   * preferences, and an optional MINIMUM_RATE. The executor turns these (plus the
   * validated creatorRequestedRate, which owns REQUESTED_RATE) into the in-tx
   * memory write plan. Undefined in rules mode + when CREATOR_MEMORY_ENABLED is off.
   */
  creatorFacts?: ExtractedFact[];
}

// PriorNegotiationContext — assembled by the executor (the state authority) and
// threaded into agent.negotiate() so the stateless agent can reason about the
// conversation so far (FIX-1 history threading, FIX-2 current-offer tracking).
//   - history:      prior turns in chronological order (OUR side only — the
//                   money-decision summary: {round, action, rate, our snippet})
//   - currentOffer: the rate actually last proposed by us, if known
//   - conversationHistory (F-H1): the FULL both-sides transcript (creator + us),
//                   chronological, so the negotiator can reason about what the
//                   creator SAID in earlier rounds — their prior anchors, firm
//                   positions, concession trajectory, and self-contradictions —
//                   not just our own moves + the latest inbound line. This is the
//                   same transcript the copywriter already receives (HARD-N2),
//                   now extended to the money brain. Empty on the first turn.
export interface PriorNegotiationContext {
  history: NegotiationHistoryEntryLite[];
  currentOffer?: number | undefined;
  conversationHistory?: DraftHistoryEntry[] | undefined;
  // PLU-111: outstanding Pluvus commitments (non-terminal PLUVUS_COMMITMENT
  // obligations) so the money-decision model knows it owes an action too. Rendered
  // by /negotiate as sanitized DATA (like the transcript), NEVER as a money input.
  // Empty/absent → no change to behavior.
  openCommitments?: string[] | undefined;
  // classify→negotiate hint: the intent the first-reply classifier assigned to the
  // reply being negotiated (from the persisted Message.replyIntent). Threaded as a
  // SOFT advisory signal so the money-decision model has the upstream read of the
  // creator's stance — never a money input, never an override of the guards. Absent
  // for a mid-negotiation reply (round >= 1 skips classify) or an un-classified row,
  // so the /negotiate prompt renders exactly as before.
  intent?: string | undefined;
  // PLU-113: the durable creator facts persisted THIS campaign (§4.8), rendered by
  // /negotiate as sanitized DATA so the money-decision model knows the creator's
  // stated positions (rate/floor as CONTEXT, availability, objections, manager,
  // preferences) without re-scanning the transcript. NEVER a money input (invariant
  // #6). Absent/empty (flag off, empty memory) → no block, byte-identical.
  creatorMemory?: CreatorMemoryPayload | undefined;
}

// A trimmed history entry the executor can build purely from persisted events.
export interface NegotiationHistoryEntryLite {
  round: number;
  action: "ACCEPT" | "COUNTER" | "REJECT" | "ESCALATE" | "PRESENT_OFFER";
  rate?: number | undefined;
  message?: string | undefined;
}
