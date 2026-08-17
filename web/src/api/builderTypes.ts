// ---------------------------------------------------------------------------
// Builder API types (Phase 10) — mirrors server DTOs
// ---------------------------------------------------------------------------

export type WorkflowStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type TemplateKey = "affiliate" | "hybrid" | "fixed_fee";

// ---------------------------------------------------------------------------
// Node types + configs
// ---------------------------------------------------------------------------

export type NodeType =
  | "IMPORT_CREATOR_LIST"
  | "INITIAL_OUTREACH"
  | "FOLLOW_UP"
  | "REPLY_DETECTION"
  | "NEGOTIATION"
  | "REWARD_SETUP"
  | "PAYMENT_INFO"
  | "CONTENT_BRIEF"
  | "END";

export interface InitialOutreachConfig {
  // Manual Initial Outreach. "manual" (default for new nodes) → the operator's
  // subject/body below ARE the email, sent verbatim after {{variable}}
  // substitution; the AI is not called. "ai" → the AI writes the outreach and
  // these templates are the fallback. Absent (legacy nodes) is treated as "ai"
  // by the executor so already-published campaigns are unchanged.
  outreachMode?: "manual" | "ai";
  subjectTemplate: string;
  bodyTemplate: string;
}

export interface FollowUpConfig {
  intervals: number[];
  intervalUnit: "seconds" | "minutes" | "hours" | "days";
  maxCount: number;
  bodyTemplate: string;
  // NOTE: no stopOnReply field. Follow-ups ALWAYS stop when the creator replies
  // — that's hardcoded in the runtime (an inbound reply clears the follow-up
  // dueAt), never read from config. The old toggle was a no-op and was removed.
}

// Reply Detection has NO configurable fields. The classifier's low-confidence
// threshold is a fixed engine constant (0.50) and low-confidence replies always
// route to Manual Review — neither was ever read from node config. The former
// lowConfidenceThreshold / manualReviewOnLowConfidence fields were dead and were
// removed; the type is kept (empty) so the NodeConfig union and node identity
// stay stable.
export type ReplyDetectionConfig = Record<string, never>;

export interface NegotiationConfig {
  /**
   * "Preferred Budget" in the UI (V1 #1). The rate the brand would ideally
   * close at — the agent opens here and concedes up only as needed. Field name
   * kept as minBudget for config compatibility; only the human-facing label
   * changed.
   */
  minBudget: number;
  /**
   * "Maximum Budget" in the UI (V1 #1). Absolute ceiling — the agent never
   * offers above it. Every dollar above the preferred budget is a worse
   * outcome, so $260 in a $200–500 band beats $490. Field name kept as
   * maxBudget for config compatibility.
   */
  maxBudget: number;
  maxRounds: number;
  // NOTE: no approvalMode field. The engine always auto-accepts within budget;
  // the old "manual — human approves final terms" option was never read, so it
  // promised a human gate that didn't exist. The control + field were removed.
  commissionRate?: number;
  /**
   * Phase C (#12): merchant tolerance ABOVE the max budget, as a percent. 0 (or
   * omitted) = zero tolerance — the agent escalates the moment a creator's ask
   * exceeds the max. When > 0, an ask up to maxBudget*(1 + tolerance/100) is
   * countered/closed AT the max (never above it) instead of escalated; anything
   * higher still escalates to a human. V1 applies only to the fixed fee.
   */
  overCeilingTolerance?: number;
}

// Reward Setup finalizes the agreement after a successful negotiation. The final
// fee is the rate the negotiation closed on (resolved at runtime); commission and
// deliverables are stamped from the campaign / negotiation config.
export interface RewardSetupConfig {
  commissionRate?: number;
  deliverables?: string;
  timeline?: string;
}

// Payment Info collects the creator's payout details via a hosted form after
// they confirm the agreement. It needs no builder config today (the form link +
// email are derived at runtime); the interface exists so the node type is fully
// modelled and future payout options can be added without a type change.
export interface PaymentInfoConfig {
  [key: string]: unknown;
}

// Content Brief is the merged post-negotiation node: on ACCEPTED it sends ONE
// email with the finalized offer (fee/commission/deliverables/timeline), a secure
// payout-form link, and the campaign brief (PDF + optional notes), then waits for
// the creator to submit the form. The brand configures the brief fields in the
// builder before launch; the offer fields are stamped from the campaign /
// negotiation config at save/publish (like the legacy Reward Setup node). Only
// the uploaded PDF's stored reference is persisted — never the bytes; the
// original filename is kept for display + the attachment.
//
// NOTE: there is no manual referral-link field. Attribution mints a UNIQUE
// per-creator tracking link (server: partnership.ts) delivered in the welcome
// email; a static brand-typed link here would be redundant and track nothing.
export interface ContentBriefConfig {
  /** Stored reference for the uploaded Campaign Brief PDF (required to launch). */
  briefFileRef?: string;
  /** Original filename of the uploaded PDF, for display + the email attachment. */
  briefFileName?: string;
  /** Optional brand notes shown to the creator in the email body. */
  creatorNotes?: string;
  /** Commission %, stamped from the negotiation node (for display in the builder). */
  commissionRate?: number;
  /** Deliverables scope, stamped from the campaign. */
  deliverables?: string;
  /** Go-live timeline, stamped from the campaign. */
  timeline?: string;
}

export type NodeConfig =
  | InitialOutreachConfig
  | FollowUpConfig
  | ReplyDetectionConfig
  | NegotiationConfig
  | RewardSetupConfig
  | PaymentInfoConfig
  | ContentBriefConfig
  | Record<string, unknown>;

export interface DraftNode {
  id: string;
  type: NodeType;
  order: number;
  config: NodeConfig;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

/** PLU-136: how the creator is compensated. Never gates whether the campaign
 *  negotiates — every structure does. */
export type CampaignType = "PAID" | "AFFILIATE" | "HYBRID" | "GIFT_ONLY";

/** PLU-136: only meaningful when includesGifting is true or campaignType is
 *  GIFT_ONLY. GIFT_ONLY specifically requires KEEP — the product is the
 *  entire payment, so a loaned/returned product would mean no payment. */
export type GiftDisposition = "KEEP" | "LOAN" | "RETURN";

/** PLU-136: for PAID/HYBRID — request the creator's own rate card, or
 *  propose a starting fee up front. */
export type PriceStrategy = "REQUEST_RATE_CARD" | "PROPOSE_STARTING_FEE";

/** PLU-136: every campaign predating the compensation-contract migration
 *  defaults NEEDS_REVIEW — never silently treated as a verified
 *  classification. A campaign created through this wizard is CONFIRMED
 *  automatically (an explicit, verified selection). */
export type CompensationReviewStatus = "NEEDS_REVIEW" | "CONFIRMED";

/** PLU-135 (1a): campaign lifecycle. DRAFT is editable; ACTIVE means launched —
 *  CampaignDetails/BrandIdentity/CreatorRequirement writes are rejected (409). */
export type CampaignStatus = "DRAFT" | "ACTIVE";

/** PLU-139 (2a): one row of the per-platform deliverable quantity list (S3.2–S3.9). */
export interface DeliverableQuantity {
  platform: string;
  format: string;
  quantity: number;
}

/** PLU-139 (2a): S7.P1 per-deliverable pricing — cents keyed by "<platform>:<format>". */
export type DeliverablePricing = Record<string, number>;

/** PLU-139 (2a): S3.11 per-platform follower ranges — keyed by platform. `max`
 *  null = no upper limit. */
export type FollowerRanges = Record<string, { min: number | null; max: number | null }>;

/** PLU-139: how a creator-facing value got here. Only the reachable sources are
 *  recorded today — a field the brand typed/edited is "manual"; a value applied
 *  from an uploaded brief candidate is "pdf_extracted". */
export type FieldProvenanceValue = "manual" | "pdf_extracted";

/** PLU-139: field-key → provenance. An absent key means "no provenance recorded". */
export type FieldProvenance = Record<string, FieldProvenanceValue>;

/** PLU-139 (2a): the worksheet Stage-1 public-brief fields that gained
 *  CampaignDetails columns. All nullable — an incomplete Draft is valid. Shared
 *  by CampaignListItem and CampaignDetail (both flatten the same row). */
export interface WorksheetStage1Fields {
  productName: string | null; // S2.3
  productType: string | null; // S2.4
  creatorAccessNeeded: boolean | null; // S2.5
  uniqueSellingPoints: string | null; // S2.7
  whyTrust: string | null; // S2.8
  howToUse: string | null; // S2.9
  brandAssets: string | null; // S2.10
  brandMaterialsRef: string | null; // S1.4
  deliverableQuantities: DeliverableQuantity[] | null; // S3.2–S3.9
  deliverablePricing: DeliverablePricing | null; // S7.P1
  followerRanges: FollowerRanges | null; // S3.11
  briefDeliveryMethod: string | null; // S5.1
  briefHighlight: string | null; // S5.2
  creativeConcept: string | null; // S5.4
  referenceVideos: string | null; // S5.5
  scriptSubmission: string | null; // S5.6
  adAuthorization: string | null; // S6.3
  linkInBioDuration: string | null; // S6.2
  postRetention: string | null; // S6.4
  instagramCollab: boolean | null; // S6.7
  requireApproval: boolean | null; // S7.3
  commissionMode: string | null; // S7.A1 ("percent" | "flat")
  variableCommission: string | null; // S7.A3
  giftDeliveryMethod: string | null; // S7.G1
  promoCode: string | null; // S7.G2
  giftContactEmail: string | null; // S7.G4
  requiresShippingInfo: boolean | null; // S7.G7
  affiliateTrackingUrl: string | null; // S7.T0
  trackingLinkMode: string | null; // S7.T1
  trackingDestinationUrl: string | null; // S7.T2
  trackingParameter: string | null; // S7.T3
}

export interface CampaignListItem extends WorksheetStage1Fields {
  id: string;
  name: string;
  brand: string;
  /** PLU-135 (1a): DRAFT (editable) | ACTIVE (launched, locked). */
  status: CampaignStatus;
  objective: string | null;
  notes: string | null;
  notifyEmail: string | null;
  brandDescription: string | null;
  deliverables: string | null;
  timeline: string | null;
  /** Free-text product/sample reward blurb woven into the email copy. */
  rewardDescription: string | null;
  /** When true, the payment form also collects a shipping address. Distinct
   *  from includesGifting below — a content-creation sample the creator
   *  ships back is not automatically compensation. */
  shipsPhysicalProduct: boolean;
  postAcceptanceMode: PostAcceptanceMode;
  dailyInitialOutreachLimit: number | null;
  outreachPacingMinMinutes: number | null;
  outreachPacingMaxMinutes: number | null;
  negotiationReplyPacingMinMinutes: number | null;
  negotiationReplyPacingMaxMinutes: number | null;
  /** PLU-121: the connected mailbox outreach is sent from (a
   *  ConnectedEmailAccount id), or null to use the default account. */
  emailAccountId: string | null;
  // PLU-136: compensation data contract fields.
  campaignType: CampaignType | null;
  includesGifting: boolean;
  giftDisposition: GiftDisposition | null;
  priceStrategy: PriceStrategy | null;
  publicStartingFeeCents: number | null;
  publicCommissionRate: number | null;
  commissionDurationDays: number | null;
  commissionConditions: string | null;
  compensationReviewStatus: CompensationReviewStatus | null;
  // PLU-135: creator-facing knowledge fields (live on CampaignDetails). Stated
  // verbatim by the agent when a creator asks; deferred honestly when null.
  usageRights: string | null;
  exclusivity: string | null;
  paymentTerms: string | null;
  attributionWindow: string | null;
  keyMessages: string | null;
  contentRequirements: string | null;
  targetUrl: string | null;
  hiddenParamKey: string | null;
  /** PLU-136 (1b): set on a campaign minted via "Duplicate as new campaign". */
  duplicatedFromCampaignId: string | null;
  createdAt: string;
  updatedAt: string;
  workflowCount: number;
}

/**
 * PLU-121: a connected email account (one Nylas grant = one mailbox). Returned by
 * GET /email-accounts and shown in the campaign wizard's sender picker.
 */
export interface ConnectedEmailAccount {
  id: string;
  nylasGrantId: string;
  emailAddress: string;
  displayName: string | null;
  provider: string;
  status: "active" | "disabled" | "revoked";
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignWorkflowItem {
  id: string;
  name: string;
  status: WorkflowStatus;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignDetail extends WorksheetStage1Fields {
  id: string;
  name: string;
  brand: string;
  /** PLU-135 (1a): DRAFT (editable) | ACTIVE (launched, locked). */
  status: CampaignStatus;
  /** PLU-139: field-key → how that value got here (manual | pdf_extracted). */
  fieldProvenance: FieldProvenance | null;
  objective: string | null;
  notes: string | null;
  notifyEmail: string | null;
  brandDescription: string | null;
  deliverables: string | null;
  timeline: string | null;
  /** Free-text product/sample reward blurb woven into the email copy. */
  rewardDescription: string | null;
  /** When true, the payment form also collects a shipping address. */
  shipsPhysicalProduct: boolean;
  postAcceptanceMode: PostAcceptanceMode;
  dailyInitialOutreachLimit: number | null;
  outreachPacingMinMinutes: number | null;
  outreachPacingMaxMinutes: number | null;
  negotiationReplyPacingMinMinutes: number | null;
  negotiationReplyPacingMaxMinutes: number | null;
  /** PLU-121: the connected mailbox outreach is sent from, or null for default. */
  emailAccountId: string | null;
  // PLU-136: compensation data contract fields.
  campaignType: CampaignType | null;
  includesGifting: boolean;
  giftDisposition: GiftDisposition | null;
  priceStrategy: PriceStrategy | null;
  publicStartingFeeCents: number | null;
  publicCommissionRate: number | null;
  commissionDurationDays: number | null;
  commissionConditions: string | null;
  compensationReviewStatus: CompensationReviewStatus | null;
  // PLU-135: creator-facing knowledge fields (live on CampaignDetails).
  usageRights: string | null;
  exclusivity: string | null;
  paymentTerms: string | null;
  attributionWindow: string | null;
  keyMessages: string | null;
  contentRequirements: string | null;
  targetUrl: string | null;
  hiddenParamKey: string | null;
  /** PLU-136 (1b): set on a campaign minted via "Duplicate as new campaign". */
  duplicatedFromCampaignId: string | null;
  createdAt: string;
  updatedAt: string;
  workflows: CampaignWorkflowItem[];
}

// ---------------------------------------------------------------------------
// PLU-139 (2a): BrandIdentity + CreatorRequirement — the two public intake
// sections. Fetched/patched via their own sub-endpoints (not folded into the
// flat campaign payload), draft-only (409 once the campaign is ACTIVE).
// ---------------------------------------------------------------------------

/** PLU-135: how a BrandIdentity's values were populated. */
export type BrandIdentityExtractionSource = "EXTRACTED" | "MANUAL" | "DEFAULT";

export interface BrandIdentityFields {
  id: string;
  campaignId: string;
  logoRef: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  typography: string | null;
  extractionSource: BrandIdentityExtractionSource | null;
  extractedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Informational only — never drives matching/ranking/outreach. */
export interface CreatorRequirementFields {
  id: string;
  campaignId: string;
  platforms: string[] | null;
  niches: string[] | null;
  geography: string[] | null;
  languages: string[] | null;
  minFollowers: number | null;
  audienceNotes: string | null;
  contentStyle: string | null;
  brandSafety: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The write shape for each PATCH (all optional/nullable). */
export type BrandIdentityInput = Partial<
  Omit<BrandIdentityFields, "id" | "campaignId" | "extractionSource" | "extractedAt" | "createdAt" | "updatedAt">
>;
export type CreatorRequirementInput = Partial<
  Omit<CreatorRequirementFields, "id" | "campaignId" | "createdAt" | "updatedAt">
>;

// ---------------------------------------------------------------------------
// PLU-140 (2b): NegotiationPolicy — the ONE private negotiation policy per
// Draft campaign. Fetched/patched via its own sub-endpoint (never folded into
// the creator-facing campaign payload — that separation is the privacy
// boundary), draft-only (409 once ACTIVE). Mirrors the NegotiationPolicy table
// columns (server/src/db/schema.ts): cents as ints, rates as 0..1 doubles.
// ---------------------------------------------------------------------------

/** The negotiable/non-negotiable category markers the readiness check reads. */
export type NegotiationCategory = "fee" | "commission" | "gift";

export interface NegotiationPolicyFields {
  id: string;
  campaignId: string;
  floorCents: number | null;
  ceilingCents: number | null;
  preferredFeeCents: number | null;
  commissionFloorRate: number | null;
  commissionCeilingRate: number | null;
  preferredCommissionRate: number | null;
  maxRounds: number | null;
  openingOfferPosition: number | null;
  overCeilingTolerance: number | null;
  negotiationGuidance: string | null;
  giftSubstitutionAllowed: boolean | null;
  giftValueFlexibilityCents: number | null;
  negotiableTerms: NegotiationCategory[] | null;
  nonNegotiableTerms: NegotiationCategory[] | null;
  createdAt: string;
  updatedAt: string;
}

/** The write shape for the policy PATCH (all optional/nullable). */
export type NegotiationPolicyInput = Partial<
  Omit<NegotiationPolicyFields, "id" | "campaignId" | "createdAt" | "updatedAt">
>;

/** PLU-140: read-only projection of launchCampaign's preconditions, so the
 *  review page shows blockers before Activate. `ready` ⇒ POST /launch succeeds. */
export interface CampaignReadiness {
  ready: boolean;
  blockers: string[];
  reviewConfirmed: boolean;
  hasPolicy: boolean;
  hasDetails: boolean;
}

/** PLU-140: the successful DRAFT→ACTIVE launch result (POST /launch). */
export interface LaunchResult {
  campaignId: string;
  campaignTermsSnapshotId: string;
  launchedAt: string;
}

// ---------------------------------------------------------------------------
// PLU-139 (2a): brief import / candidate extraction. A stored, append-only
// EVIDENCE record of one brief-PDF parse — never authoritative. The intake shows
// its `sections` as candidates the brand confirms into CampaignDetails; it never
// auto-writes. `sections` is the parser's section map (keys like usageRights,
// paymentTerms, deliverables → { text, ... }); shape is best-effort so it's typed
// loosely and read defensively.
// ---------------------------------------------------------------------------
export interface BriefExtractionSection {
  type?: string;
  text?: string;
  pageStart?: number;
  pageEnd?: number;
  extractionConfidence?: number;
  sourceFileReference?: string;
  parserVersion?: string;
}

export interface BriefExtractionFields {
  id: string;
  campaignId: string;
  flatText: string;
  /** Parser section map. Keys are canonical field names (usageRights, etc.). */
  sections: Record<string, BriefExtractionSection> | null;
  other: unknown;
  sourceFileReference: string;
  parserVersion: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * PLU-70: what happens after a creator accepts.
 *   local_payment    — collect payout details and send the brief automatically
 *   operator_handoff — pause after the agreement; a human finalizes it in Pluvus
 * Every existing campaign and execution is local_payment.
 */
export type PostAcceptanceMode = "local_payment" | "operator_handoff";

export interface WorkflowCampaign {
  id: string;
  name: string;
  brand: string;
  /** The campaign default the enroll tab pre-selects (and lets you override). */
  postAcceptanceMode: PostAcceptanceMode;
  dailyInitialOutreachLimit: number | null;
  outreachPacingMinMinutes: number | null;
  outreachPacingMaxMinutes: number | null;
  negotiationReplyPacingMinMinutes: number | null;
  negotiationReplyPacingMaxMinutes: number | null;
}

export interface WorkflowLatestVersion {
  id: string;
  version: number;
  publishedAt: string;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  campaignId: string | null;
  campaign: WorkflowCampaign | null;
  draftNodes: DraftNode[];
  latestVersion: WorkflowLatestVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersion {
  id: string;
  version: number;
  publishedAt: string;
  instanceCount: number;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RecentExecutionEvent {
  id: string;
  instanceId: string;
  creatorName: string;
  creatorHandle: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

export interface WorkflowExecutionSummary {
  versionId: string | null;
  version: number | null;
  totalInstances: number;
  /** Creator ids already enrolled in this workflow — drives the ENROLLED badge. */
  enrolledCreatorIds?: string[];
  stateCounts: Record<string, number>;
  recentEvents: RecentExecutionEvent[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Creator (enrollment)
// ---------------------------------------------------------------------------

/** One network's audience. `platform`/`followerCount` above reflect the biggest. */
export interface CreatorPlatformSummary {
  key: string;
  label: string;
  followers: number | null;
  engagementPct: number | null;
  handle: string | null;
  link: string | null;
}

export interface CreatorItem {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  platform: string | null;
  niche: string | null;
  profileUrl: string | null;
  /** Null means UNKNOWN audience, not zero — these sort last. */
  followerCount: number | null;
  engagementRate: number | null;
  location: string | null;
  language: string | null;
  /**
   * Every network with audience data, biggest first. The table shows only the
   * first; this is what surfaces "and 2 more" so a cross-platform creator is
   * not silently reduced to one network.
   */
  platforms?: CreatorPlatformSummary[];
}

// ---------------------------------------------------------------------------
// Creator import batches (PLU-109)
// ---------------------------------------------------------------------------
// One upload = one batch. Keeping them separate is what lets you come back the
// next day, pick "yesterday's list", and enroll only what is new.

export type ImportBatchStatus = "DRAFT" | "COMMITTED" | "ARCHIVED";
export type ImportRowOutcome = "PENDING" | "CREATED" | "UPDATED" | "SKIPPED";

export interface ImportBatch {
  id: string;
  label: string;
  sourceFilename: string;
  status: ImportBatchStatus;
  delimiter: string | null;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  hasFile: boolean;
  createdAt: string;
  committedAt: string | null;
}

export interface ImportRowError {
  row: number;
  reason: string;
}

/** A sample row shown in the pre-commit preview. */
export interface ImportPreviewRow {
  row: number;
  email: string;
  name: string;
  handle: string | null;
  platform: string | null;
  niche: string | null;
  followerCount: number | null;
  engagementRate: number | null;
  isNew: boolean;
}

/** Response to the upload — nothing has been written to the roster yet. */
export interface ImportDraftResponse {
  batch: ImportBatch;
  headers: string[];
  delimiter: string;
  rowCount: number;
  validCount: number;
  /** Rows whose email is not already in the roster. */
  newCount: number;
  existingCount: number;
  skippedCount: number;
  errors: ImportRowError[];
  preview: ImportPreviewRow[];
}

export interface ImportCommitResponse {
  batch: ImportBatch;
  created: number;
  updated: number;
  creators: CreatorItem[];
}

export interface ImportBatchMember {
  rowNumber: number;
  outcome: ImportRowOutcome;
  errorReason: string | null;
  creator: CreatorItem | null;
  /** Labels of other committed batches this creator also appears in. */
  alsoInBatches: string[];
}

export interface ImportBatchDetail {
  batch: ImportBatch;
  members: ImportBatchMember[];
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** A creator deliberately KEPT because removing them would destroy history. */
export interface CreatorDeleteBlock {
  id: string;
  email: string;
  name: string;
  /** e.g. "enrolled in 2 workflows · has 1 partnership" */
  reason: string;
}

export interface CreatorDeleteResult {
  deleted: string[];
  blocked: CreatorDeleteBlock[];
  deletedCount: number;
  blockedCount: number;
}

export interface ImportBatchDeleteResult {
  deletedBatch: { id: string; label: string; status: ImportBatchStatus };
  /** Import rows removed with the list. Creators are never removed. */
  memberCount: number;
}

// ---------------------------------------------------------------------------
// Publish / Enroll / Launch responses
// ---------------------------------------------------------------------------

export interface PublishResponse {
  versionId: string;
  version: number;
  publishedAt: string;
  notes: string | null;
}

export interface EnrollResponse {
  enrolled: number;
  skipped: number;
  versionId: string;
  /** The mode actually stamped onto these executions (override or campaign default). */
  postAcceptanceMode: PostAcceptanceMode;
}

export interface LaunchResponse {
  launched: number;
  versionId: string;
  totalInstances: number;
}

/** One structured validation issue as returned by the server. Mirrors the
 * frontend ValidationIssue shape (web/src/workflow/graphValidation.ts) so
 * publish/validate errors can stay tied to their node for click-to-focus. */
export interface ServerValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  severity: "error" | "warning";
}

export interface ValidationResponse {
  valid: boolean;
  errors: string[];
  /** Structured issues (added Phase 17); `errors` kept for back-compat. */
  issues?: ServerValidationIssue[];
}

// ---------------------------------------------------------------------------
// Manual Queue (Phase 11)
// ---------------------------------------------------------------------------

export type BrandNotificationStatus = "SENT" | "FAILED" | "SKIPPED";

export interface ManualQueueNotification {
  status: BrandNotificationStatus;
  recipient: string;
  error: string | null;
  sentAt: string;
}

/** PLU-70: the agreement half of a queue row. Present only when kind==="handoff". */
export interface ManualQueueHandoff {
  campaignName: string | null;
  /** Preformatted by the server, e.g. "$750 fixed fee + 30% commission". */
  agreedCompensation: string;
  acceptedAt: string;
  status: "AWAITING_FINALIZATION" | "COMPLETED";
  completedAt: string | null;
  deliverables: string | null;
  timeline: string | null;
  paymentTerms: string | null;
}

export interface ManualQueueItem {
  instanceId: string;
  /**
   * Which kind of "a human must act" this row is: an AI escalation, or a closed
   * deal awaiting operator onboarding. They share one queue because they share
   * one question — who picks this up?
   */
  kind: "escalation" | "handoff";
  creatorId: string;
  creatorName: string;
  creatorEmail: string;
  creatorHandle: string | null;
  platform: string | null;
  niche: string | null;
  negotiationRound: number;
  reason: string;
  reasonLabel: string;
  escalatedAt: string | null;
  updatedAt: string;
  /** E6: deep-link to the email thread holding the full conversation, or null when
   *  the provider can't build one (mock / unconfigured) or the instance hasn't
   *  threaded yet. The UI shows a link only when present. */
  threadUrl: string | null;
  /** Content-links escalation: the URLs the creator submitted (empty for every
   *  other escalation reason). Rendered as an openable list in the queue row. */
  submittedUrls: string[];
  /** Convenience count of submittedUrls (0 for non-content-links escalations). */
  linkCount: number;
  notification: ManualQueueNotification | null;
  handoff: ManualQueueHandoff | null;
}

export interface ManualQueueResponse {
  workflowId: string;
  versionId?: string;
  version?: number;
  items: ManualQueueItem[];
  total: number;
  generatedAt: string;
}

export interface CompleteHandoffResult {
  instanceId: string;
  state: string;
  completedAt: string;
  completedBy: string | null;
}

export interface NotifyResult {
  instanceId: string;
  reason: string;
  status: "SENT" | "FAILED" | "SKIPPED" | "ALREADY_NOTIFIED";
  recipient: string | null;
}
