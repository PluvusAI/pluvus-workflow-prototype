// ---------------------------------------------------------------------------
// Manual Queue routes (Phase 11)
// ---------------------------------------------------------------------------
// Read + light-action surface for creators that need a human. Powers the
// "Manual Queue" tab in the builder:
//
//   GET  /manual-queue/workflows/:workflowId    queue items + notification status
//   POST /manual-queue/instances/:id/notify     (re)send the notice for one
//   POST /manual-queue/instances/:id/handoff/complete   mark a deal onboarded
//   POST /manual-queue/instances/:id/brand-approval/resend  rotate token + re-send
//        the brand-approval request (recovery for a no-recipient / expired gate)
//
// Two KINDS of item share this queue (PLU-70), discriminated by `kind`:
//   - "escalation" (MANUAL_REVIEW) — the AI could not safely proceed. The reason
//     + timestamp are reconstructed from the event log (MANUAL_REVIEW_FLAGGED /
//     NEGOTIATION_TURN ESCALATE / STATE_TRANSITION).
//   - "handoff" (NEEDS_DEAL_FINALIZATION) — the AI closed a deal on an
//     operator_handoff campaign and a human finalizes it in main Pluvus. The
//     agreed terms are joined from DealHandoff.
// They share one surface because they share one question: who picks this up?
//
// The notification status is joined from the BrandNotification table for both.

import { Router } from "express";
import type { Request, Response } from "express";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Event, JsonValue } from "../db/schema.js";
import {
  creators,
  events as eventsTable,
  executionInstances,
  messages as messagesTable,
} from "../db/schema.js";
import { db } from "../db/drizzle.js";
import { findWorkflowById, findLatestVersion } from "../db/workflows.js";
import { findCampaignById } from "../db/campaigns.js";
import {
  findInstanceById,
  findCreatorById,
  listEventsByInstance,
  listLatestBrandNotificationsForInstances,
  listDealHandoffsForInstances,
  completeDealHandoff,
  updateInstanceStateConditional,
  appendEvent,
  resolveManualReviewCase,
  findNegotiationPolicySnapshotById,
  getManualReviewCaseMeta,
  assertFeeWithinBand,
  BandViolationError,
  ManualReviewRaceError,
  type ManualReviewOutcome,
  type ResolvedTerms,
} from "../db/index.js";
import { emailProvider } from "../engine/providerFactory.js";
import { resendBrandApprovalRequest } from "../engine/executors/brandApprovalResend.js";
import {
  notifyBrandOfEscalation,
  notifyOperatorOfDealFinalization,
  resolveBrandRecipient,
} from "../notifications/escalation.js";
import { formatAgreedCompensation } from "../engine/dealTerms.js";
import { assertTransition, InvalidTransitionError } from "../engine/stateMachine.js";

const router = Router();

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

// Human-readable label for each escalation reason code (mirrors escalation.ts).
const REASON_LABELS: Record<string, string> = {
  low_confidence_reply: "Reply could not be classified confidently",
  max_rounds_reached: "Negotiation hit the maximum rounds",
  max_rounds_reached_on_counter: "Next counter would exceed maximum rounds",
  output_guard_blocked: "Outbound draft blocked by safety guard",
  escalated: "Escalated by the negotiation agent",
  no_ceiling_configured: "Campaign has no maximum budget — set one to auto-negotiate",
  agent_unavailable: "AI agent unavailable (degraded mode)",
  max_rounds_no_agreement: "Negotiation closed — no agreement within the round limit",
  missing_brand_name: "Waiting on the brand name to use in emails",
  // Phase E (#5): always-escalate topics (routed regardless of confidence).
  legal_or_contract: "Legal / contract change — needs a human",
  dispute_or_hostile: "Dispute, payment complaint, or hostile message",
  pricing_exception: "Custom fee structure / bonus / guarantee ask",
  undefined_terms: "Undefined campaign term — needs a human to clarify",
  usage_rights_or_licensing: "Usage rights / exclusivity / licensing ask",
  // Content submission: the creator replied with the link(s) to their content.
  content_links_submitted: "Creator submitted content links",
  // PLU-70. Not a failure: the AI closed a deal and a human finishes it.
  needs_deal_finalization: "Agreement reached — ready for operator onboarding",
  // Brand-approval gate: the brand rejected the closed deal via the magic link.
  brand_rejected: "Brand rejected the deal — needs a human to follow up",
  // PLU-82 §4.5: a material brief-vs-Campaign conflict on a field the creator
  // asked about — the AI must not pick between two disagreeing sources.
  // NB: this label MUST stay in sync with the identical key in
  // notifications/escalation.ts REASON_LABELS (no shared constant — §8-h).
  material_knowledge_conflict:
    "Brief and campaign disagree on a term the creator asked about",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? "Escalated for human review";
}

/**
 * Derive the escalation reason for an instance from its event log.
 * Prefers the most recent escalation-bearing event:
 *   - MANUAL_REVIEW_FLAGGED  → "low_confidence_reply"
 *   - NEGOTIATION_TURN whose payload.outcome is ESCALATE/escalate → payload.reason
 * Returns the reason code + the time the instance was escalated.
 */
function deriveEscalation(events: Event[]): { reason: string; escalatedAt: string | null } {
  // Walk newest → oldest to find the event that drove the escalation.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const p = asRecord(e.payload);
    if (e.type === "MANUAL_REVIEW_FLAGGED") {
      // An explicit payload.reason wins (Phase E always-escalate topics, L4
      // missing_brand_name, etc.); only a reason-less flag defaults to the
      // original reply-detection case (low_confidence_reply). Mirrors
      // runtime.escalationReason so the dashboard + brand FYI agree.
      return {
        reason: payloadString(p, "reason") ?? "low_confidence_reply",
        escalatedAt: e.occurredAt.toISOString(),
      };
    }
    if (e.type === "NEGOTIATION_TURN") {
      const outcome = payloadString(p, "outcome");
      if (outcome && outcome.toUpperCase() === "ESCALATE") {
        return {
          reason: payloadString(p, "reason") ?? "escalated",
          escalatedAt: e.occurredAt.toISOString(),
        };
      }
    }
    // Brand-approval gate: a brand Reject halts to MANUAL_REVIEW via a direct
    // transition (no MANUAL_REVIEW_FLAGGED event), so recognize the audit event.
    if (e.type === "BRAND_REJECTED") {
      return { reason: "brand_rejected", escalatedAt: e.occurredAt.toISOString() };
    }
  }
  // Fallback: the STATE_TRANSITION into MANUAL_REVIEW carries the timestamp.
  const transition = [...events]
    .reverse()
    .find((e) => e.type === "STATE_TRANSITION" && payloadString(asRecord(e.payload), "to") === "MANUAL_REVIEW");
  return {
    reason: "escalated",
    escalatedAt: transition ? transition.occurredAt.toISOString() : null,
  };
}

/**
 * Extract the submitted content URLs for an instance from its event log. Reads
 * the most recent CONTENT_LINKS_SUBMITTED event that carried a non-empty `urls`
 * array (the no-URL nudge self-loop emits the same type with an empty array).
 * Returns [] when there is no such event.
 */
function deriveSubmittedUrls(events: Event[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "CONTENT_LINKS_SUBMITTED") continue;
    const p = asRecord(e.payload);
    const raw = p?.["urls"];
    if (Array.isArray(raw)) {
      const urls = raw.filter((u): u is string => typeof u === "string" && u.length > 0);
      if (urls.length > 0) return urls;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// GET /manual-queue/workflows/:workflowId
// ---------------------------------------------------------------------------

router.get("/workflows/:workflowId", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["workflowId"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.json({ workflowId: wf.id, items: [], total: 0, generatedAt: new Date().toISOString() });
      return;
    }

    const instRows = await db
      .select({ instance: executionInstances, creator: creators })
      .from(executionInstances)
      .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
      .where(
        and(
          eq(executionInstances.workflowVersionId, latestVersion.id),
          // PLU-70: the queue now holds two KINDS of item — AI escalations
          // (MANUAL_REVIEW) and closed deals awaiting operator onboarding
          // (NEEDS_DEAL_FINALIZATION). Both are "a human must act", which is
          // exactly what this surface is for, so they share one list rather than
          // spawning a second deal-management screen.
          // PLU-154: EXPIRED (timed-out MR) stays visible as a resolved-timeout row
          // so operators can see cases that closed on their own.
          inArray(executionInstances.currentState, [
            "MANUAL_REVIEW",
            "NEEDS_DEAL_FINALIZATION",
            "EXPIRED",
          ]),
        ),
      )
      .orderBy(desc(executionInstances.updatedAt));

    // W-6: fetch ONLY the event types deriveEscalation actually reads
    // (MANUAL_REVIEW_FLAGGED / NEGOTIATION_TURN / STATE_TRANSITION), not the full
    // per-instance log. The manual queue previously loaded every event for every
    // escalated instance on each poll — most of them (NODE_ENTERED, OUTREACH_*,
    // etc.) are irrelevant to the escalation reason. Narrowing the type filter
    // keeps the query bounded as the funnel history grows.
    const ids = instRows.map((r) => r.instance.id);
    const eventsByInstance = new Map<string, Event[]>();
    if (ids.length > 0) {
      const eventRows = await db
        .select()
        .from(eventsTable)
        .where(
          and(
            inArray(eventsTable.instanceId, ids),
            inArray(eventsTable.type, [
              "MANUAL_REVIEW_FLAGGED",
              "NEGOTIATION_TURN",
              "STATE_TRANSITION",
              // Content-links escalation: carries the submitted URLs so the queue
              // entry can show the link count + list without a per-item read.
              "CONTENT_LINKS_SUBMITTED",
              // PLU-154: nudge count for the deadline/nudge display.
              "MANUAL_REVIEW_NUDGED",
            ]),
          ),
        )
        .orderBy(asc(eventsTable.occurredAt));
      for (const ev of eventRows) {
        const list = eventsByInstance.get(ev.instanceId);
        if (list) list.push(ev);
        else eventsByInstance.set(ev.instanceId, [ev]);
      }
    }

    const notifications = await listLatestBrandNotificationsForInstances(ids);
    const handoffs = await listDealHandoffsForInstances(ids);

    // E6: resolve each escalated instance's thread id in ONE bulk read so the row
    // can carry a deep-link to the thread that holds the whole conversation. All
    // of an instance's messages share one threadId once set, so any non-null row
    // is representative; we keep the first seen per instance. The provider builds
    // the actual URL (shape is provider-specific) — omitted gracefully when the
    // provider can't (mock / unconfigured) or the instance hasn't threaded yet.
    const threadIdByInstance = new Map<string, string>();
    if (ids.length > 0) {
      const threadRows = await db
        .select({
          instanceId: messagesTable.instanceId,
          threadId: messagesTable.threadId,
        })
        .from(messagesTable)
        .where(
          and(
            inArray(messagesTable.instanceId, ids),
            isNotNull(messagesTable.threadId),
          ),
        );
      for (const row of threadRows) {
        if (row.threadId && !threadIdByInstance.has(row.instanceId)) {
          threadIdByInstance.set(row.instanceId, row.threadId);
        }
      }
    }
    // The provider only supplies the deep-link URL shape here — best-effort. If
    // it can't even be constructed (e.g. EMAIL_PROVIDER unset in a misconfigured
    // env), the queue must still list: degrade to no thread links rather than
    // 500 the whole endpoint. Threading is an enhancement, never a blocker.
    let threadUrlFor: ((threadId: string) => string | undefined) | undefined;
    try {
      const provider = emailProvider();
      threadUrlFor = provider.threadUrl?.bind(provider);
    } catch (err) {
      console.warn(
        `[manual-queue] could not resolve email provider for thread links; omitting them: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const items = instRows.map(({ instance: inst, creator }) => {
      const instEvents = eventsByInstance.get(inst.id) ?? [];
      const isHandoff = inst.currentState === "NEEDS_DEAL_FINALIZATION";
      const isExpired = inst.currentState === "EXPIRED";
      // PLU-154: deadline (dueAt) + nudge count for the queue-row countdown.
      const { deadline, nudgeCount } = getManualReviewCaseMeta(inst, instEvents);
      const handoff = handoffs.get(inst.id) ?? null;
      const { reason, escalatedAt } = deriveEscalation(instEvents);
      const notification = notifications.get(inst.id) ?? null;
      const threadId = threadIdByInstance.get(inst.id) ?? null;
      // Build the deep-link only when both a threadId and a provider URL builder
      // yield one; otherwise the UI simply shows no thread link (no broken link).
      const threadUrl = threadId && threadUrlFor ? threadUrlFor(threadId) ?? null : null;
      // Content-links escalation: the submitted URLs (empty for every other reason).
      const submittedUrls = deriveSubmittedUrls(instEvents);
      return {
        instanceId: inst.id,
        // Discriminator the UI switches on: a handoff row shows the agreed
        // compensation and a "mark completed" action; an escalation row keeps
        // the existing reason + notify-brand affordances + PLU-154 resolution
        // actions; an expired row is read-only (the case timed out).
        kind: isHandoff
          ? ("handoff" as const)
          : isExpired
            ? ("expired" as const)
            : ("escalation" as const),
        creatorId: inst.creatorId,
        creatorName: creator.name,
        creatorEmail: creator.email,
        creatorHandle: creator.handle,
        platform: creator.platform,
        niche: creator.niche,
        negotiationRound: inst.negotiationRound,
        reason: isHandoff ? "needs_deal_finalization" : reason,
        reasonLabel: reasonLabel(isHandoff ? "needs_deal_finalization" : reason),
        escalatedAt,
        updatedAt: inst.updatedAt.toISOString(),
        // PLU-154: deadline countdown + nudge count for a live MANUAL_REVIEW case
        // (null deadline when the timeout feature is off). timedOut marks a case
        // the sweep already expired. Only meaningful on escalation/expired rows.
        deadline: deadline?.toISOString() ?? null,
        nudgeCount,
        timedOut: isExpired,
        // E6: the thread deep-link (null when unavailable — the UI omits it).
        threadUrl,
        // Content-links: the submitted URLs + count (empty/0 for other reasons).
        submittedUrls,
        linkCount: submittedUrls.length,
        // Handoff-only fields. The row stays compact deliberately — creator,
        // campaign, compensation, accepted date, status and nothing more. The
        // structured agreement and the thread live in the existing inspector.
        handoff:
          isHandoff && handoff
            ? {
                campaignName: handoff.campaignName,
                agreedCompensation: formatAgreedCompensation(
                  handoff.fixedFee,
                  handoff.commissionRate,
                ),
                acceptedAt: handoff.acceptedAt.toISOString(),
                status: handoff.status,
                completedAt: handoff.completedAt?.toISOString() ?? null,
                deliverables: handoff.deliverables,
                timeline: handoff.timeline,
                paymentTerms: handoff.paymentTerms,
              }
            : null,
        notification: notification
          ? {
              status: notification.status,
              recipient: notification.recipient,
              error: notification.error,
              sentAt: notification.createdAt.toISOString(),
            }
          : null,
      };
    });

    res.json({
      workflowId: wf.id,
      versionId: latestVersion.id,
      version: latestVersion.version,
      items,
      total: items.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[manual-queue] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /manual-queue/instances/:instanceId/notify
// ---------------------------------------------------------------------------
// (Re)send the brand notification for one escalated instance. Useful when the
// first send FAILED (provider down) or the brand's contact was added after the
// escalation. The reason is re-derived from the event log. Because the escalation
// notifier is idempotent on (instanceId + reason), a successful prior SENT will
// short-circuit to ALREADY_NOTIFIED — to force a fresh send we append a "-manual"
// discriminator so the operator can always re-trigger one.

router.post("/instances/:instanceId/notify", async (req: Request, res: Response) => {
  try {
    const instanceId = req.params["instanceId"]!;
    const inst = await findInstanceById(instanceId);
    if (!inst) {
      res.status(404).json({ error: "instance not found" });
      return;
    }
    // PLU-70: both queue kinds can be re-notified — an operator whose
    // deal-finalization email bounced needs the same re-send affordance an
    // escalation already has.
    if (
      inst.currentState !== "MANUAL_REVIEW" &&
      inst.currentState !== "NEEDS_DEAL_FINALIZATION"
    ) {
      res.status(409).json({
        error: `instance is not in the manual queue (state: ${inst.currentState})`,
      });
      return;
    }

    const events = await listEventsByInstance(instanceId);
    const { reason } =
      inst.currentState === "NEEDS_DEAL_FINALIZATION"
        ? { reason: "needs_deal_finalization" }
        : deriveEscalation(events);

    // Force a fresh notification distinct from the automatic one so operators can
    // always re-send (e.g. after fixing the brand email or a provider outage).
    const manualReason = `${reason}-manual-${events.length}`;
    const result =
      inst.currentState === "NEEDS_DEAL_FINALIZATION"
        ? await notifyOperatorOfDealFinalization(emailProvider(), instanceId, undefined, manualReason)
        : await notifyBrandOfEscalation(emailProvider(), instanceId, manualReason);

    res.json({ instanceId, reason, ...result });
  } catch (err) {
    console.error("[manual-queue] notify error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /manual-queue/instances/:instanceId/brand-approval/resend  (PLU-118)
// ---------------------------------------------------------------------------
// Recovery for a brand-approval gate that got stuck with no way out:
//   - the gate parked in AWAITING_BRAND_APPROVAL but NO brand recipient resolved,
//     so the request email was never sent, or
//   - the magic-link token expired (default 14 days) before the brand acted.
// Rotates the token (fresh hash + expiry) and re-sends the request from the stored
// snapshot. Only valid while the instance is still parked AND the approval row is
// still AWAITING_APPROVAL — a decided/in-flight deal is left untouched.

router.post(
  "/instances/:instanceId/brand-approval/resend",
  async (req: Request, res: Response) => {
    try {
      const instanceId = req.params["instanceId"]!;
      const result = await resendBrandApprovalRequest(emailProvider(), instanceId);
      if (result.ok) {
        res.json({ instanceId, resent: true, recipient: result.recipient });
        return;
      }
      // Map each expected "can't resend" reason to a clean status.
      const status =
        result.reason === "no_approval_row" ? 404 :
        result.reason === "no_recipient" ? 422 :
        409;
      const message =
        result.reason === "no_approval_row"
          ? "no brand-approval request exists for this instance"
          : result.reason === "no_recipient"
            ? "no brand recipient could be resolved — set the campaign notifyEmail or BRAND_NOTIFY_EMAIL"
            : result.reason === "not_awaiting"
              ? "the brand-approval decision is no longer pending"
              : "instance is not awaiting brand approval";
      res.status(status).json({ instanceId, resent: false, reason: result.reason, error: message });
    } catch (err) {
      console.error("[manual-queue] brand-approval resend error:", err);
      res.status(500).json({ error: "internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /manual-queue/instances/:instanceId/handoff/complete  (PLU-70)
// ---------------------------------------------------------------------------
// The single, minimal operator action: "I finalized this deal and onboarded the
// creator in Pluvus." Deliberately NOT an onboarding state machine — one button,
// one terminal transition.
//
// Driven from a route rather than runtime.stepInstance because there is no node
// to dispatch: NEEDS_DEAL_FINALIZATION is owned by a human, not by the graph.
// This mirrors how the notify action above already works. The write still goes
// through the same OCC helper the engine uses, so a double-click cannot
// double-transition.

router.post("/instances/:instanceId/handoff/complete", async (req: Request, res: Response) => {
  try {
    const instanceId = req.params["instanceId"]!;
    const { completedBy } = req.body as { completedBy?: unknown };

    const inst = await findInstanceById(instanceId);
    if (!inst) {
      res.status(404).json({ error: "instance not found" });
      return;
    }
    if (inst.currentState !== "NEEDS_DEAL_FINALIZATION") {
      res.status(409).json({
        error: `instance is not awaiting deal finalization (state: ${inst.currentState})`,
      });
      return;
    }

    // Validate against the same transition table the engine uses, so this route
    // can never introduce an edge the state machine doesn't sanction.
    assertTransition("NEEDS_DEAL_FINALIZATION", "HANDOFF_COMPLETE");

    const now = new Date();

    // Record the operator action first. Idempotent: a second call leaves the
    // original completedAt/completedBy intact.
    const handoff = await completeDealHandoff(instanceId, {
      completedBy: typeof completedBy === "string" && completedBy.trim() ? completedBy.trim() : null,
      completedAt: now,
    });

    // Then close the execution. OCC-guarded on the expected state: if another
    // request won the race, this updates 0 rows and we report the conflict
    // rather than claiming a transition that didn't happen.
    const updated = await updateInstanceStateConditional(
      instanceId,
      "NEEDS_DEAL_FINALIZATION",
      { currentState: "HANDOFF_COMPLETE", currentNodeId: null, completedAt: now },
    );
    if (!updated) {
      res.status(409).json({ error: "instance was concurrently modified — reload and retry" });
      return;
    }

    await appendEvent({
      instanceId,
      type: "DEAL_HANDOFF_COMPLETED",
      payload: {
        completedBy: handoff?.completedBy ?? null,
        completedAt: now.toISOString(),
      },
      occurredAt: now,
    });
    await appendEvent({
      instanceId,
      type: "STATE_TRANSITION",
      payload: { from: "NEEDS_DEAL_FINALIZATION", to: "HANDOFF_COMPLETE", source: "operator" },
      occurredAt: now,
    });

    res.json({
      instanceId,
      state: updated.currentState,
      completedAt: now.toISOString(),
      completedBy: handoff?.completedBy ?? null,
    });
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[manual-queue] handoff complete error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Manual-review case RESOLUTION (PLU-154)
// ---------------------------------------------------------------------------
// Three human actions take a MANUAL_REVIEW case to a terminal outcome. Each is a
// single OCC-guarded transition (resolveManualReviewCase) atomic with its audit
// events + optional DealHandoff. All three follow the handoff/complete template:
// load → guard state → resolve → 409 on race → JSON. Idempotency: a retried request
// against an ALREADY-resolved case returns 200 with the existing outcome (read from
// the event log) rather than 409; a DIFFERENT terminal state is a genuine 409.

/** The prior resolution outcome + reason for an already-terminal case, from the
 *  MANUAL_REVIEW_RESOLVED event. Null when none was recorded. */
function priorResolution(
  events: Event[],
): { outcome: string; reason: string | null; resolvedBy: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "MANUAL_REVIEW_RESOLVED") continue;
    const p = asRecord(e.payload);
    return {
      outcome: payloadString(p, "outcome") ?? "",
      reason: payloadString(p, "reason"),
      resolvedBy: payloadString(p, "resolvedBy"),
    };
  }
  return null;
}

/** Shared handler for reject + opt-out (identical shape, different target/reason). */
async function handleSimpleResolution(
  req: Request,
  res: Response,
  to: Extract<ManualReviewOutcome, "REJECTED" | "OPTED_OUT">,
  defaultReason: string,
): Promise<void> {
  try {
    const instanceId = req.params["instanceId"]!;
    const { resolvedBy, reason } = req.body as { resolvedBy?: unknown; reason?: unknown };
    if (typeof resolvedBy !== "string" || !resolvedBy.trim()) {
      res.status(400).json({ error: "resolvedBy is required" });
      return;
    }
    const inst = await findInstanceById(instanceId);
    if (!inst) {
      res.status(404).json({ error: "instance not found" });
      return;
    }
    // Idempotency: already resolved to the SAME outcome → return the existing one.
    if (inst.currentState === to) {
      const prior = priorResolution(await listEventsByInstance(instanceId));
      res.json({ instanceId, state: to, outcome: to, idempotent: true, ...prior });
      return;
    }
    if (inst.currentState !== "MANUAL_REVIEW") {
      res.status(409).json({
        error: `instance is not in manual review (state: ${inst.currentState})`,
      });
      return;
    }

    const resolutionReason =
      typeof reason === "string" && reason.trim() ? reason.trim() : defaultReason;
    const updated = await resolveManualReviewCase(instanceId, {
      to,
      resolvedBy: resolvedBy.trim(),
      reason: resolutionReason,
    });
    res.json({ instanceId, state: updated.currentState, outcome: to, reason: resolutionReason });
  } catch (err) {
    if (err instanceof ManualReviewRaceError) {
      res.status(409).json({ error: "instance was concurrently modified — reload and retry" });
      return;
    }
    console.error(`[manual-queue] resolve (${to}) error:`, err);
    res.status(500).json({ error: "internal server error" });
  }
}

// POST /manual-queue/instances/:instanceId/manual-review/approve
router.post(
  "/instances/:instanceId/manual-review/approve",
  async (req: Request, res: Response) => {
    try {
      const instanceId = req.params["instanceId"]!;
      const body = req.body as { resolvedBy?: unknown; reason?: unknown; terms?: unknown };
      if (typeof body.resolvedBy !== "string" || !body.resolvedBy.trim()) {
        res.status(400).json({ error: "resolvedBy is required" });
        return;
      }
      const terms = (body.terms ?? {}) as ResolvedTerms;

      const inst = await findInstanceById(instanceId);
      if (!inst) {
        res.status(404).json({ error: "instance not found" });
        return;
      }
      // Idempotency: already approved → return existing.
      if (inst.currentState === "NEEDS_DEAL_FINALIZATION") {
        const prior = priorResolution(await listEventsByInstance(instanceId));
        res.json({
          instanceId,
          state: "NEEDS_DEAL_FINALIZATION",
          outcome: "NEEDS_DEAL_FINALIZATION",
          idempotent: true,
          ...prior,
        });
        return;
      }
      if (inst.currentState !== "MANUAL_REVIEW") {
        res.status(409).json({
          error: `instance is not in manual review (state: ${inst.currentState})`,
        });
        return;
      }
      // V1 scope: approve → operator onboarding, which only makes sense for an
      // operator_handoff execution. A local_payment creator routed to
      // NEEDS_DEAL_FINALIZATION would strand (no brief / payout is ever sent from
      // there) — reject or resolve via the payment flow instead. Full mode-branching
      // is PLU-155's onboarding job.
      if (inst.postAcceptanceMode !== "operator_handoff") {
        res.status(422).json({
          error:
            "approving a local-payment creator from Manual Review is not supported in V1 — " +
            "reject or resolve via the payment flow",
        });
        return;
      }

      // Validate the final fee against the PINNED band BEFORE opening any tx. The
      // snapshot is read-only (never written) so it stays immutable during MR.
      let campaignName: string | null = null;
      if (inst.negotiationPolicySnapshotId) {
        const snapshot = await findNegotiationPolicySnapshotById(inst.negotiationPolicySnapshotId);
        try {
          assertFeeWithinBand(terms, snapshot);
        } catch (err) {
          if (err instanceof BandViolationError) {
            res.status(422).json({
              error: err.message,
              hint: "pass terms.approvedDeviation:true to record an approved structured deviation",
            });
            return;
          }
          throw err;
        }
        if (snapshot) {
          const campaign = await findCampaignById(snapshot.campaignId);
          campaignName = campaign?.name ?? null;
        }
      }

      const creator = await findCreatorById(inst.creatorId);
      if (!creator) {
        res.status(404).json({ error: "creator not found" });
        return;
      }

      const resolutionReason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "approved";
      const updated = await resolveManualReviewCase(instanceId, {
        to: "NEEDS_DEAL_FINALIZATION",
        resolvedBy: body.resolvedBy.trim(),
        reason: resolutionReason,
        terms,
        creator: { name: creator.name, email: creator.email },
        campaignName,
      });

      // AFTER the commit: tell the operator the deal landed in
      // NEEDS_DEAL_FINALIZATION (stepInstance normally fires this, but this route
      // bypasses it). Best-effort — a notify failure does NOT undo the resolution.
      try {
        await notifyOperatorOfDealFinalization(emailProvider(), instanceId);
      } catch (err) {
        console.error(
          `[manual-queue] operator finalization notice failed for ${instanceId} (resolution stands):`,
          err instanceof Error ? err.message : err,
        );
      }

      res.json({
        instanceId,
        state: updated.currentState,
        outcome: "NEEDS_DEAL_FINALIZATION",
        reason: resolutionReason,
      });
    } catch (err) {
      if (err instanceof ManualReviewRaceError) {
        res.status(409).json({ error: "instance was concurrently modified — reload and retry" });
        return;
      }
      console.error("[manual-queue] approve error:", err);
      res.status(500).json({ error: "internal server error" });
    }
  },
);

// POST /manual-queue/instances/:instanceId/manual-review/reject
router.post("/instances/:instanceId/manual-review/reject", (req, res) =>
  handleSimpleResolution(req, res, "REJECTED", "rejected"),
);

// POST /manual-queue/instances/:instanceId/manual-review/opt-out
router.post("/instances/:instanceId/manual-review/opt-out", (req, res) =>
  handleSimpleResolution(req, res, "OPTED_OUT", "creator_withdrew"),
);

// ---------------------------------------------------------------------------
// GET /manual-queue/config — resolved default recipient (for the UI to display)
// ---------------------------------------------------------------------------

router.get("/config", (_req: Request, res: Response) => {
  res.json({
    defaultRecipient: resolveBrandRecipient(null),
    envOverride: process.env["BRAND_NOTIFY_EMAIL"]?.trim() || null,
  });
});

export default router;
