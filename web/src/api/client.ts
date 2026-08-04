// ---------------------------------------------------------------------------
// API client + TanStack Query hooks (Phase 9)
// ---------------------------------------------------------------------------
// All requests go through the Vite proxy: /api → http://localhost:3001.
// Polling lives here (refetchInterval) so the dashboard "feels alive" without
// any websocket plumbing — Part 2 target is a 5–10s refresh.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { withOperatorKey } from "./operatorKey";
import type {
  WorkflowSummary,
  WorkflowOptions,
  InstanceList,
  InstanceDetail,
  Timeline,
  Logs,
  InstanceState,
  LlmUsageSummary,
  ConversationObligationDTO,
  ManualResolveStatus,
  CreatorMemoryFactDTO,
} from "./types";

const BASE = "/api/observability";

// Live-refresh cadence for the canvas + queue views (Part 2: 5–10s).
export const POLL_INTERVAL_MS = 6000;

async function getJson<T>(url: string): Promise<T> {
  // P2: operator route — inject X-Operator-Key (no-op when the key is unset).
  const res = await fetch(url, withOperatorKey());
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`.trim());
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useWorkflowSummary(workflowVersionId?: string | null) {
  // W-6: optional version scope so the canvas reflects one campaign, not the
  // whole table. Omitted → server defaults to the newest published version.
  const qs = workflowVersionId ? `?workflowVersionId=${encodeURIComponent(workflowVersionId)}` : "";
  return useQuery({
    queryKey: ["workflow-summary", workflowVersionId ?? null],
    queryFn: () => getJson<WorkflowSummary>(`${BASE}/workflow${qs}`),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

/** W-6: the workflow scope picker's options (one row per published workflow). */
export function useWorkflowOptions() {
  return useQuery({
    queryKey: ["workflow-options"],
    queryFn: () => getJson<WorkflowOptions>(`${BASE}/workflows`),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useLlmUsage() {
  return useQuery({
    queryKey: ["llm-usage"],
    queryFn: () => getJson<LlmUsageSummary>(`${BASE}/llm`),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useInstances(params: {
  state?: InstanceState | undefined;
  search?: string | undefined;
  workflowVersionId?: string | null | undefined;
}) {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.search) qs.set("search", params.search);
  // W-6: keep the drilldown scoped to the same version as the summary.
  if (params.workflowVersionId) qs.set("workflowVersionId", params.workflowVersionId);
  qs.set("pageSize", "200");
  const query = qs.toString();
  return useQuery({
    queryKey: [
      "instances",
      params.state ?? null,
      params.search ?? null,
      params.workflowVersionId ?? null,
    ],
    queryFn: () => getJson<InstanceList>(`${BASE}/instances?${query}`),
    // Poll the drilldown too, so creators appear/leave a node live.
    refetchInterval: POLL_INTERVAL_MS,
    // Keep showing the previous list while refetching to avoid flicker.
    placeholderData: (prev) => prev,
  });
}

export function useInstanceDetail(id: string | null) {
  return useQuery({
    queryKey: ["instance", id],
    queryFn: () => getJson<InstanceDetail>(`${BASE}/instances/${id}`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useTimeline(id: string | null) {
  return useQuery({
    queryKey: ["timeline", id],
    queryFn: () => getJson<Timeline>(`${BASE}/timeline/${id}`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useLogs(id: string | null) {
  return useQuery({
    queryKey: ["logs", id],
    queryFn: () => getJson<Logs>(`${BASE}/logs/${id}`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

// ---------------------------------------------------------------------------
// PLU-111 — operator manual resolution of a conversation obligation
// ---------------------------------------------------------------------------

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(
    url,
    withOperatorKey({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`.trim());
  }
  return (await res.json()) as T;
}

/** Resolve one obligation to a terminal status (operator action). Invalidates the
 *  instance detail so the inspector reflects the new status immediately. */
export function useResolveObligation(instanceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      obligationId: string;
      status: ManualResolveStatus;
      resolution?: string;
    }) =>
      postJson<{ obligation: ConversationObligationDTO }>(
        `${BASE}/instances/${instanceId}/obligations/${vars.obligationId}/resolve`,
        {
          status: vars.status,
          ...(vars.resolution ? { resolution: vars.resolution } : {}),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    },
  });
}

// ---------------------------------------------------------------------------
// PLU-113 — operator creator-memory mutations
// ---------------------------------------------------------------------------

/** Correct a memory fact's value (source=operator). Invalidates the instance. */
export function useCorrectMemory(instanceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { memoryId: string; value: string; note?: string }) =>
      postJson<{ memory: CreatorMemoryFactDTO }>(
        `${BASE}/instances/${instanceId}/memory/${vars.memoryId}/correct`,
        { value: vars.value, ...(vars.note ? { note: vars.note } : {}) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    },
  });
}

/** Soft-remove a memory fact (source=operator). */
export function useRemoveMemory(instanceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { memoryId: string; note?: string }) =>
      postJson<{ memory: CreatorMemoryFactDTO }>(
        `${BASE}/instances/${instanceId}/memory/${vars.memoryId}/remove`,
        { ...(vars.note ? { note: vars.note } : {}) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    },
  });
}

/** Create a memory fact by hand (source=operator). */
export function useCreateMemory(instanceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; value: string; category?: string; note?: string }) =>
      postJson<{ memory: CreatorMemoryFactDTO }>(
        `${BASE}/instances/${instanceId}/memory`,
        vars,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    },
  });
}

/** Dismiss a pending failed memory write. */
export function useDismissFailedMemory(instanceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { writeId: string }) =>
      postJson<{ ok: true }>(
        `${BASE}/instances/${instanceId}/failed-memory/${vars.writeId}/dismiss`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["instance", instanceId] });
    },
  });
}
