// ---------------------------------------------------------------------------
// API DTO mirror (Phase 9)
// ---------------------------------------------------------------------------
// Hand-mirrored from server/src/observability/dto.ts. The server is the source
// of truth for these shapes; this file is the frontend's view of the contract.

export type InstanceState =
  | "ENROLLED"
  | "OUTREACH_SENT"
  | "AWAITING_REPLY"
  | "FOLLOWED_UP"
  | "REPLY_RECEIVED"
  | "NEGOTIATING"
  | "ACCEPTED"
  | "REWARD_PENDING"
  | "REWARD_CONFIRMED"
  | "PAYMENT_PENDING"
  | "PAYMENT_RECEIVED"
  | "CONTENT_BRIEF_SENT"
  | "NEEDS_DEAL_FINALIZATION"
  | "HANDOFF_COMPLETE"
  | "REJECTED"
  | "OPTED_OUT"
  | "NO_RESPONSE"
  | "MANUAL_REVIEW";

export type MessageDirection = "OUTBOUND" | "INBOUND";
export type ReplyIntent =
  | "POSITIVE"
  | "NEGATIVE"
  | "QUESTION"
  | "OPT_OUT"
  | "UNKNOWN"
  // Phase D (#3): creator replied with no clear commitment — schedules a soft follow-up.
  | "DEFERRED";

// ---- workflow summary ----

export interface WorkflowNodeSummary {
  state: InstanceState;
  count: number;
  terminal: boolean;
  active: number;
  waiting: number;
  stuck: number;
  avgTimeInStateSeconds: number | null;
}

export interface WorkflowSummary {
  workflow: { id: string; name: string; version: number; versionId: string } | null;
  totalInstances: number;
  nodes: WorkflowNodeSummary[];
  generatedAt: string;
}

// ---- workflow selector (W-6) ----

export interface WorkflowOption {
  workflowId: string;
  workflowName: string;
  latestVersionId: string;
  latestVersion: number;
  instanceCount: number;
}

export interface WorkflowOptions {
  workflows: WorkflowOption[];
}

// ---- instance list ----

export interface InstanceListItem {
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
  waitingForSeconds: number;
  stuck: boolean;
  lastEventAt: string | null;
  lastEventType: string | null;
}

export interface InstanceList {
  items: InstanceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ---- instance detail ----

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
  type: string;
  nodeId: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  source: string | null;
}

export interface AgentDecisionDTO {
  kind: "classification" | "negotiation";
  occurredAt: string;
  decision: string | null;
  confidence: number | null;
  round: number | null;
  reasoning: string | null;
  messageId: string | null;
}

export interface InstanceDetail {
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
  llmUsage: {
    totals: LlmUsageTotals;
    calls: LlmCallDTO[];
  };
  // PLU-111: open creator questions + Pluvus commitments (and resolved history).
  obligations: ConversationObligationDTO[];
  // PLU-82: the knowledge block — brief availability, material conflicts, and the
  // selected finalized-terms sources. Absent for older instances.
  knowledge?: KnowledgeDTO;
  // PLU-81: the sanitized AI-context record from the latest turn (labels/keys/counts
  // only — never values). Absent when no turn has assembled context ("empty = no
  // turn ran").
  context?: ContextDTO;
}

// ---- Knowledge (PLU-82) ----
// Read-only observability: which source won each finalized term, the four-state
// brief availability, and any material brief-vs-Campaign conflict surfaced to the
// operator (the conflicting sources are shown, not auto-resolved).

export interface KnowledgeConflictDTO {
  section: string;
  campaignField: string;
  campaignValue: string;
  briefExcerpt: string;
  pageStart?: number;
  reason: string;
  round: number | null;
}

export interface BriefAvailabilityDTO {
  status: "NO_BRIEF" | "AVAILABLE" | "PARTIAL" | "PARSE_FAILED";
  error: string | null;
  missingSections: string[];
  round: number | null;
}

export interface KnowledgeDTO {
  briefAvailability: BriefAvailabilityDTO | null;
  conflicts: KnowledgeConflictDTO[];
  resolvedSources: Record<string, string | null>;
}

// ---- Context (PLU-81) ----
// The sanitized AI-context record from the latest turn. Labels/keys/counts only —
// never values. Band PRESENCE only (never the floor/ceiling numbers). estimatedTokens
// is a LABELED coarse chars/4 proxy; the real token truth is the LLM usage tab
// (LlmCall.inputTokens). Absent when no turn has assembled context.
export interface ContextDTO {
  purpose: string;
  round: number | null;
  messageIdsIncluded: string[];
  eventCount: number;
  campaignFieldsSelected: string[];
  briefSectionsUsed: string[];
  openObligationIds: string[];
  summaryVersion?: string;
  estimatedTokens: number;
  sourcesUsed: string[];
  bandPresent: boolean;
}

// ---- Conversation obligations (PLU-111) ----
// Distinct from the payout-ledger `Obligation` type below (money owed) — this is
// a conversation thread owed (a creator question, or a Pluvus commitment).

export type ObligationType = "CREATOR_QUESTION" | "PLUVUS_COMMITMENT";

export type ConversationObligationStatus =
  | "OPEN"
  | "ANSWERED"
  | "DEFERRED"
  | "ESCALATED"
  | "COMPLETED"
  | "CANCELED"
  | "NO_LONGER_RELEVANT";

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

/** The terminal statuses an operator may set from the inspector. */
export type ManualResolveStatus =
  | "ANSWERED"
  | "COMPLETED"
  | "CANCELED"
  | "NO_LONGER_RELEVANT";

// ---- LLM usage (HARD-O1) ----

export type LlmCallRole = "classify" | "negotiate" | "draft";

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

export interface LlmUsageTotals {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUsd: number;
  avgLatencyMs: number | null;
}

export interface LlmUsageBreakdownEntry {
  key: string;
  totals: LlmUsageTotals;
}

export interface LlmUsageSummary {
  totals: LlmUsageTotals;
  last24h: LlmUsageTotals;
  byRole: LlmUsageBreakdownEntry[];
  byModel: LlmUsageBreakdownEntry[];
  recent: LlmCallDTO[];
  generatedAt: string;
}

// ---- timeline ----

export interface TimelineEntry {
  id: string;
  type: string;
  occurredAt: string;
  nodeId: string | null;
  source: string | null;
  summary: string;
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown> | null;
}

export interface Timeline {
  instanceId: string;
  entries: TimelineEntry[];
}

// ---- logs ----

export interface LogEntry {
  occurredAt: string;
  fromState: string | null;
  toState: string | null;
  source: string | null;
  worker: string | null;
  queueJobId: string | null;
  nodeId: string | null;
  eventType: string;
}

export interface Logs {
  instanceId: string;
  trace: LogEntry[];
}

// ---- meta ----

export interface ObservabilityMeta {
  states: InstanceState[];
  terminalStates: InstanceState[];
  waitingStates: InstanceState[];
}

// ---------------------------------------------------------------------------
// Attribution & Payouts (Phase 4)
// ---------------------------------------------------------------------------

export interface PartnershipMetrics {
  clicks: number;
  conversions: number;
  revenueCents: number;
  earnedCents: number;
  unpaidCents: number;
  paidCents: number;
}

export interface PayoutRollup {
  unpaidFeeCents: number;
  unpaidCommissionCents: number;
  inFlightCents: number;
  settledCents: number;
  hasDispute: boolean;
}

export interface PartnershipListItem {
  id: string;
  instanceId: string;
  campaignId: string | null;
  creatorId: string;
  referralCode: string;
  trackingLink: string | null;
  commissionRate: number | null;
  agreedFeeCents: number | null;
  status: "ACTIVE" | "PAUSED";
  createdAt: string;
  updatedAt: string;
  // Joined
  creatorName: string;
  creatorEmail: string;
  campaignName: string | null;
  // Phase 4 additions
  metrics: PartnershipMetrics;
  rollup: PayoutRollup;
}

export interface PaymentInfoSummary {
  method: string | null;
  accountIdentifier: string | null;
  shipping: unknown | null;
}

export interface Conversion {
  id: string;
  partnershipId: string | null;
  referralCode: string | null;
  externalId: string;
  valueCents: number;
  currency: string;
  commissionCents: number;
  customerEmail: string | null;
  payoutId: string | null;
  refunded: boolean;
  attributedAt: string;
}

export interface Obligation {
  id: string;
  partnershipId: string;
  description: string;
  amountCents: number;
  status: "PENDING" | "PAID" | "CANCELLED";
  payoutId: string | null;
  createdAt: string;
  paidAt: string | null;
}

export type PayoutStatus = "PENDING" | "SENT" | "CONFIRMED" | "DISPUTED" | "SETTLED";
export type PayoutType = "COMMISSION" | "FIXED_FEE";

export interface Payout {
  id: string;
  partnershipId: string;
  payoutType: PayoutType;
  amountCents: number;
  currency: string;
  status: PayoutStatus;
  method: string | null;
  destination: string | null;
  reference: string | null;
  note: string | null;
  conversionCount: number;
  sentAt: string | null;
  confirmedAt: string | null;
  disputedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
  emailSent?: boolean;
}

export interface PartnershipDetail extends PartnershipListItem {
  creator: {
    id: string;
    name: string;
    email: string;
    handle: string | null;
    platform: string | null;
  };
  campaign: { name: string; brand: string | null; targetUrl: string | null } | null;
  paymentInfo: PaymentInfoSummary | null;
  recentConversions: Conversion[];
  recentClicks: Array<{ id: string; clickedAt: string }>;
}

export interface PartnershipPayoutsResponse {
  payouts: Payout[];
  obligations: Obligation[];
}
