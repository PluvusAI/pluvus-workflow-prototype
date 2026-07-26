// ---------------------------------------------------------------------------
// Observability routes (Phase 9, Part 8)
// ---------------------------------------------------------------------------
// Read-only endpoints powering the workflow dashboard. All responses are DTOs
// (see observability/dto.ts) — no raw Prisma objects are serialized.
//
//   GET /observability/workflow        node/state counts + summary
//   GET /observability/llm             LLM token/latency/cost usage (HARD-O1)
//   GET /observability/instances       filter + search + paginate
//   GET /observability/instances/:id   detail (messages, events, decisions)
//   GET /observability/timeline/:id    chronological event stream
//   GET /observability/logs/:id        transition trace (source/worker/job)
//   GET /observability/meta            static state metadata for the canvas

import { Router } from "express";
import type { InstanceState } from "../db/schema.js";
import {
  getWorkflowSummary,
  listInstances,
  listWorkflowOptions,
  getInstanceDetail,
  getTimeline,
  getLogs,
  getLlmUsage,
  getAlertsReport,
  resolveInstanceObligation,
  isManualResolveStatus,
  MANUAL_RESOLVE_STATUSES,
  correctInstanceMemory,
  createInstanceMemory,
  isCorrectMemoryAction,
  CORRECT_MEMORY_ACTIONS,
} from "../observability/repository.js";
import { WORKFLOW_STATE_ORDER, TERMINAL_STATES, WAITING_STATES } from "../observability/dto.js";
import type { MemoryFactKey } from "../db/schema.js";
import {
  MEMORY_FACT_KEYS,
  isSingletonMemoryKey,
  isNumericMemoryKey,
  normalizeMemoryValue,
  memoryDedupKey,
} from "../engine/executors/creatorMemory.js";

const router = Router();

const VALID_STATES = new Set<string>(WORKFLOW_STATE_ORDER);

function parseState(raw: unknown): InstanceState | undefined {
  if (typeof raw === "string" && VALID_STATES.has(raw)) return raw as InstanceState;
  return undefined;
}

// ---------------------------------------------------------------------------
// GET /observability/meta
// ---------------------------------------------------------------------------
// Static metadata the canvas needs to lay itself out without hardcoding the
// state list on the frontend.

router.get("/meta", (_req, res) => {
  res.json({
    states: WORKFLOW_STATE_ORDER,
    terminalStates: TERMINAL_STATES,
    waitingStates: WAITING_STATES,
  });
});

// ---------------------------------------------------------------------------
// GET /observability/workflow
// ---------------------------------------------------------------------------

router.get("/workflow", async (req, res) => {
  try {
    // W-6: optional ?workflowVersionId scopes the summary to one campaign's
    // version. Omitted → newest published version (unchanged default).
    const versionId =
      typeof req.query["workflowVersionId"] === "string"
        ? req.query["workflowVersionId"]
        : undefined;
    const summary = await getWorkflowSummary(versionId);
    res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "workflow_summary_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/workflows  (W-6 workflow selector)
// ---------------------------------------------------------------------------
// One row per workflow that has a published version — id, name, latest version,
// and live instance count — so the dashboard can offer a scope picker instead of
// always showing the single newest-published workflow.

router.get("/workflows", async (_req, res) => {
  try {
    res.json({ workflows: await listWorkflowOptions() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "workflow_options_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/metrics  (HARD-S1)
// ---------------------------------------------------------------------------
// Worker-fleet metrics — queue depth per BullMQ queue + stuck-state counts — the
// scaffolding surface a monitoring backend / autoscaler scrapes. The same numbers
// are also logged on the scheduler cadence (workerMetrics.logWorkerMetrics). The
// load-test-to-1,000 acceptance criterion is the infra behind this, not the route.

router.get("/metrics", async (_req, res) => {
  try {
    const { collectWorkerMetrics } = await import("../workers/workerMetrics.js");
    res.json(await collectWorkerMetrics());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "worker_metrics_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/alerts  (P9)
// ---------------------------------------------------------------------------
// Single-poll operator alert roll-up: queue failures, MANUAL_REVIEW parks,
// FAILED brand/escalation emails, LLM daily-spend breach, and stuck instances,
// each judged to a severity. `status` is "ok" when nothing fires, else the most
// severe firing level. Point an uptime monitor / cron `curl` at this and page on
// status != "ok". Gated with the rest of /observability (X-Operator-Key).

router.get("/alerts", async (_req, res) => {
  try {
    res.json(await getAlertsReport());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "alerts_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/llm  (HARD-O1)
// ---------------------------------------------------------------------------
// Durable LLM token/latency/cost telemetry aggregated from the LlmCall table:
// all-time + trailing-24h totals, per-role and per-model breakdowns, and the
// most recent calls. Per-instance usage rides on the instance detail instead.

router.get("/llm", async (_req, res) => {
  try {
    res.json(await getLlmUsage());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "llm_usage_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/instances?state=&search=&page=&pageSize=
// ---------------------------------------------------------------------------

router.get("/instances", async (req, res) => {
  try {
    const state = parseState(req.query["state"]);
    if (req.query["state"] && !state) {
      res.status(400).json({ error: "invalid_state", value: req.query["state"] });
      return;
    }
    const search = typeof req.query["search"] === "string" ? req.query["search"] : undefined;
    const page = req.query["page"] ? Number(req.query["page"]) : undefined;
    const pageSize = req.query["pageSize"] ? Number(req.query["pageSize"]) : undefined;
    const workflowVersionId =
      typeof req.query["workflowVersionId"] === "string"
        ? req.query["workflowVersionId"]
        : undefined;

    const result = await listInstances({
      ...(state ? { state } : {}),
      ...(search ? { search } : {}),
      ...(page && !Number.isNaN(page) ? { page } : {}),
      ...(pageSize && !Number.isNaN(pageSize) ? { pageSize } : {}),
      ...(workflowVersionId ? { workflowVersionId } : {}),
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "instances_list_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/instances/:id
// ---------------------------------------------------------------------------

router.get("/instances/:id", async (req, res) => {
  try {
    const detail = await getInstanceDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "instance_not_found", id: req.params.id });
      return;
    }
    res.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "instance_detail_failed", message });
  }
});

// ---------------------------------------------------------------------------
// POST /observability/instances/:id/obligations/:obligationId/resolve  (PLU-111)
// ---------------------------------------------------------------------------
// Operator manual resolution (§4.9). Operator-gated with the rest of the router
// (X-Operator-Key applied at mount). Sets the obligation to a terminal status
// with resolutionSource="operator". Idempotent — resolving an already-terminal
// row returns 200 with the current row. Body: { status, resolution? } where
// status ∈ {ANSWERED, COMPLETED, CANCELED, NO_LONGER_RELEVANT}.

router.post("/instances/:id/obligations/:obligationId/resolve", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isManualResolveStatus(body["status"])) {
      res.status(400).json({
        error: "invalid_status",
        allowed: MANUAL_RESOLVE_STATUSES,
        value: body["status"] ?? null,
      });
      return;
    }
    const resolution =
      typeof body["resolution"] === "string" ? body["resolution"] : undefined;

    const outcome = await resolveInstanceObligation(
      req.params.id,
      req.params.obligationId,
      { status: body["status"], ...(resolution !== undefined ? { resolution } : {}) },
    );
    if (!outcome.ok) {
      res.status(404).json({ error: outcome.reason, id: req.params.obligationId });
      return;
    }
    res.json({ obligation: outcome.obligation });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "obligation_resolve_failed", message });
  }
});

// ---------------------------------------------------------------------------
// POST /observability/instances/:id/memory/:factId/correct  (PLU-113, §4.10)
// ---------------------------------------------------------------------------
// Operator-gated by the /observability mount (requireOperatorKey). Body:
// { action, value?, note? } where action ∈ {EDIT, RESOLVE_CONFLICT, REMOVE}.
// The server recomputes normalizedValue from the new value using the same
// normalizeMemoryValue the extractor uses, so the live-unique dedup stays correct.

router.post("/instances/:id/memory/:factId/correct", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isCorrectMemoryAction(body["action"])) {
      res.status(400).json({
        error: "invalid_action",
        allowed: CORRECT_MEMORY_ACTIONS,
        value: body["action"] ?? null,
      });
      return;
    }
    const value = typeof body["value"] === "string" ? body["value"] : undefined;
    const note = typeof body["note"] === "string" ? body["note"] : undefined;
    // For EDIT with a new value, recompute the dedup key + numeric mirror.
    const normalizedValue =
      value !== undefined ? normalizeMemoryValue(value) : undefined;
    const valueNumber =
      value !== undefined && /^[$\s]*[\d.,]+$/.test(value.trim())
        ? Number(value.replace(/[^0-9.]/g, "")) || null
        : undefined;

    const outcome = await correctInstanceMemory(req.params.id, req.params.factId, {
      action: body["action"],
      ...(value !== undefined ? { value } : {}),
      ...(normalizedValue !== undefined ? { normalizedValue } : {}),
      ...(valueNumber !== undefined ? { valueNumber } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!outcome.ok) {
      res.status(404).json({ error: outcome.reason, id: req.params.factId });
      return;
    }
    res.json({ memory: outcome.memory });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "memory_correct_failed", message });
  }
});

// ---------------------------------------------------------------------------
// POST /observability/instances/:id/memory  (PLU-113, §4.10 / O7)
// ---------------------------------------------------------------------------
// Operator-authored fact create. Body: { key, value, category?, note? }. The
// server derives singleton/numeric shape + normalizedValue from the key/value.

router.post("/instances/:id/memory", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = body["key"];
    if (
      typeof key !== "string" ||
      !MEMORY_FACT_KEYS.includes(key as MemoryFactKey)
    ) {
      res.status(400).json({
        error: "invalid_key",
        allowed: MEMORY_FACT_KEYS,
        value: key ?? null,
      });
      return;
    }
    const value = typeof body["value"] === "string" ? body["value"].trim() : "";
    if (!value) {
      res.status(400).json({ error: "missing_value" });
      return;
    }
    const factKey = key as MemoryFactKey;
    const category =
      typeof body["category"] === "string" ? body["category"] : undefined;
    const note = typeof body["note"] === "string" ? body["note"] : undefined;
    const singleton = isSingletonMemoryKey(factKey);
    const normalizedValue = memoryDedupKey(factKey, normalizeMemoryValue(value));
    const valueNumber = isNumericMemoryKey(factKey)
      ? Number(value.replace(/[^0-9.]/g, "")) || null
      : null;

    const outcome = await createInstanceMemory(req.params.id, {
      key: factKey,
      singleton,
      value,
      valueNumber,
      normalizedValue,
      ...(category !== undefined ? { category } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!outcome.ok) {
      res.status(404).json({ error: outcome.reason, id: req.params.id });
      return;
    }
    res.status(201).json({ memory: outcome.memory });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "memory_create_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/timeline/:id
// ---------------------------------------------------------------------------

router.get("/timeline/:id", async (req, res) => {
  try {
    const timeline = await getTimeline(req.params.id);
    if (!timeline) {
      res.status(404).json({ error: "instance_not_found", id: req.params.id });
      return;
    }
    res.json(timeline);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "timeline_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/logs/:id
// ---------------------------------------------------------------------------

router.get("/logs/:id", async (req, res) => {
  try {
    const logs = await getLogs(req.params.id);
    if (!logs) {
      res.status(404).json({ error: "instance_not_found", id: req.params.id });
      return;
    }
    res.json(logs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "logs_failed", message });
  }
});

export default router;
