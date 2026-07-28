// ---------------------------------------------------------------------------
// Observability repository (Phase 9, Part 8)
// ---------------------------------------------------------------------------
// Read-only queries + DTO mappers for the observability dashboard. This is the
// boundary that guarantees raw DB rows never reach the client.
//
// Phase 9 is read-only: nothing here mutates execution state. The only reads
// that touch the engine's tables are SELECTs.

import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  brandNotifications,
  conversationObligations as conversationObligationsTable,
  creators,
  events as eventsTable,
  executionInstances,
  llmCalls as llmCallsTable,
  messages as messagesTable,
  workflows,
  workflowVersions,
  type ConversationObligation,
  type Event,
  type ExecutionInstance,
  type InstanceState,
  type JsonValue,
  type LlmCall,
  type LlmCallRole,
  type Message,
} from "../db/schema.js";
import {
  isTerminalObligationStatus,
  resolveObligationManual,
  listObligationsByInstance,
  type ManualResolveStatus,
} from "../db/conversationObligations.js";
import { collectWorkerMetrics } from "../workers/workerMetrics.js";
import { buildAlertsReport, type AlertInputs, type AlertsReportDTO } from "./alerts.js";
import {
  WORKFLOW_STATE_ORDER,
  TERMINAL_STATES,
  WAITING_STATES,
  type WorkflowSummaryDTO,
  type WorkflowNodeSummaryDTO,
  type InstanceListDTO,
  type InstanceListItemDTO,
  type InstanceDetailDTO,
  type MessageDTO,
  type EventDTO,
  type AgentDecisionDTO,
  type TimelineDTO,
  type TimelineEntryDTO,
  type LogsDTO,
  type LogEntryDTO,
  type LlmCallDTO,
  type LlmUsageTotalsDTO,
  type LlmUsageBreakdownEntryDTO,
  type LlmUsageSummaryDTO,
  type LlmSpendGuardDTO,
  type ConversationObligationDTO,
  type KnowledgeDTO,
  type KnowledgeConflictDTO,
  type BriefAvailabilityDTO,
  type ContextDTO,
} from "./dto.js";

// An instance in a waiting state is "stuck" if its dueAt passed more than this
// long ago — the scheduler should have advanced it by now.
const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

const isTerminalState = (s: InstanceState): boolean => TERMINAL_STATES.includes(s);
const isWaitingState = (s: InstanceState): boolean => WAITING_STATES.includes(s);

function asRecord(json: JsonValue | null | undefined): Record<string, unknown> | null {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return null;
}

function payloadString(p: Record<string, unknown> | null, key: string): string | null {
  const v = p?.[key];
  return typeof v === "string" ? v : null;
}

// EASY-S2: mask the guard-leak band value in an event payload before it is served
// by the timeline. New rows are already masked at write time (executors use
// maskGuardHits), but PRE-FIX rows carry the raw value (e.g. "ceiling:500"), and
// this is the read-path backstop that redacts them too — so the internal band
// value never leaves the DB raw for anyone hitting the observability API. Returns
// a shallow copy; the stored row is unchanged (append-only audit log).
function maskPayloadLeaks(p: Record<string, unknown>): Record<string, unknown> {
  const leaks = p["leaks"];
  if (!Array.isArray(leaks)) return p;
  const masked = leaks.map((l) =>
    // Shape is "kind:value"; keep the kind, redact everything after the first ":".
    typeof l === "string" ? l.replace(/^([^:]*:).*/, "$1<redacted>") : l,
  );
  return { ...p, leaks: masked };
}

function payloadNumber(p: Record<string, unknown> | null, key: string): number | null {
  const v = p?.[key];
  return typeof v === "number" ? v : null;
}

function isStuck(inst: Pick<ExecutionInstance, "currentState" | "dueAt">, now: number): boolean {
  if (!isWaitingState(inst.currentState)) return false;
  if (!inst.dueAt) return false;
  return now - inst.dueAt.getTime() > STUCK_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Workflow summary
// ---------------------------------------------------------------------------

/**
 * Per-state counts + derived metrics for the canvas.
 *
 * W-6: SCOPED to ONE workflow version and computed in SQL.
 *
 *   - Correctness: previously this labelled the dashboard with the newest
 *     published version but aggregated EVERY instance in the table with no
 *     version filter, so the moment a second campaign launched the counts under
 *     one workflow's name silently included the other's creators. Now every
 *     count, waiting/stuck flag, and time-in-state is filtered to the target
 *     version's instances.
 *
 *   - Scale: previously it loaded every instance row AND every STATE_TRANSITION
 *     event into memory on every 6 s dashboard poll — O(fleet) work per poll,
 *     growing without bound. Now the per-state counts come from a single
 *     GROUP BY, and avg-time-in-state from one grouped aggregate join; the DB
 *     does the reduction and only ~16 rows (one per state) come back.
 *
 * `workflowVersionId` selects which version to summarize; when omitted it
 * defaults to the newest published version (the prior behavior for the label),
 * so a single-workflow deployment and the existing frontend call are unchanged.
 */
export async function getWorkflowSummary(
  workflowVersionId?: string,
): Promise<WorkflowSummaryDTO> {
  const now = Date.now();
  const nowDate = new Date(now);

  // Resolve the version to summarize: an explicit id, else the newest published.
  const versionRows = workflowVersionId
    ? await db
        .select({ version: workflowVersions, workflow: workflows })
        .from(workflowVersions)
        .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
        .where(eq(workflowVersions.id, workflowVersionId))
        .limit(1)
    : await db
        .select({ version: workflowVersions, workflow: workflows })
        .from(workflowVersions)
        .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
  const version = versionRows[0] ?? null;

  // No resolvable version → empty (but well-formed) summary. Every state shows 0.
  if (!version) {
    return {
      workflow: null,
      totalInstances: 0,
      nodes: emptyNodes(),
      generatedAt: nowDate.toISOString(),
    };
  }

  const versionId = version.version.id;
  const scoped = eq(executionInstances.workflowVersionId, versionId);

  // ── Per-state counts, in SQL, scoped to this version ─────────────────────
  // One GROUP BY returns count + stuck-count per state. "stuck" = a waiting
  // state whose dueAt lapsed more than STUCK_THRESHOLD_MS ago (same predicate
  // isStuck() used, now expressed in SQL so no rows are materialized).
  const staleBefore = new Date(now - STUCK_THRESHOLD_MS);
  const countRows = await db
    .select({
      state: executionInstances.currentState,
      count: count(),
      stuck: sql<number>`count(*) filter (where ${inArray(
        executionInstances.currentState,
        WAITING_STATES,
      )} and ${executionInstances.dueAt} is not null and ${executionInstances.dueAt} < ${staleBefore})`.mapWith(
        Number,
      ),
    })
    .from(executionInstances)
    .where(scoped)
    .groupBy(executionInstances.currentState);

  // ── Avg time-in-state, in SQL, scoped to this version ────────────────────
  // Two levels — nesting max() inside avg() is illegal in SQL, so:
  //   inner: per instance, entered-at = latest STATE_TRANSITION whose payload
  //          `to` equals currentState (max), falling back to enrolledAt for
  //          instances that never transitioned (still ENROLLED, etc.).
  //   outer: average (now - entered-at) grouped by state → one row per state.
  const perInstance = db
    .select({
      state: executionInstances.currentState,
      enteredAt:
        sql<Date>`coalesce(max(${eventsTable.occurredAt}), ${executionInstances.enrolledAt})`.as(
          "enteredAt",
        ),
    })
    .from(executionInstances)
    .leftJoin(
      eventsTable,
      and(
        eq(eventsTable.instanceId, executionInstances.id),
        eq(eventsTable.type, "STATE_TRANSITION"),
        sql`${eventsTable.payload} ->> 'to' = ${executionInstances.currentState}::text`,
      ),
    )
    .where(scoped)
    .groupBy(executionInstances.currentState, executionInstances.id, executionInstances.enrolledAt)
    .as("per_instance");

  const durationRows = await db
    .select({
      state: perInstance.state,
      avgSeconds: sql<number | null>`avg(extract(epoch from (${nowDate} - ${perInstance.enteredAt})))`,
    })
    .from(perInstance)
    .groupBy(perInstance.state);

  const avgByState = new Map<InstanceState, number>();
  for (const r of durationRows) {
    if (r.avgSeconds !== null) avgByState.set(r.state, Number(r.avgSeconds));
  }

  const countByState = new Map<InstanceState, { count: number; stuck: number }>();
  let total = 0;
  for (const r of countRows) {
    countByState.set(r.state, { count: r.count, stuck: r.stuck });
    total += r.count;
  }

  const nodes: WorkflowNodeSummaryDTO[] = WORKFLOW_STATE_ORDER.map((state) => {
    const c = countByState.get(state) ?? { count: 0, stuck: 0 };
    const terminal = isTerminalState(state);
    const waiting = isWaitingState(state) ? c.count : 0;
    const avg = avgByState.get(state);
    return {
      state,
      count: c.count,
      terminal,
      active: terminal ? 0 : c.count,
      waiting,
      stuck: c.stuck,
      avgTimeInStateSeconds: avg !== undefined ? Math.round(avg) : null,
    };
  });

  return {
    workflow: {
      id: version.workflow.id,
      name: version.workflow.name,
      version: version.version.version,
      versionId: version.version.id,
    },
    totalInstances: total,
    nodes,
    generatedAt: nowDate.toISOString(),
  };
}

/** All states at zero — the shape returned when there's no version to summarize. */
function emptyNodes(): WorkflowNodeSummaryDTO[] {
  return WORKFLOW_STATE_ORDER.map((state) => ({
    state,
    count: 0,
    terminal: isTerminalState(state),
    active: 0,
    waiting: 0,
    stuck: 0,
    avgTimeInStateSeconds: null,
  }));
}

// ---------------------------------------------------------------------------
// Workflow selector (W-6)
// ---------------------------------------------------------------------------
// The list backing a "which campaign am I looking at?" picker. One row per
// workflow that has at least one published version, carrying its latest version
// + a live instance count — so operators can switch the summary/drilldown scope
// instead of always seeing the newest-published workflow. Computed in SQL.

export interface WorkflowOptionDTO {
  workflowId: string;
  workflowName: string;
  latestVersionId: string;
  latestVersion: number;
  instanceCount: number;
}

export async function listWorkflowOptions(): Promise<WorkflowOptionDTO[]> {
  // Latest version per workflow: the max(version) row. Done with a grouped
  // subquery so we return exactly one version per workflow.
  const rows = await db
    .select({
      workflowId: workflows.id,
      workflowName: workflows.name,
      versionId: workflowVersions.id,
      version: workflowVersions.version,
      instanceCount: count(executionInstances.id),
    })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .leftJoin(
      executionInstances,
      eq(executionInstances.workflowVersionId, workflowVersions.id),
    )
    .groupBy(workflows.id, workflows.name, workflowVersions.id, workflowVersions.version)
    .orderBy(desc(workflowVersions.version));

  // Keep only the newest version per workflow (rows are version-desc ordered).
  const seen = new Set<string>();
  const out: WorkflowOptionDTO[] = [];
  for (const r of rows) {
    if (seen.has(r.workflowId)) continue;
    seen.add(r.workflowId);
    out.push({
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      latestVersionId: r.versionId,
      latestVersion: r.version,
      instanceCount: r.instanceCount,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instance list (filter / search / paginate)
// ---------------------------------------------------------------------------

export interface InstanceListParams {
  state?: InstanceState;
  search?: string;
  page?: number;
  pageSize?: number;
  // W-6: scope the list to one workflow version so the drilldown matches the
  // (now version-scoped) summary. Omitted → all versions (backward compatible).
  workflowVersionId?: string;
}

/** Escape LIKE wildcards so a search for "50%" doesn't match everything
 *  (Prisma's `contains` escaped these too). */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export async function listInstances(params: InstanceListParams): Promise<InstanceListDTO> {
  const now = Date.now();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, Math.min(params.pageSize ?? 50, 200));

  const conditions: SQL[] = [];
  if (params.state) {
    conditions.push(eq(executionInstances.currentState, params.state));
  }
  if (params.workflowVersionId) {
    conditions.push(eq(executionInstances.workflowVersionId, params.workflowVersionId));
  }
  if (params.search && params.search.trim()) {
    const pattern = likeContains(params.search.trim());
    conditions.push(
      or(
        ilike(creators.name, pattern),
        ilike(creators.email, pattern),
        ilike(creators.handle, pattern),
      )!,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRows, rows] = await Promise.all([
    db
      .select({ total: count() })
      .from(executionInstances)
      .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
      .where(where),
    db
      .select({ instance: executionInstances, creator: creators })
      .from(executionInstances)
      .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
      .where(where)
      .orderBy(desc(executionInstances.updatedAt))
      .offset((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  const total = totalRows[0]?.total ?? 0;

  // Last event per listed instance (Prisma's include events take-1), resolved
  // in one query and reduced newest-first in memory.
  const ids = rows.map((r) => r.instance.id);
  const lastEventByInstance = new Map<string, Event>();
  if (ids.length > 0) {
    const evRows = await db
      .select()
      .from(eventsTable)
      .where(inArray(eventsTable.instanceId, ids))
      .orderBy(desc(eventsTable.occurredAt));
    for (const ev of evRows) {
      if (!lastEventByInstance.has(ev.instanceId)) {
        lastEventByInstance.set(ev.instanceId, ev);
      }
    }
  }

  const items: InstanceListItemDTO[] = rows.map(({ instance: r, creator }) => {
    const lastEvent = lastEventByInstance.get(r.id) ?? null;
    return {
      instanceId: r.id,
      creatorId: r.creatorId,
      creatorName: creator.name,
      creatorEmail: creator.email,
      creatorHandle: creator.handle,
      platform: creator.platform,
      state: r.currentState,
      currentNodeId: r.currentNodeId,
      negotiationRound: r.negotiationRound,
      followUpCount: r.followUpCount,
      dueAt: r.dueAt ? r.dueAt.toISOString() : null,
      enrolledAt: r.enrolledAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      waitingForSeconds: Math.round((now - r.updatedAt.getTime()) / 1000),
      stuck: isStuck(r, now),
      lastEventAt: lastEvent ? lastEvent.occurredAt.toISOString() : null,
      lastEventType: lastEvent ? lastEvent.type : null,
    };
  });

  return { items, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// Instance detail
// ---------------------------------------------------------------------------

function mapMessage(m: Message, round: number | null): MessageDTO {
  return {
    id: m.id,
    direction: m.direction,
    subject: m.subject,
    body: m.body,
    threadId: m.threadId,
    replyIntent: m.replyIntent,
    classifyConfidence: m.classifyConfidence,
    negotiationRound: round,
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    receivedAt: m.receivedAt ? m.receivedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

function mapEvent(e: Event): EventDTO {
  const payload = asRecord(e.payload);
  return {
    id: e.id,
    type: e.type,
    nodeId: e.nodeId,
    payload,
    occurredAt: e.occurredAt.toISOString(),
    source: payloadString(payload, "source"),
  };
}

/** PLU-111: map a ConversationObligation row to its inspector DTO. */
function mapObligation(o: ConversationObligation): ConversationObligationDTO {
  return {
    id: o.id,
    type: o.type,
    status: o.status,
    open: !isTerminalObligationStatus(o.status),
    originalText: o.originalText,
    category: o.category,
    resolution: o.resolution,
    resolutionSource: o.resolutionSource,
    sourceMessageId: o.sourceMessageId,
    resolutionMessageId: o.resolutionMessageId,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    resolvedAt: o.resolvedAt ? o.resolvedAt.toISOString() : null,
  };
}

/** Extract agent (AI) decisions from the event log for the inspector. */
function extractAgentDecisions(events: Event[]): AgentDecisionDTO[] {
  const out: AgentDecisionDTO[] = [];
  for (const e of events) {
    const p = asRecord(e.payload);
    if (e.type === "REPLY_CLASSIFIED" || e.type === "MANUAL_REVIEW_FLAGGED") {
      out.push({
        kind: "classification",
        occurredAt: e.occurredAt.toISOString(),
        decision: payloadString(p, "intent"),
        confidence: payloadNumber(p, "confidence"),
        round: null,
        reasoning: payloadString(p, "reason"),
        messageId: payloadString(p, "messageId"),
      });
    } else if (e.type === "NEGOTIATION_TURN") {
      out.push({
        kind: "negotiation",
        occurredAt: e.occurredAt.toISOString(),
        decision: payloadString(p, "outcome"),
        confidence: null,
        round: payloadNumber(p, "round"),
        reasoning: payloadString(p, "reason") ?? payloadString(p, "message"),
        messageId: null,
      });
    }
  }
  return out;
}

// PLU-82 §4.6: assemble the knowledge observability block from the EXISTING event
// log (no new EventType/table, invariant #10):
//   - briefAvailability: LATEST across turns (recovery already reflected here).
//   - conflicts: deduped by field+reason, but each carries an active/cleared STATUS
//     (review §6, Calvin) so a conflict that a LATER re-resolution dropped reads as
//     "cleared", not as a live failure. A conflict is ACTIVE iff it was still
//     present in the most recent turn whose brief was re-resolved (the latest
//     "knowledge round"); one seen only in earlier rounds is "cleared".
//   - resolvedSources: on the post-acceptance executors' event payloads
//     (DEAL_HANDOFF_REQUESTED / REWARD_SETUP_SENT / PAYMENT_INFO_SENT). Latest wins.
// Returns undefined when the log carries nothing knowledge-related, so an older
// instance renders an empty panel rather than a misleading empty object.
// Exported for the mapper unit test (event-log → DTO shape).
export function mapKnowledge(events: Event[]): KnowledgeDTO | undefined {
  let briefAvailability: BriefAvailabilityDTO | null = null;
  const conflicts: KnowledgeConflictDTO[] = [];
  const byKey = new Map<string, KnowledgeConflictDTO>();
  let resolvedSources: Record<string, string | null> = {};
  let sawAnything = false;

  // review §6: the round of the most recent turn that RE-RESOLVED the brief (i.e.
  // carried a `knowledge` block OR a material-conflict escalation). Conflicts whose
  // lastRound equals this are still live; earlier-only ones were corrected. Tracked
  // as the numeric max so an out-of-order/round-null event can't mis-rank it.
  let latestKnowledgeRound: number | null = null;
  const noteKnowledgeRound = (round: number | null): void => {
    if (round === null) return;
    if (latestKnowledgeRound === null || round > latestKnowledgeRound) {
      latestKnowledgeRound = round;
    }
  };

  for (const e of events) {
    const p = asRecord(e.payload);
    if (!p) continue;

    // Harvest conflict rows from a raw array. First sighting creates the row
    // (stamping firstRound as `round`); a later sighting bumps lastRound so the
    // active/cleared decision below can tell a still-present conflict from a
    // historical one. Shared by the folded observability record
    // (NEGOTIATION_TURN.knowledge.conflicts) and the material-conflict escalation
    // payload (top-level NEGOTIATION_TURN.conflicts) so BOTH surface in the panel.
    const harvestConflicts = (raw: unknown, round: number | null): void => {
      if (!Array.isArray(raw)) return;
      for (const c of raw) {
        const cr = asRecord(c as JsonValue);
        if (!cr) continue;
        const field = payloadString(cr, "campaignField") ?? payloadString(cr, "section");
        const reason = payloadString(cr, "reason");
        if (!field) continue;
        const key = `${field}::${reason}`;
        const existing = byKey.get(key);
        if (existing) {
          // Same conflict seen again on a later turn — advance lastRound.
          if (round !== null && (existing.lastRound === null || round > existing.lastRound)) {
            existing.lastRound = round;
          }
          continue;
        }
        const pageStart = payloadNumber(cr, "pageStart");
        const row: KnowledgeConflictDTO = {
          section: payloadString(cr, "section") ?? field,
          campaignField: field,
          campaignValue: payloadString(cr, "campaignValue") ?? "",
          briefExcerpt: payloadString(cr, "briefExcerpt") ?? "",
          ...(pageStart !== null ? { pageStart } : {}),
          reason: reason ?? "",
          round,
          lastRound: round,
          status: "active", // finalized after the scan (see below)
        };
        byKey.set(key, row);
        conflicts.push(row);
        sawAnything = true;
      }
    };

    if (e.type === "NEGOTIATION_TURN") {
      const round = payloadNumber(p, "round");
      const knowledge = asRecord(p["knowledge"] as JsonValue | undefined);

      if (knowledge) {
        // This turn re-resolved the brief (availability is always present in a
        // knowledge block), so it defines a "current" knowledge snapshot round —
        // even when it reported NO conflicts (that's exactly the recovery case).
        noteKnowledgeRound(round);
        const avail = asRecord(knowledge["briefAvailability"] as JsonValue | undefined);
        if (avail) {
          const status = payloadString(avail, "status");
          if (
            status === "NO_BRIEF" ||
            status === "AVAILABLE" ||
            status === "PARTIAL" ||
            status === "PARSE_FAILED"
          ) {
            const missingRaw = avail["missingSections"];
            // LATEST wins — events are chronological (oldest-first), so overwrite.
            briefAvailability = {
              status,
              error: payloadString(avail, "error"),
              missingSections: Array.isArray(missingRaw)
                ? missingRaw.filter((s): s is string => typeof s === "string")
                : [],
              round,
            };
            sawAnything = true;
          }
        }
        harvestConflicts(knowledge["conflicts"], round);
      }

      // The material-conflict ESCALATION payload (reason material_knowledge_conflict)
      // carries its conflict rows at the TOP LEVEL (not under `knowledge`), so pick
      // those up too — otherwise the very turn that escalated wouldn't show its
      // conflicts in the panel. This is also a knowledge-bearing round.
      if (payloadString(p, "reason") === "material_knowledge_conflict") {
        noteKnowledgeRound(round);
        harvestConflicts(p["conflicts"], round);
      }
    } else if (
      e.type === "DEAL_HANDOFF_REQUESTED" ||
      e.type === "REWARD_SETUP_SENT" ||
      e.type === "PAYMENT_INFO_SENT"
    ) {
      const rs = asRecord(p["resolvedSources"] as JsonValue | undefined);
      if (rs) {
        const next: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(rs)) {
          next[k] = typeof v === "string" ? v : null;
        }
        resolvedSources = next; // latest post-acceptance event wins
        sawAnything = true;
      }
    }
  }

  if (!sawAnything) return undefined;

  // review §6: finalize active vs cleared. A conflict is ACTIVE iff it survived to
  // the latest knowledge-bearing round; one whose lastRound is earlier than that was
  // absent from the most recent re-resolution, i.e. corrected. When no round is
  // known at all (older instances with round-null payloads) we can't prove
  // recovery, so we leave it active — conservative (never hide a possibly-live
  // conflict).
  for (const c of conflicts) {
    c.status =
      latestKnowledgeRound !== null && c.lastRound !== null && c.lastRound < latestKnowledgeRound
        ? "cleared"
        : "active";
  }

  return { briefAvailability, conflicts, resolvedSources };
}

// PLU-81 §7.2: read the sanitized AI-context record folded onto the NEGOTIATION_TURN
// payloads (under a `context` key by buildContextRecord). Mirrors mapKnowledge:
// zero extra I/O, reads the LATEST turn that carries a context sub-object (events are
// chronological oldest-first, so the last one wins). Returns undefined when no turn
// has assembled context yet, so a parked/pre-first-turn instance renders an empty
// panel ("empty = no turn ran," §7.1) — NOT a live rebuild. Every field is
// labels/keys/counts; the record never carried band VALUES (§7.5), so nothing to
// redact here. Exported for the mapper unit test.
export function mapContext(events: Event[]): ContextDTO | undefined {
  let latest: ContextDTO | undefined;
  for (const e of events) {
    if (e.type !== "NEGOTIATION_TURN") continue;
    const p = asRecord(e.payload);
    if (!p) continue;
    const ctx = asRecord(p["context"] as JsonValue | undefined);
    if (!ctx) continue;
    const purpose = payloadString(ctx, "purpose");
    if (!purpose) continue; // a context record always stamps its purpose
    const strArray = (raw: unknown): string[] =>
      Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
    const summaryVersion = payloadString(ctx, "summaryVersion");
    latest = {
      purpose,
      round: payloadNumber(ctx, "round") ?? payloadNumber(p, "round"),
      messageIdsIncluded: strArray(ctx["messageIdsIncluded"]),
      eventCount: payloadNumber(ctx, "eventCount") ?? 0,
      campaignFieldsSelected: strArray(ctx["campaignFieldsSelected"]),
      briefSectionsUsed: strArray(ctx["briefSectionsUsed"]),
      openObligationIds: strArray(ctx["openObligationIds"]),
      ...(summaryVersion ? { summaryVersion } : {}),
      estimatedTokens: payloadNumber(ctx, "estimatedTokens") ?? 0,
      sourcesUsed: strArray(ctx["sourcesUsed"]),
      bandPresent: ctx["bandPresent"] === true,
    };
  }
  return latest;
}

export async function getInstanceDetail(id: string): Promise<InstanceDetailDTO | null> {
  const instRows = await db
    .select({ instance: executionInstances, creator: creators })
    .from(executionInstances)
    .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
    .where(eq(executionInstances.id, id))
    .limit(1);
  const found = instRows[0];
  if (!found) return null;
  const inst = found.instance;

  const versionRows = await db
    .select({ version: workflowVersions.version, workflowName: workflows.name })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .where(eq(workflowVersions.id, inst.workflowVersionId))
    .limit(1);
  const versionInfo = versionRows[0] ?? null;

  const [instMessages, instEvents, instLlmCalls, instObligations] = await Promise.all([
    db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.instanceId, id))
      .orderBy(asc(messagesTable.createdAt)),
    db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.instanceId, id))
      .orderBy(asc(eventsTable.occurredAt)),
    db
      .select()
      .from(llmCallsTable)
      .where(eq(llmCallsTable.instanceId, id))
      .orderBy(asc(llmCallsTable.createdAt)),
    // PLU-111: every obligation for the instance (open + resolved), oldest-first.
    // Reuses the DB access module (same query, one source of truth).
    listObligationsByInstance(id),
  ]);

  // Attribute each outbound message to a negotiation round, when discoverable
  // from the surrounding NEGOTIATION_TURN events sharing the same body.
  const roundByBody = new Map<string, number>();
  for (const e of instEvents) {
    if (e.type === "NEGOTIATION_TURN") {
      const p = asRecord(e.payload);
      const msg = payloadString(p, "message");
      const round = payloadNumber(p, "round");
      if (msg && round !== null) roundByBody.set(msg, round);
    }
  }

  const lastTransition = [...instEvents]
    .reverse()
    .find((e) => e.type === "STATE_TRANSITION");
  const lastTransitionSource = payloadString(asRecord(lastTransition?.payload ?? null), "source");

  // PLU-82: the knowledge block, computed once from the event log.
  const knowledge = mapKnowledge(instEvents);
  // PLU-81: the sanitized AI-context record from the latest turn (labels/keys/counts).
  const context = mapContext(instEvents);

  return {
    instance: {
      instanceId: inst.id,
      workflowVersionId: inst.workflowVersionId,
      workflowVersion: versionInfo?.version ?? null,
      workflowName: versionInfo?.workflowName ?? null,
      state: inst.currentState,
      currentNodeId: inst.currentNodeId,
      negotiationRound: inst.negotiationRound,
      followUpCount: inst.followUpCount,
      dueAt: inst.dueAt ? inst.dueAt.toISOString() : null,
      enrolledAt: inst.enrolledAt.toISOString(),
      completedAt: inst.completedAt ? inst.completedAt.toISOString() : null,
      createdAt: inst.createdAt.toISOString(),
      updatedAt: inst.updatedAt.toISOString(),
      lastTransitionSource,
    },
    creator: {
      id: found.creator.id,
      name: found.creator.name,
      email: found.creator.email,
      handle: found.creator.handle,
      niche: found.creator.niche,
      platform: found.creator.platform,
    },
    messages: instMessages.map((m) =>
      mapMessage(m, m.body ? roundByBody.get(m.body) ?? null : null),
    ),
    events: instEvents.map(mapEvent),
    agentDecisions: extractAgentDecisions(instEvents),
    llmUsage: {
      totals: llmTotalsFromCalls(instLlmCalls),
      calls: instLlmCalls.map(mapLlmCall),
    },
    obligations: instObligations.map(mapObligation),
    // PLU-82: the knowledge block (brief availability + conflicts + selected
    // sources) from the event log. Undefined → the panel renders empty.
    ...(knowledge ? { knowledge } : {}),
    // PLU-81: the sanitized AI-context record. Undefined → the panel renders empty
    // ("empty = no turn ran," §7.1).
    ...(context ? { context } : {}),
  };
}

// ---------------------------------------------------------------------------
// PLU-111 — operator manual resolution (§4.9)
// ---------------------------------------------------------------------------
// Terminal-status set an operator may apply by hand. Kept in sync with the DB
// layer's ManualResolveStatus so the route can validate the request body against
// a single source of truth.
export const MANUAL_RESOLVE_STATUSES: readonly ManualResolveStatus[] = [
  "ANSWERED",
  "COMPLETED",
  "CANCELED",
  "NO_LONGER_RELEVANT",
];

export function isManualResolveStatus(v: unknown): v is ManualResolveStatus {
  return typeof v === "string" && (MANUAL_RESOLVE_STATUSES as readonly string[]).includes(v);
}

export type ManualResolveOutcome =
  | { ok: true; obligation: ConversationObligationDTO }
  | { ok: false; reason: "instance_not_found" | "obligation_not_found" };

/**
 * Resolve one obligation manually to a terminal status (resolutionSource =
 * "operator"). Guards that the obligation belongs to the instance in the URL —
 * so the operator can't resolve an unrelated instance's obligation by id. The
 * underlying resolveObligationManual is idempotent: resolving an already-terminal
 * row no-ops and returns the current row (still ok:true — the desired end state
 * holds).
 */
export async function resolveInstanceObligation(
  instanceId: string,
  obligationId: string,
  opts: { status: ManualResolveStatus; resolution?: string | null },
): Promise<ManualResolveOutcome> {
  // Confirm the obligation exists AND is scoped to this instance.
  const rows = await db
    .select()
    .from(conversationObligationsTable)
    .where(eq(conversationObligationsTable.id, obligationId))
    .limit(1);
  const existing = rows[0];
  if (!existing || existing.instanceId !== instanceId) {
    return { ok: false, reason: "obligation_not_found" };
  }
  const updated = await resolveObligationManual(obligationId, opts, "operator");
  if (!updated) return { ok: false, reason: "obligation_not_found" };
  return { ok: true, obligation: mapObligation(updated) };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function summarizeEvent(e: Event): string {
  const p = asRecord(e.payload);
  switch (e.type) {
    case "STATE_TRANSITION":
      return `${payloadString(p, "from") ?? "?"} → ${payloadString(p, "to") ?? "?"}`;
    case "OUTREACH_DRAFTED":
      return "Outreach email drafted";
    case "NODE_ENTERED":
      return `Entered node ${e.nodeId ?? "?"}`;
    case "NODE_COMPLETED":
      return `Completed node ${e.nodeId ?? "?"}`;
    case "FOLLOW_UP_SCHEDULED":
      return "Follow-up scheduled";
    case "FOLLOW_UP_CANCELLED":
      return "Follow-up cancelled";
    case "FOLLOW_UP_DUE":
      return "Follow-up due";
    case "INBOUND_REPLY_RECEIVED":
      return `Inbound reply received${payloadString(p, "subject") ? `: ${payloadString(p, "subject")}` : ""}`;
    case "REPLY_CLASSIFIED": {
      const intent = payloadString(p, "intent");
      const conf = payloadNumber(p, "confidence");
      return `Reply classified as ${intent ?? "?"}${conf !== null ? ` (${conf.toFixed(2)})` : ""}`;
    }
    case "NEGOTIATION_TURN": {
      const outcome = payloadString(p, "outcome");
      const round = payloadNumber(p, "round");
      return `Negotiation ${outcome ?? "turn"}${round !== null ? ` (round ${round})` : ""}`;
    }
    case "MANUAL_REVIEW_FLAGGED":
      return "Flagged for manual review";
    default:
      return e.type;
  }
}

async function instanceExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: executionInstances.id })
    .from(executionInstances)
    .where(eq(executionInstances.id, id))
    .limit(1);
  return rows.length > 0;
}

export async function getTimeline(id: string): Promise<TimelineDTO | null> {
  if (!(await instanceExists(id))) return null;

  const events = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.instanceId, id))
    .orderBy(asc(eventsTable.occurredAt));

  const entries: TimelineEntryDTO[] = events.map((e) => {
    const p = asRecord(e.payload);
    return {
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      nodeId: e.nodeId,
      source: payloadString(p, "source"),
      summary: summarizeEvent(e),
      fromState: e.type === "STATE_TRANSITION" ? payloadString(p, "from") : null,
      toState: e.type === "STATE_TRANSITION" ? payloadString(p, "to") : null,
      // EASY-S2: redact any raw guard-leak band value from a legacy payload before
      // serving it (new rows are already masked at write time).
      payload: p ? maskPayloadLeaks(p) : p,
    };
  });

  return { instanceId: id, entries };
}

// ---------------------------------------------------------------------------
// Logs / trace
// ---------------------------------------------------------------------------

/**
 * Reconstructs the transition trace for one instance from the STATE_TRANSITION
 * events, surfacing the persisted source / worker / queueJobId. This is the
 * end-to-end traceability surface (Part 10): for each hop, who triggered it.
 */
export async function getLogs(id: string): Promise<LogsDTO | null> {
  if (!(await instanceExists(id))) return null;

  const events = await db
    .select()
    .from(eventsTable)
    .where(and(eq(eventsTable.instanceId, id), eq(eventsTable.type, "STATE_TRANSITION")))
    .orderBy(asc(eventsTable.occurredAt));

  const trace: LogEntryDTO[] = events.map((e) => {
    const p = asRecord(e.payload);
    return {
      occurredAt: e.occurredAt.toISOString(),
      fromState: payloadString(p, "from"),
      toState: payloadString(p, "to"),
      source: payloadString(p, "source"),
      worker: payloadString(p, "worker"),
      queueJobId: payloadString(p, "queueJobId"),
      nodeId: e.nodeId,
      eventType: e.type,
    };
  });

  return { instanceId: id, trace };
}

// ---------------------------------------------------------------------------
// LLM usage (HARD-O1)
// ---------------------------------------------------------------------------
// Aggregates over the LlmCall table — the durable token/latency/cost telemetry
// the agent's in-process ring buffer cannot provide. Totals are computed in
// SQL (never a truncated in-memory scan) so they stay correct as the table
// grows; only the `recent` list is bounded.

const RECENT_LLM_CALLS_LIMIT = 50;

function mapLlmCall(c: LlmCall): LlmCallDTO {
  return {
    id: c.id,
    role: c.role as LlmCallRole,
    model: c.model,
    promptVersion: c.promptVersion,
    latencyMs: c.latencyMs,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    totalTokens: c.totalTokens,
    estCostUsd: c.estCostUsd,
    ok: c.ok,
    errorKind: c.errorKind,
    createdAt: c.createdAt.toISOString(),
  };
}

/** In-memory totals for a small, already-loaded set (one instance's calls). */
function llmTotalsFromCalls(calls: LlmCall[]): LlmUsageTotalsDTO {
  const n = calls.length;
  return {
    calls: n,
    errors: calls.filter((c) => !c.ok).length,
    inputTokens: calls.reduce((a, c) => a + (c.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
    totalTokens: calls.reduce((a, c) => a + (c.totalTokens ?? 0), 0),
    estCostUsd: round6(calls.reduce((a, c) => a + (c.estCostUsd ?? 0), 0)),
    avgLatencyMs: n > 0 ? Math.round(calls.reduce((a, c) => a + c.latencyMs, 0) / n) : null,
  };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// The SQL-side aggregate selection shared by the totals / windowed / grouped
// queries. Sums coalesce to 0 (unreported usage counts as 0 toward totals);
// avg stays null when there are no rows.
function llmTotalsSelection() {
  return {
    calls: count(),
    errors: sql<number>`count(*) filter (where ${llmCallsTable.ok} = false)`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(${llmCallsTable.inputTokens}), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(${llmCallsTable.outputTokens}), 0)`.mapWith(Number),
    totalTokens: sql<number>`coalesce(sum(${llmCallsTable.totalTokens}), 0)`.mapWith(Number),
    estCostUsd: sql<number>`coalesce(sum(${llmCallsTable.estCostUsd}), 0)`.mapWith(Number),
    avgLatencyMs: sql<number | null>`avg(${llmCallsTable.latencyMs})`,
  };
}

type LlmTotalsRow = {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUsd: number;
  avgLatencyMs: number | string | null;
};

function toTotalsDTO(row: LlmTotalsRow | undefined): LlmUsageTotalsDTO {
  if (!row) {
    return {
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estCostUsd: 0,
      avgLatencyMs: null,
    };
  }
  // avg() arrives as a numeric string from the driver; normalize + round.
  const avg = row.avgLatencyMs === null ? null : Math.round(Number(row.avgLatencyMs));
  return {
    calls: row.calls,
    errors: row.errors,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    estCostUsd: round6(row.estCostUsd),
    avgLatencyMs: avg,
  };
}

// ---------------------------------------------------------------------------
// P4 — daily spend guard (monitor)
// ---------------------------------------------------------------------------
// Pure: given the trailing-24h estimated spend and the raw env threshold string,
// report whether the daily budget has been crossed. Threshold unset/blank/invalid
// ⇒ guard off (thresholdUsd null, never exceeded), so local Ollama ($0) and
// deployments that haven't opted in are unaffected. Exported for unit testing.
export function computeSpendGuard(
  spentUsd: number,
  thresholdRaw: string | undefined,
): LlmSpendGuardDTO {
  const parsed = thresholdRaw === undefined ? NaN : Number(thresholdRaw.trim());
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const spent = round6(spentUsd);
  if (threshold === null) {
    return { thresholdUsd: null, spentUsd: spent, exceeded: false, ratio: null };
  }
  return {
    thresholdUsd: threshold,
    spentUsd: spent,
    exceeded: spent > threshold,
    ratio: round6(spent / threshold),
  };
}

export async function getLlmUsage(): Promise<LlmUsageSummaryDTO> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const [allRows, dayRows, roleRows, modelRows, recentRows] = await Promise.all([
    db.select(llmTotalsSelection()).from(llmCallsTable),
    db
      .select(llmTotalsSelection())
      .from(llmCallsTable)
      .where(gte(llmCallsTable.createdAt, dayAgo)),
    db
      .select({ key: llmCallsTable.role, ...llmTotalsSelection() })
      .from(llmCallsTable)
      .groupBy(llmCallsTable.role),
    db
      .select({ key: llmCallsTable.model, ...llmTotalsSelection() })
      .from(llmCallsTable)
      .groupBy(llmCallsTable.model),
    db
      .select()
      .from(llmCallsTable)
      .orderBy(desc(llmCallsTable.createdAt))
      .limit(RECENT_LLM_CALLS_LIMIT),
  ]);

  const breakdown = (rows: Array<LlmTotalsRow & { key: string }>): LlmUsageBreakdownEntryDTO[] =>
    rows
      .map((r) => ({ key: r.key, totals: toTotalsDTO(r) }))
      .sort((a, b) => b.totals.calls - a.totals.calls);

  const last24h = toTotalsDTO(dayRows[0]);

  return {
    totals: toTotalsDTO(allRows[0]),
    last24h,
    byRole: breakdown(roleRows),
    byModel: breakdown(modelRows),
    recent: recentRows.map(mapLlmCall),
    // P4 daily spend monitor — compare trailing-24h spend to the configured
    // threshold (LLM_DAILY_SPEND_ALERT_USD); off when unset.
    spendGuard: computeSpendGuard(last24h.estCostUsd, process.env["LLM_DAILY_SPEND_ALERT_USD"]),
    generatedAt: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// P9 — operator alerts aggregator (GET /observability/alerts)
// ---------------------------------------------------------------------------
// Gather every "the operator should act now" signal in ONE read so an uptime
// monitor / cron curl can poll a single endpoint and page a human. The judging
// (thresholds + severity) lives in the pure evaluateAlerts (alerts.ts); this
// only collects the live numbers to feed it.

/** Count instances currently parked in MANUAL_REVIEW (the human-action state). */
async function countManualReview(): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(executionInstances)
    .where(eq(executionInstances.currentState, "MANUAL_REVIEW"));
  return rows[0]?.n ?? 0;
}

/** Count brand/escalation notifications whose send FAILED (operator not reached). */
async function countFailedNotifications(): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(brandNotifications)
    .where(eq(brandNotifications.status, "FAILED"));
  return rows[0]?.n ?? 0;
}

export async function getAlertsReport(): Promise<AlertsReportDTO> {
  const now = Date.now();
  // Reuse the existing collectors: worker metrics gives queue failed counts +
  // stuck total, getLlmUsage gives the spend-guard verdict. Run in parallel.
  const [metrics, llm, manualReviewCount, failedNotificationCount] = await Promise.all([
    collectWorkerMetrics(now),
    getLlmUsage(),
    countManualReview(),
    countFailedNotifications(),
  ]);

  const queueFailedByName: Record<string, number> = {};
  let queueFailedTotal = 0;
  for (const q of metrics.queues) {
    queueFailedByName[q.queue] = q.failed;
    queueFailedTotal += q.failed;
  }

  const inputs: AlertInputs = {
    queueFailedTotal,
    queueFailedByName,
    manualReviewCount,
    failedNotificationCount,
    stuckInstanceCount: metrics.stuckTotal,
    spendExceeded: llm.spendGuard.exceeded,
    spendUsd: llm.spendGuard.spentUsd,
    spendThresholdUsd: llm.spendGuard.thresholdUsd,
  };

  return buildAlertsReport(inputs, new Date(now).toISOString());
}
