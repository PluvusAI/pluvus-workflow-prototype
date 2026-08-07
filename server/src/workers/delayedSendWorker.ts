import { DelayedError, Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import {
  QUEUE_DELAYED_SEND,
  enqueueNodeExecution,
  workerConcurrency,
} from "./queues.js";
import type { DelayedSendJobData } from "./jobs.js";
import { emailProvider } from "../engine/providerFactory.js";
import { flushOutbound } from "../engine/executors/idempotentSend.js";
import { deadLetterIfExhausted } from "./deadLetter.js";
import {
  claimInitialOutreachSlot,
  completeQueuedInitialOutreach,
  findMessageById,
  findInstanceById,
  scheduleNegotiationFollowUpAfterSend,
} from "../db/index.js";
import { findVersionById, findWorkflowById } from "../db/workflows.js";
import { findCampaignById } from "../db/campaigns.js";
import { mergeCampaignFallback } from "../engine/campaignContext.js";
import {
  negotiationFollowUpEnabled,
  resolveNegotiationFollowUpIntervalMs,
} from "../engine/executors/negotiation.js";
import type { NodeSnapshot } from "../engine/types.js";

const NEGOTIATION_OUTBOUND_PREFIXES = ["negotiation:present:", "negotiation:counter_offer:"];
const NEGOTIATION_FOLLOWUP_PREFIX = "negotiation-followup:";

// PLU-110: the NEGOTIATION node config (+ campaign fallback) for an instance, so
// the flush hook can read the follow-up enable/intervals. Best-effort: any lookup
// gap ⇒ null ⇒ no follow-up armed.
async function loadNegotiationNodeConfig(
  instanceId: string,
): Promise<Record<string, unknown> | null> {
  const instance = await findInstanceById(instanceId);
  if (!instance) return null;
  const version = await findVersionById(instance.workflowVersionId);
  if (!version) return null;
  const nodeGraph = version.nodeGraph as unknown as NodeSnapshot[];
  const negotiationNode = nodeGraph.find((n) => n.type === "NEGOTIATION");
  if (!negotiationNode) return null;
  let campaign = null;
  try {
    const workflow = await findWorkflowById(version.workflowId);
    if (workflow?.campaignId) campaign = await findCampaignById(workflow.campaignId);
  } catch {
    campaign = null;
  }
  return mergeCampaignFallback(negotiationNode.config, campaign);
}

// PLU-110: after a negotiation send confirms, arm the next follow-up deadline.
// A present/counter arms the FIRST follow-up (index 0); a follow-up send arms the
// NEXT (index = the freshly-read, post-increment negotiationFollowUpCount).
async function armNegotiationFollowUp(instanceId: string, messageId: string, key: string): Promise<void> {
  const config = await loadNegotiationNodeConfig(instanceId);
  if (!config || !negotiationFollowUpEnabled(config)) return;

  let attemptIndex = 0;
  if (key.startsWith(NEGOTIATION_FOLLOWUP_PREFIX)) {
    const instance = await findInstanceById(instanceId);
    if (!instance) return;
    attemptIndex = instance.negotiationFollowUpCount;
  }

  const intervalMs = resolveNegotiationFollowUpIntervalMs(config, attemptIndex);
  const result = await scheduleNegotiationFollowUpAfterSend(messageId, intervalMs);
  console.log(`[delayed-send] negotiation follow-up arm ${messageId} → ${result}`);
}

// ---------------------------------------------------------------------------
// DelayedSend worker (Randomized Send Delay — §4.2, §6.6)
// ---------------------------------------------------------------------------
// Flushes a reserved OUTBOUND row after its randomized delay elapses. The delay
// itself is BullMQ-native ({ delay } on enqueue); this worker only runs once the
// job becomes `waiting`, so its job is simply: flushOutbound(messageId).
//
// Exactly-once on this path is NOT free from the unique externalMessageId (that
// column is written only AFTER the send returns). flushOutbound closes the
// send→finalize gap with a per-send lock + a post-lock NULL re-check (§4.2a), so
// a flush RETRY and the poller safety-net sweep (§4.4) can both target one row
// and still send at most once — the loser sees the finalized row and no-ops.
//
// CRITICAL (§4.5): this worker MUST run even when SEND_DELAY_ENABLED=false. In
// that mode the send is enqueued with delay 0, but it STILL routes through this
// queue+worker — disabling is delay-0, not a synchronous bypass. A process that
// reserves a delayed send without running this worker (or a poller sweep) strands
// the send. It is therefore registered at EVERY worker-startup site alongside the
// node-execution + inbound-email workers.

// Email provider (shared across all jobs in this worker process), chosen by
// EMAIL_PROVIDER via the factory — the same instance the node-execution worker
// uses, so a delayed flush sends exactly as an inline send would have.
const email = emailProvider();

async function handleDelayedSend(job: Job<DelayedSendJobData>): Promise<void> {
  const { messageId } = job.data;
  const startedAt = Date.now();
  const message = await findMessageById(messageId);
  const key = message?.idempotencyKey ?? "";
  const isInitialOutreach = key.startsWith("outreach:");
  const isNegotiationSend =
    NEGOTIATION_OUTBOUND_PREFIXES.some((p) => key.startsWith(p)) ||
    key.startsWith(NEGOTIATION_FOLLOWUP_PREFIX);

  if (isInitialOutreach) {
    // The campaign row lock inside this claim serializes all concurrent workers
    // for a campaign. The claim is the strict "accepted for dispatch" boundary:
    // it consumes one daily slot before the provider call, and Message's claim
    // marker makes provider retries idempotent.
    const claim = await claimInitialOutreachSlot(messageId);
    if (claim.status === "defer") {
      const retryAt = Math.max(Date.now() + 1_000, claim.retryAt.getTime());
      await job.moveToDelayed(retryAt, job.token);
      console.log(
        `[delayed-send] deferred outreach ${messageId} (${claim.reason}) until ` +
          `${new Date(retryAt).toISOString()} (job ${job.id})`,
      );
      // BullMQ requires this sentinel after manually moving an active job. It
      // prevents the worker from trying to mark the now-delayed job completed.
      throw new DelayedError();
    }
  }

  // flushOutbound reloads the full send context from the id (§4.1a), takes the
  // per-send lock, and re-checks NULL — so it is safe to call on a retry or on a
  // row a concurrent sweep is also targeting. A throw here (transient Nylas
  // failure) surfaces to BullMQ and the job retries per DEFAULT_JOB_OPTIONS.
  const result = await flushOutbound(email, messageId);

  const elapsed = Date.now() - startedAt;
  if (result.skipped) {
    console.log(
      `[delayed-send] ${messageId} already sent / claimed by another flusher — no-op (job ${job.id})`,
    );
  } else {
    console.log(
      `[delayed-send] flushed ${messageId} → ${result.messageId} after ${elapsed}ms (job ${job.id})`,
    );
  }

  if (isInitialOutreach) {
    const completion = await completeQueuedInitialOutreach(messageId);
    if (completion === "completed" || completion === "already_completed") {
      await enqueueNodeExecution({
        instanceId: message!.instanceId,
        expectedState: "OUTREACH_SENT",
        triggerRef: `outreach-delivered-${messageId}`,
      });
      console.log(
        `[delayed-send] outreach ${messageId} delivered; queued follow-up lifecycle ` +
          `(instance ${message!.instanceId})`,
      );
    }
  }

  // PLU-110: a confirmed negotiation send (present/counter/follow-up) arms the
  // next inactivity deadline from sentAt. Runs on retries too — the DB helper's
  // sentAt/dueAt gates make it idempotent. Best-effort: a failure never fails the
  // send.
  if (isNegotiationSend && message) {
    try {
      await armNegotiationFollowUp(message.instanceId, messageId, key);
    } catch (err) {
      console.error(
        `[delayed-send] negotiation follow-up arm failed for ${messageId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createDelayedSendWorker(): Worker<DelayedSendJobData> {
  const concurrency = workerConcurrency("DELAYED_SEND_CONCURRENCY");
  const worker = new Worker<DelayedSendJobData>(
    QUEUE_DELAYED_SEND,
    handleDelayedSend,
    {
      connection: redisConnection(),
      concurrency,
    },
  );
  console.log(`[delayed-send] worker started (concurrency ${concurrency})`);

  worker.on("failed", (job, err) => {
    console.error(
      `[delayed-send] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}/${job?.opts?.attempts ?? "?"}):`,
      err.message,
    );
    // On the final exhausted attempt, persist the job durably (DLQ) so a
    // permanently-failing flush survives Redis eviction and can be inspected. The
    // poller safety-net sweep is the OTHER recovery path (a lost/dead-lettered job
    // leaves the row reserved-but-unsent), bounded by redriveCount (§4.4).
    void deadLetterIfExhausted(QUEUE_DELAYED_SEND, job, err);
  });

  worker.on("error", (err) => {
    console.error("[delayed-send] worker error:", err.message);
  });

  return worker;
}
