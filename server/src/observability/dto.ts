// ---------------------------------------------------------------------------
// Observability DTOs (Phase 9, Part 8)
// ---------------------------------------------------------------------------
// These are the *only* shapes the observability API returns. Raw Prisma objects
// are never serialized to the client — every endpoint maps through a mapper in
// repository.ts. Keeping the contract here means the frontend has a single,
// stable type surface to import-mirror.

import type {
  InstanceState,
  EventType,
  LlmCallRole,
  MessageDirection,
  ReplyIntent,
  ObligationType,
  ConversationObligationStatus,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Canonical workflow state order (matches stateMachine.ts transition table)
// ---------------------------------------------------------------------------
// The canvas lays nodes out in this order. ENROLLED → ... → terminal states.
// Kept here (not in the frontend) so the backend is the single source of truth
// for "what states exist and how they're ordered".

export const WORKFLOW_STATE_ORDER: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_QUEUED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_PENDING",
  "REWARD_CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "CONTENT_LINKS_PENDING",
  "CONTENT_BRIEF_SENT",
  // PLU-70 operator-handoff branch — sits after ACCEPTED conceptually, but is
  // ordered here so the canvas keeps the local-payment path as its main column.
  "NEEDS_DEAL_FINALIZATION",
  "HANDOFF_COMPLETE",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

export const TERMINAL_STATES: InstanceState[] = [
  // ACCEPTED, REWARD_CONFIRMED and PAYMENT_RECEIVED are no longer terminal (they
  // auto-advance into Reward Setup, Payment Info and Content Brief);
  // CONTENT_BRIEF_SENT is the new success terminal.
  "CONTENT_BRIEF_SENT",
  // PLU-70: the success terminal of the operator-handoff branch.
  "HANDOFF_COMPLETE",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

// States the scheduler can act on — used to flag "stuck" instances whose dueAt
// has long passed (waiting buckets). REWARD_PENDING and PAYMENT_PENDING wait on a
// creator action (reply / form submission) so they surface as waiting buckets.
// CONTENT_LINKS_PENDING likewise waits on a creator action (the content-links
// reply), so it is a waiting bucket too.
export const WAITING_STATES: InstanceState[] = [
  "OUTREACH_QUEUED",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REWARD_PENDING",
  "PAYMENT_PENDING",
  "CONTENT_LINKS_PENDING",
  // PLU-70: waits on an OPERATOR rather than the creator, but it is a waiting
  // bucket all the same — surfacing it here keeps "parked, needs a human" visible
  // in the scheduler view instead of looking like a stalled active state.
  "NEEDS_DEAL_FINALIZATION",
];

// ---------------------------------------------------------------------------
// Workflow summary (GET /observability/workflow)
// ---------------------------------------------------------------------------

export interface WorkflowNodeSummaryDTO {
  state: InstanceState;
  /** Total instances currently in this state. */
  count: number;
  /** Whether this is a terminal state. */
  terminal: boolean;
  /** Instances in this state that are still "moving" (non-terminal). */
  active: number;
  /** Instances in a waiting state (AWAITING_REPLY / FOLLOWED_UP). */
  waiting: number;
  /** Instances flagged stuck: in a waiting state with dueAt long past. */
  stuck: number;
  /** Average time spent in this state, in seconds (null if not computable). */
  avgTimeInStateSeconds: number | null;
}

export interface WorkflowSummaryDTO {
  workflow: {
    id: string;
    name: string;
    version: number;
    versionId: string;
  } | null;
  totalInstances: number;
  nodes: WorkflowNodeSummaryDTO[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Instance list (GET /observability/instances)
// ---------------------------------------------------------------------------

export interface InstanceListItemDTO {
  instanceId: string;
  creatorId: string;
  creatorName: string;
  creatorEmail: string;
  creatorHandle: string | null;
  platform: string | null;
  state: InstanceState;
  currentNodeId: string | null;
  negotiationRound: number;
  followUpCount: number;
  dueAt: string | null;
  enrolledAt: string;
  updatedAt: string;
  /** Seconds since the instance last changed (proxy for time-in-state). */
  waitingForSeconds: number;
  /** True when in a waiting state and dueAt is well past. */
  stuck: boolean;
  lastEventAt: string | null;
  lastEventType: EventType | null;
}

export interface InstanceListDTO {
  items: InstanceListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Instance detail (GET /observability/instances/:id)
// ---------------------------------------------------------------------------

export interface MessageDTO {
  id: string;
  direction: MessageDirection;
  subject: string | null;
  body: string;
  threadId: string | null;
  replyIntent: ReplyIntent | null;
  classifyConfidence: number | null;
  negotiationRound: number | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface EventDTO {
  id: string;
  type: EventType;
  nodeId: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  /** Extracted from payload when present — who triggered this. */
  source: string | null;
}

export interface AgentDecisionDTO {
  /** "classification" | "negotiation" */
  kind: "classification" | "negotiation";
  occurredAt: string;
  /** Classification: intent. Negotiation: outcome. */
  decision: string | null;
  confidence: number | null;
  round: number | null;
  reasoning: string | null;
  messageId: string | null;
}

// One persisted LLM call (from the LlmCall table). Token fields are null when
// the provider reported no usage — distinct from 0.
export interface LlmCallDTO {
  id: string;
  role: LlmCallRole;
  model: string;
  promptVersion: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estCostUsd: number | null;
  ok: boolean;
  errorKind: string | null;
  createdAt: string;
}

// Aggregate over a set of LLM calls. Token/cost sums treat unreported as 0.
export interface LlmUsageTotalsDTO {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUsd: number;
  avgLatencyMs: number | null;
}

// PLU-111: one conversation obligation for the inspector (a creator question we
// owe an answer to, or a Pluvus commitment we owe an action on).
export interface ConversationObligationDTO {
  id: string;
  type: ObligationType;
  status: ConversationObligationStatus;
  /** True for OPEN/DEFERRED/ESCALATED — still in the AI context, still actionable. */
  open: boolean;
  originalText: string;
  category: string | null;
  resolution: string | null;
  resolutionSource: string | null;
  sourceMessageId: string | null;
  resolutionMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// PLU-82 §4.6: the knowledge observability block. Read-only; operator-gated via
// the /observability requireOperatorKey. Backed entirely by the existing event
// log (no new EventType/table).

/** One material brief-vs-Campaign conflict (mirrors BriefFieldConflict). The
 *  campaignValue + briefExcerpt are the two disagreeing sources shown to the
 *  operator (requirement: expose the conflicting sources). */
export interface KnowledgeConflictDTO {
  section: string;
  campaignField: string;
  campaignValue: string;
  briefExcerpt: string;
  pageStart?: number;
  reason: string;
  /** The round this conflict was FIRST recorded on (from the NEGOTIATION_TURN
   *  payload). Kept as `round` for backward compatibility with the panel. */
  round: number | null;
  /** review §6 (Calvin): the last round this exact conflict was still reported. */
  lastRound: number | null;
  /** review §6 (Calvin): "active" — still present in the most recent turn whose
   *  brief was re-resolved; "cleared" — present earlier but absent from that latest
   *  resolution (the source was corrected). Lets the operator panel distinguish a
   *  currently-active conflict from a since-corrected one instead of showing every
   *  historical conflict as though it were live. */
  status: "active" | "cleared";
}

/** The four-state brief availability (§4.4), as last surfaced on a turn. */
export interface BriefAvailabilityDTO {
  status: "NO_BRIEF" | "AVAILABLE" | "PARTIAL" | "PARSE_FAILED";
  /** Immutable uploaded-brief reference, when a brief is configured. */
  fileReference: string | null;
  error: string | null;
  missingSections: string[];
  /** The round this availability was recorded on. */
  round: number | null;
}

export interface KnowledgeDTO {
  /** Latest brief availability seen across the instance's turns (null if none). */
  briefAvailability: BriefAvailabilityDTO | null;
  /** All material conflicts recorded across turns (deduped by field+reason). Each
   *  carries a `status` — "active" (still present in the latest resolution) vs
   *  "cleared" (since corrected) — so a recovered conflict no longer reads as live
   *  (review §6). */
  conflicts: KnowledgeConflictDTO[];
  /** The winning-source label per finalized term, from the post-acceptance
   *  executor's event payload (deliverables/timeline/paymentTerms/… → label). */
  resolvedSources: Record<string, string | null>;
}

export interface InstanceDetailDTO {
  instance: {
    instanceId: string;
    workflowVersionId: string;
    workflowVersion: number | null;
    workflowName: string | null;
    state: InstanceState;
    currentNodeId: string | null;
    negotiationRound: number;
    followUpCount: number;
    dueAt: string | null;
    enrolledAt: string;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastTransitionSource: string | null;
  };
  creator: {
    id: string;
    name: string;
    email: string;
    handle: string | null;
    niche: string | null;
    platform: string | null;
  };
  messages: MessageDTO[];
  events: EventDTO[];
  agentDecisions: AgentDecisionDTO[];
  /** HARD-O1: this instance's LLM spend — per-call rows + totals. */
  llmUsage: {
    totals: LlmUsageTotalsDTO;
    calls: LlmCallDTO[];
  };
  /** PLU-111: the conversation obligations — open creator questions + Pluvus
   *  commitments (and their resolved history) — for the inspector. */
  obligations: ConversationObligationDTO[];
  /** PLU-82: the knowledge block — brief availability, material conflicts, and
   *  the selected finalized-terms sources. Absent (undefined) when nothing has
   *  been recorded yet, so older instances render an empty panel. */
  knowledge?: KnowledgeDTO;
}

// ---------------------------------------------------------------------------
// LLM usage (GET /observability/llm) — HARD-O1
// ---------------------------------------------------------------------------

export interface LlmUsageBreakdownEntryDTO {
  /** The group key: a role ("classify" | ...) or a model label. */
  key: string;
  totals: LlmUsageTotalsDTO;
}

/**
 * P4 daily spend monitor. Reports the configured 24h spend threshold, the
 * current trailing-24h estimated spend, and whether it has been exceeded, so the
 * operator (and any alerting) can see a runaway bill without a metrics backend.
 * Disabled (thresholdUsd null) when LLM_DAILY_SPEND_ALERT_USD is unset.
 */
export interface LlmSpendGuardDTO {
  /** Configured daily alert threshold in USD, or null when unset (guard off). */
  thresholdUsd: number | null;
  /** Trailing-24h estimated spend in USD (mirrors last24h.estCostUsd). */
  spentUsd: number;
  /** True when a threshold is set AND spentUsd has crossed it. */
  exceeded: boolean;
  /** Fraction of the threshold used (spentUsd/thresholdUsd), or null when off. */
  ratio: number | null;
}

export interface LlmUsageSummaryDTO {
  /** All-time totals across every persisted call. */
  totals: LlmUsageTotalsDTO;
  /** Totals over the trailing 24 hours. */
  last24h: LlmUsageTotalsDTO;
  byRole: LlmUsageBreakdownEntryDTO[];
  byModel: LlmUsageBreakdownEntryDTO[];
  /** Most recent calls, newest first. */
  recent: LlmCallDTO[];
  /** P4 daily spend guard status (threshold vs trailing-24h spend). */
  spendGuard: LlmSpendGuardDTO;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Timeline (GET /observability/timeline/:id)
// ---------------------------------------------------------------------------

export interface TimelineEntryDTO {
  id: string;
  type: EventType;
  occurredAt: string;
  nodeId: string | null;
  source: string | null;
  /** Human-readable one-line summary of the event. */
  summary: string;
  /** For STATE_TRANSITION events. */
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown> | null;
}

export interface TimelineDTO {
  instanceId: string;
  entries: TimelineEntryDTO[];
}

// ---------------------------------------------------------------------------
// Logs / trace (GET /observability/logs/:id)
// ---------------------------------------------------------------------------

export interface LogEntryDTO {
  occurredAt: string;
  fromState: string | null;
  toState: string | null;
  source: string | null;
  worker: string | null;
  queueJobId: string | null;
  nodeId: string | null;
  eventType: EventType;
}

export interface LogsDTO {
  instanceId: string;
  /** Reconstructed transition trace, chronological. */
  trace: LogEntryDTO[];
}
