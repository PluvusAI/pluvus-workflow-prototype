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
} from "../db/index.js";

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
  const isInitialOutreach = message?.idempotencyKey?.startsWith("outreach:") ?? false;

  if (isInitialOutreach) {
    // The campaign row lock inside this claim serializes all concurrent workers
    // for a campaign. The claim is the strict "accepted for dispatch" boundary:
    // it consumes one daily slot before the provider call, and Message's claim
    // marker makes provider retries idempotent.
    const claim = await claimInitialOutreachSlot(messageId);
    if (claim.status === "suppress") {
      // PLU-153: campaign is Closing/Archived — drop the job, never send. The
      // Message row stays reserved-but-unsent (no externalMessageId) and the
      // instance parks in OUTREACH_QUEUED. Terminal, not a retry: PLU-156
      // reconciles these instances. Returning completes the job cleanly.
      console.log(
        `[delayed-send] suppressed initial outreach ${messageId} — campaign ${claim.reason} (job ${job.id})`,
      );
      return;
    }
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
