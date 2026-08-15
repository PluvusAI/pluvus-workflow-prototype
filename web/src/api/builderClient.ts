// ---------------------------------------------------------------------------
// Builder API client — Phase 10
// ---------------------------------------------------------------------------
// Mutations use plain fetch (not useQuery) since they're one-shot.
// Queries use TanStack Query. Polling only on execution summary.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { POLL_INTERVAL_MS } from "./client";
import { withOperatorKey } from "./operatorKey";
import type {
  CampaignListItem,
  CampaignDetail,
  WorkflowDetail,
  WorkflowVersion,
  WorkflowExecutionSummary,
  CreatorItem,
  CreatorDeleteResult,
  ImportBatch,
  ImportBatchDeleteResult,
  ImportBatchDetail,
  ImportCommitResponse,
  ImportDraftResponse,
  DraftNode,
  PublishResponse,
  EnrollResponse,
  LaunchResponse,
  ValidationResponse,
  TemplateKey,
  ManualQueueResponse,
  NotifyResult,
  PostAcceptanceMode,
  CompleteHandoffResult,
  ConnectedEmailAccount,
  CampaignType,
  GiftDisposition,
  PriceStrategy,
  CompensationReviewStatus,
  BrandIdentityFields,
  BrandIdentityInput,
  CreatorRequirementFields,
  CreatorRequirementInput,
  NegotiationPolicyFields,
  NegotiationPolicyInput,
  CampaignReadiness,
  LaunchResult,
  BriefExtractionFields,
  DeliverableQuantity,
  DeliverablePricing,
  FollowerRanges,
  FieldProvenance,
} from "./builderTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // P2: operator routes (/campaigns, /workflows, /uploads, /manual-queue, ...) —
  // inject X-Operator-Key without clobbering Content-Type (no-op when unset).
  const res = await fetch(url, withOperatorKey(init));
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error ?? JSON.stringify(j);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail}`.trim());
  }
  // No body to parse (e.g. 204 No Content from DELETE) — calling res.json()
  // on an empty body throws a SyntaxError, so short-circuit here.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putJson<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () => apiFetch<CampaignListItem[]>("/api/campaigns"),
  });
}

export function useCampaign(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id],
    queryFn: () => apiFetch<CampaignDetail>(`/api/campaigns/${id}`),
    enabled: !!id,
  });
}

// PLU-121: connected email accounts for the campaign sender picker.
export function useEmailAccounts() {
  return useQuery({
    queryKey: ["email-accounts"],
    queryFn: () => apiFetch<ConnectedEmailAccount[]>("/api/email-accounts"),
  });
}

export function createCampaign(data: {
  name: string;
  brand: string;
  objective?: string;
  notes?: string;
  notifyEmail?: string;
  brandDescription?: string;
  deliverables?: string;
  timeline?: string;
  rewardDescription?: string;
  shipsPhysicalProduct?: boolean;
  targetUrl?: string;
  hiddenParamKey?: string;
  postAcceptanceMode?: PostAcceptanceMode;
  dailyInitialOutreachLimit?: number;
  outreachPacingMinMinutes?: number;
  outreachPacingMaxMinutes?: number;
  negotiationReplyPacingMinMinutes?: number;
  negotiationReplyPacingMaxMinutes?: number;
  /** PLU-121: the connected mailbox to send this campaign's outreach from. */
  emailAccountId?: string;
  // PLU-136: compensation data contract fields.
  campaignType?: CampaignType;
  includesGifting?: boolean;
  giftDisposition?: GiftDisposition;
  priceStrategy?: PriceStrategy;
  publicStartingFeeCents?: number;
  publicCommissionRate?: number;
  commissionDurationDays?: number;
  commissionConditions?: string;
  /** Set CONFIRMED when created through an explicit-selection UI (this
   *  wizard) — an actual brand choice, not an unverified backfill default. */
  compensationReviewStatus?: CompensationReviewStatus;
}) {
  return postJson<{ id: string; name: string }>("/api/campaigns", data);
}

// PATCH /campaigns/:id. The server (routes/campaigns.ts) routes each field to the
// Campaign row or its CampaignDetails row and rejects everything with 409 once the
// campaign is ACTIVE. This type was previously narrower than the route: the
// CampaignDetails knowledge fields (usageRights/…) and the whole PLU-136
// compensation block were already accepted server-side but not typed here. Widened
// (additively) so the sectioned intake (PLU-139 2a) can PATCH them. Returns the
// full flattened CampaignDetail-shaped object.
export function updateCampaign(
  id: string,
  data: {
    name?: string;
    brand?: string;
    notifyEmail?: string | null;
    objective?: string | null;
    notes?: string | null;
    brandDescription?: string | null;
    deliverables?: string | null;
    timeline?: string | null;
    rewardDescription?: string | null;
    shipsPhysicalProduct?: boolean;
    // PLU-135 creator-facing knowledge fields (CampaignDetails).
    usageRights?: string | null;
    exclusivity?: string | null;
    paymentTerms?: string | null;
    attributionWindow?: string | null;
    keyMessages?: string | null;
    contentRequirements?: string | null;
    // PLU-139 (2a): worksheet Stage-1 fields (all CampaignDetails, editable DRAFT).
    productName?: string | null;
    productType?: string | null;
    creatorAccessNeeded?: boolean | null;
    uniqueSellingPoints?: string | null;
    whyTrust?: string | null;
    howToUse?: string | null;
    brandAssets?: string | null;
    brandMaterialsRef?: string | null;
    deliverableQuantities?: DeliverableQuantity[] | null;
    deliverablePricing?: DeliverablePricing | null;
    followerRanges?: FollowerRanges | null;
    fieldProvenance?: FieldProvenance | null;
    briefDeliveryMethod?: string | null;
    briefHighlight?: string | null;
    creativeConcept?: string | null;
    referenceVideos?: string | null;
    scriptSubmission?: string | null;
    adAuthorization?: string | null;
    linkInBioDuration?: string | null;
    postRetention?: string | null;
    instagramCollab?: boolean | null;
    requireApproval?: boolean | null;
    commissionMode?: string | null;
    variableCommission?: string | null;
    giftDeliveryMethod?: string | null;
    promoCode?: string | null;
    giftContactEmail?: string | null;
    requiresShippingInfo?: boolean | null;
    affiliateTrackingUrl?: string | null;
    trackingLinkMode?: string | null;
    trackingDestinationUrl?: string | null;
    trackingParameter?: string | null;
    targetUrl?: string | null;
    hiddenParamKey?: string | null;
    // PLU-136 compensation contract (CampaignDetails). Editable while DRAFT.
    campaignType?: CampaignType;
    includesGifting?: boolean;
    giftDisposition?: GiftDisposition | null;
    priceStrategy?: PriceStrategy | null;
    publicStartingFeeCents?: number | null;
    publicCommissionRate?: number | null;
    commissionDurationDays?: number | null;
    commissionConditions?: string | null;
    compensationReviewStatus?: CompensationReviewStatus;
    postAcceptanceMode?: PostAcceptanceMode;
  dailyInitialOutreachLimit?: number;
  outreachPacingMinMinutes?: number;
  outreachPacingMaxMinutes?: number;
  negotiationReplyPacingMinMinutes?: number;
  negotiationReplyPacingMaxMinutes?: number;
  /** PLU-121: change the default sender (null clears back to the default account). */
  emailAccountId?: string | null;
  },
) {
  return apiFetch<CampaignDetail>(`/api/campaigns/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/** PLU-136 (1b) / PLU-139: "Duplicate as new campaign" — POST to the existing
 *  server route, which copies scalars + CampaignDetails + BrandIdentity +
 *  CreatorRequirement + policy into a fresh DRAFT (no history) and returns it. */
export function duplicateCampaign(id: string) {
  return postJson<CampaignDetail>(`/api/campaigns/${id}/duplicate`, {});
}

export function deleteCampaign(id: string): Promise<void> {
  return apiFetch<void>(`/api/campaigns/${id}`, { method: "DELETE" });
}

// PLU-139 (2a): BrandIdentity + CreatorRequirement sections. Each has its own
// GET + draft-only PATCH sub-endpoint (409 once the campaign is ACTIVE). GET is a
// hook (react-query) like useCampaign; the PATCH is a plain one-shot mutation.
export function useBrandIdentity(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id, "brand-identity"],
    queryFn: () => apiFetch<BrandIdentityFields>(`/api/campaigns/${id}/brand-identity`),
    enabled: !!id,
  });
}

export function updateBrandIdentity(id: string, data: BrandIdentityInput) {
  return apiFetch<BrandIdentityFields>(`/api/campaigns/${id}/brand-identity`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function useCreatorRequirement(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id, "creator-requirement"],
    queryFn: () =>
      apiFetch<CreatorRequirementFields>(`/api/campaigns/${id}/creator-requirement`),
    enabled: !!id,
  });
}

export function updateCreatorRequirement(id: string, data: CreatorRequirementInput) {
  return apiFetch<CreatorRequirementFields>(`/api/campaigns/${id}/creator-requirement`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ---------------------------------------------------------------------------
// PLU-140 (2b): NegotiationPolicy + readiness + launch.
// ---------------------------------------------------------------------------

/** The one private policy per Draft campaign. A 404 means "no policy row yet"
 *  — a normal empty state for a fresh draft, not an error — so it resolves to
 *  an empty partial shape (same intent as useBriefExtraction's 404 handling),
 *  which the intake fills in as the brand edits and the PATCH upserts. */
export function useNegotiationPolicy(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id, "negotiation-policy"],
    queryFn: async (): Promise<Partial<NegotiationPolicyFields>> => {
      try {
        return await apiFetch<NegotiationPolicyFields>(
          `/api/campaigns/${id}/negotiation-policy`,
        );
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("404")) return {};
        throw err;
      }
    },
    enabled: !!id,
    retry: false,
  });
}

export function updateNegotiationPolicy(id: string, data: NegotiationPolicyInput) {
  return apiFetch<NegotiationPolicyFields>(`/api/campaigns/${id}/negotiation-policy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

/** Pre-launch readiness — the same blockers POST /launch would raise, shown up
 *  front on the review page. Polls nothing; refetched on demand after edits. */
export function useReadiness(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id, "readiness"],
    queryFn: () => apiFetch<CampaignReadiness>(`/api/campaigns/${id}/readiness`),
    enabled: !!id,
  });
}

/** A launch that failed a precondition. `missing` is present on a 422
 *  CompensationIncompleteError; `status` distinguishes 409 (needs confirm) from
 *  422 (incomplete) so the UI can message each precisely. */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly missing?: string[],
  ) {
    super(message);
    this.name = "LaunchError";
  }
}

/** POST /launch — the authoritative DRAFT→ACTIVE transition. On non-2xx, parse
 *  {error, missing?} and throw a LaunchError carrying status + missing. */
export async function launchCampaign(id: string): Promise<LaunchResult> {
  const res = await fetch(
    `/api/campaigns/${id}/launch`,
    withOperatorKey({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
  );
  if (!res.ok) {
    let error = `${res.status} ${res.statusText}`;
    let missing: string[] | undefined;
    try {
      const j = (await res.json()) as { error?: string; missing?: string[] };
      if (j.error) error = j.error;
      if (Array.isArray(j.missing)) missing = j.missing;
    } catch {
      /* ignore non-JSON body */
    }
    throw new LaunchError(error, res.status, missing);
  }
  return res.json() as Promise<LaunchResult>;
}

// PLU-139 (2a): brief import / candidate extraction. GET returns the latest
// stored extraction (404 when none — treated as "no candidates yet", not an
// error, like the section GETs). POST parses an already-uploaded PDF (its
// reference from uploadFile()) into a stored candidate record — evidence only,
// never auto-written to CampaignDetails.
export function useBriefExtraction(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id, "brief-extraction"],
    queryFn: () =>
      apiFetch<BriefExtractionFields>(`/api/campaigns/${id}/brief-extraction`),
    enabled: !!id,
    // A 404 (no extraction yet) is a normal empty state, not a transient error —
    // don't retry it.
    retry: false,
  });
}

export function createBriefExtraction(id: string, sourceFileReference: string) {
  return postJson<BriefExtractionFields>(`/api/campaigns/${id}/brief-extraction`, {
    sourceFileReference,
  });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: ["workflow", id],
    queryFn: () => apiFetch<WorkflowDetail>(`/api/workflows/${id}`),
    enabled: !!id,
  });
}

export function useWorkflowVersions(id: string | null) {
  return useQuery({
    queryKey: ["workflow-versions", id],
    queryFn: () => apiFetch<WorkflowVersion[]>(`/api/workflows/${id}/versions`),
    enabled: !!id,
  });
}

export function useWorkflowExecution(id: string | null) {
  return useQuery({
    queryKey: ["workflow-execution", id],
    queryFn: () => apiFetch<WorkflowExecutionSummary>(`/api/workflows/${id}/execution`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });
}

export function createWorkflowForCampaign(
  campaignId: string,
  data: { name: string; templateKey: TemplateKey },
) {
  return postJson<{ id: string; name: string; draftNodes: DraftNode[] }>(
    `/api/campaigns/${campaignId}/workflows`,
    data,
  );
}

export function saveDraft(workflowId: string, nodes: DraftNode[]) {
  return putJson<{
    id: string;
    draftNodes: DraftNode[];
    valid: boolean;
    validationErrors: string[];
    updatedAt: string;
  }>(`/api/workflows/${workflowId}/draft`, { nodes });
}

export function validateWorkflow(workflowId: string) {
  return postJson<ValidationResponse>(`/api/workflows/${workflowId}/validate`, {});
}

export function publishWorkflow(workflowId: string, notes?: string) {
  return postJson<PublishResponse>(`/api/workflows/${workflowId}/publish`, {
    notes: notes ?? null,
  });
}

// PLU-117 §4.2: AI-assisted authoring of the reusable outreach template. This is
// a SETUP-TIME helper — brand/campaign/deal context is assembled server-side, the
// client only passes an optional instruction + the current copy it's revising.
// The result populates the editable fields; it is never auto-sent.
export interface OutreachTemplateResult {
  subject: string;
  body: string;
  alternateSubjects: string[];
  flaggedPlaceholders: string[];
}

export function generateOutreachTemplate(
  workflowId: string,
  input: { instruction?: string; currentSubject?: string; currentBody?: string } = {},
): Promise<OutreachTemplateResult> {
  return postJson<OutreachTemplateResult>(
    `/api/workflows/${workflowId}/outreach/template`,
    input,
  );
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

export function useCreators() {
  return useQuery({
    queryKey: ["creators"],
    queryFn: () => apiFetch<CreatorItem[]>("/api/creators"),
  });
}

/**
 * Remove creators from the roster.
 *
 * Returns per-creator outcomes: anyone enrolled in a workflow or holding a
 * partnership is KEPT and reported in `blocked`, because deleting them would
 * mean destroying execution history and payout records. A row-level delete
 * sends an array of one.
 */
export function deleteCreators(creatorIds: string[]) {
  return postJson<CreatorDeleteResult>("/api/creators/delete", { creatorIds });
}

/** Add one creator by hand. Upserts on email, so re-adding enriches. */
export function addCreator(data: {
  email: string;
  name?: string;
  handle?: string;
  platform?: string;
}) {
  return postJson<{ creator: CreatorItem }>("/api/creators", data);
}

// ---------------------------------------------------------------------------
// Creator import batches (PLU-109)
// ---------------------------------------------------------------------------
// Two-phase: uploadImport() parses and previews but writes NO creators;
// commitImport() is what actually touches the roster.

/** The source-list dropdown. Archived batches are excluded by default. */
export function useImportBatches(includeArchived = false) {
  return useQuery({
    queryKey: ["import-batches", includeArchived],
    queryFn: () =>
      apiFetch<ImportBatch[]>(
        `/api/creators/imports${includeArchived ? "?includeArchived=true" : ""}`,
      ),
  });
}

/** Members of one batch, joined to their creators. Skipped when no batch is picked. */
export function useImportBatchDetail(batchId: string | null) {
  return useQuery({
    queryKey: ["import-batch", batchId],
    queryFn: () => apiFetch<ImportBatchDetail>(`/api/creators/imports/${batchId}`),
    enabled: !!batchId,
  });
}

/**
 * Upload a CSV/TSV. Returns a DRAFT batch plus a preview of what committing
 * WOULD do — the roster is untouched until commitImport().
 */
export function uploadImport(file: File, label?: string): Promise<ImportDraftResponse> {
  const form = new FormData();
  form.append("file", file);
  if (label) form.append("label", label);
  // Note: do NOT set Content-Type — the browser sets the multipart boundary.
  return apiFetch<ImportDraftResponse>("/api/creators/imports", {
    method: "POST",
    body: form,
  });
}

/** Commit a draft: upsert its creators and finalize the audit counts. */
export function commitImport(batchId: string) {
  return postJson<ImportCommitResponse>(`/api/creators/imports/${batchId}/commit`, {});
}

/**
 * Delete a list: the batch, its import rows, and the stored file.
 *
 * Used both to discard an unconfirmed draft and to remove a committed list.
 * It NEVER removes creators — the people a list introduced stay in the roster.
 */
export function deleteImportBatch(batchId: string) {
  return apiFetch<ImportBatchDeleteResult>(`/api/creators/imports/${batchId}`, {
    method: "DELETE",
  });
}

/** Rename a batch, or archive it (hides from the picker; audit is retained). */
export function updateImportBatch(
  batchId: string,
  patch: { label?: string; archived?: boolean },
) {
  return apiFetch<{ batch: ImportBatch }>(`/api/creators/imports/${batchId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** URL for re-downloading the original upload. */
export function importFileUrl(batchId: string): string {
  return `/api/creators/imports/${batchId}/file`;
}

// ---------------------------------------------------------------------------
// Uploads (Phase 16 — Content Brief PDF)
// ---------------------------------------------------------------------------

export interface UploadResponse {
  /** The stored reference to persist in node config. */
  reference: string;
  /** The original filename, for display + the email attachment. */
  originalName: string;
  size: number;
}

/** Upload a single PDF file. Returns the stored reference to persist in config. */
export async function uploadFile(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  // Note: do NOT set Content-Type — the browser sets the multipart boundary.
  return apiFetch<UploadResponse>("/api/uploads", { method: "POST", body: form });
}

// ---------------------------------------------------------------------------
// Enroll + Launch
// ---------------------------------------------------------------------------

export function enrollCreators(
  workflowId: string,
  creatorIds: string[],
  // PLU-70: omitted → the server applies the campaign default. Sent only when the
  // operator explicitly overrode it for this batch.
  postAcceptanceMode?: PostAcceptanceMode,
) {
  return postJson<EnrollResponse>(`/api/workflows/${workflowId}/enroll`, {
    creatorIds,
    ...(postAcceptanceMode ? { postAcceptanceMode } : {}),
  });
}

export function launchWorkflow(workflowId: string) {
  return postJson<LaunchResponse>(`/api/workflows/${workflowId}/launch`, {});
}

// ---------------------------------------------------------------------------
// Manual Queue (Phase 11)
// ---------------------------------------------------------------------------

export function useManualQueue(workflowId: string | null) {
  return useQuery({
    queryKey: ["manual-queue", workflowId],
    queryFn: () =>
      apiFetch<ManualQueueResponse>(`/api/manual-queue/workflows/${workflowId}`),
    enabled: !!workflowId,
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });
}

export function notifyBrand(instanceId: string) {
  return postJson<NotifyResult>(`/api/manual-queue/instances/${instanceId}/notify`, {});
}

/** PLU-70: mark a deal handoff finalized — the single operator action. */
export function completeHandoff(instanceId: string) {
  return postJson<CompleteHandoffResult>(
    `/api/manual-queue/instances/${instanceId}/handoff/complete`,
    {},
  );
}

// ---------------------------------------------------------------------------
// Query invalidation helpers
// ---------------------------------------------------------------------------

export function useBuilderInvalidator(workflowId: string | null) {
  const qc = useQueryClient();
  return {
    invalidateWorkflow: () => qc.invalidateQueries({ queryKey: ["workflow", workflowId] }),
    invalidateVersions: () =>
      qc.invalidateQueries({ queryKey: ["workflow-versions", workflowId] }),
    invalidateExecution: () =>
      qc.invalidateQueries({ queryKey: ["workflow-execution", workflowId] }),
    invalidateManualQueue: () =>
      qc.invalidateQueries({ queryKey: ["manual-queue", workflowId] }),
    invalidateCampaigns: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
    invalidateCreators: () => qc.invalidateQueries({ queryKey: ["creators"] }),
    invalidateImportBatches: () =>
      qc.invalidateQueries({ queryKey: ["import-batches"] }),
    invalidateImportBatch: (batchId: string) =>
      qc.invalidateQueries({ queryKey: ["import-batch", batchId] }),
  };
}
