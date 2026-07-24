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
}) {
  return postJson<{ id: string; name: string }>("/api/campaigns", data);
}

export function updateCampaign(
  id: string,
  data: {
    notifyEmail?: string | null;
    objective?: string | null;
    notes?: string | null;
    brandDescription?: string | null;
    deliverables?: string | null;
    timeline?: string | null;
    rewardDescription?: string | null;
    shipsPhysicalProduct?: boolean;
    postAcceptanceMode?: PostAcceptanceMode;
  },
) {
  return apiFetch<{ id: string; notifyEmail: string | null }>(`/api/campaigns/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteCampaign(id: string): Promise<void> {
  return apiFetch<void>(`/api/campaigns/${id}`, { method: "DELETE" });
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
