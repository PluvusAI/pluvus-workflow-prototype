import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { QUEUE_INBOUND_EMAIL, enqueueNodeExecution, workerConcurrency } from "./queues.js";
import type { InboundEmailJobData } from "./jobs.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { findInstanceById, findMessageByExternalId, markMessageProcessed } from "../db/index.js";
import { isTerminal } from "../engine/stateMachine.js";
import { replyIntentEnum, type ReplyIntent } from "../db/schema.js";
import { acquireLock, releaseLock } from "../scheduler/lock.js";
import { deadLetterIfExhausted } from "./deadLetter.js";

// ---------------------------------------------------------------------------
// InboundEmail worker
// ---------------------------------------------------------------------------
// Processes an inbound email reply:
//   1. Idempotency — skip if the externalMessageId was already processed.
//   2. Lock — per-instance Redis lock (optimization; OCC is the guarantee).
//   3. injectReply — persists the INBOUND Message row + transitions to REPLY_RECEIVED.
//   4. stepInstance — runs executeReplyDetection, which calls the classification
//      provider (mock keyword-based or real LangGraph) and routes to
//      NEGOTIATING / REJECTED / OPTED_OUT / MANUAL_REVIEW.
//
// Phase 7: mockIntent (from harness / manual queue injections) still bypasses
// the classification provider so existing harnesses are unaffected. When
// mockIntent is absent (real Nylas webhook path), the agentProvider routes
// through the ClassificationProvider abstraction.

// H2: DERIVE the allowlist from the single source of truth (the Drizzle enum)
// instead of hand-maintaining a parallel list. A hardcoded copy here drifted from
// the enum — it omitted DEFERRED — so a harness/manual-queue injection of
// mockIntent:"DEFERRED" silently resolved to undefined (→ real-classify path)
// instead of the deferred route. This is the same drift class that once degraded
// every real DEFERRED reply to MANUAL_REVIEW (fixed in 65897d1). Deriving here
// makes it structurally impossible: a new enum member is accepted automatically.
// Exported so the H2 drift-guard test can assert it equals the enum (see
// adapters/classification/LangGraphClassificationProvider.intents.test.ts).
export const VALID_INTENTS: readonly ReplyIntent[] = replyIntentEnum.enumValues;

function resolveIntent(raw?: string): ReplyIntent | undefined {
  if (raw && (VALID_INTENTS as readonly string[]).includes(raw)) {
    return raw as ReplyIntent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

async function handleInboundEmail(
  job: Job<InboundEmailJobData>,
): Promise<void> {
  // senderEmail is carried on the job for audit/correlation but no longer consumed
  // here: it was only used to verify a brand-decision reply's sender identity, and
  // escalations are now terminal MANUAL_REVIEW (#14) with no reply handling.
  const {
    instanceId,
    externalMessageId,
    emailAccountId,
    threadId,
    subject,
    body,
    mockIntent,
  } = job.data;

  const instance = await findInstanceById(instanceId);
  if (!instance) {
    console.warn(`[inbound-email] instance not found: ${instanceId} (job ${job.id})`);
    return;
  }

  // The webhook's account id is authoritative for a modern delivery. It must
  // agree with the immutable run pin when both exist; processing a mismatched
  // manually-forged/stale job would move a reply across mailbox boundaries.
  if (
    emailAccountId &&
    instance.emailAccountId &&
    emailAccountId !== instance.emailAccountId
  ) {
    throw new Error(
      `[inbound-email] account mismatch for ${instanceId}: job=${emailAccountId}, ` +
        `instance=${instance.emailAccountId}`,
    );
  }
  const effectiveEmailAccountId =
    emailAccountId ?? instance.emailAccountId ?? undefined;

  // ── Idempotency check ───────────────────────────────────────────────────
  // CRITICAL-6 (b): skip ONLY when the reply was fully PROCESSED (processedAt
  // set), not merely persisted. The old check short-circuited on row existence,
  // so if a prior attempt persisted the Message row and then crashed before
  // advancing the instance (or hit a post-persist error), every retry no-op'd and
  // the reply was permanently stranded. A persisted-but-unprocessed row now falls
  // through to be re-processed (the persist step itself is idempotent on the
  // unique externalMessageId — see below).
  const existing = await findMessageByExternalId(
    externalMessageId,
    effectiveEmailAccountId,
  );
  if (existing?.processedAt) {
    console.log(
      `[inbound-email] skip — message ${externalMessageId} already processed (job ${job.id})`,
    );
    return;
  }
  // Outbound-echo guard (belt-and-suspenders behind the webhook's own guard):
  // a message we SENT shares its externalMessageId with the provider's webhook
  // echo. Processing it as an inbound reply would flip AWAITING_REPLY →
  // REPLY_RECEIVED with no human reply (the "phantom reply"). The processedAt
  // check above misses it because an outbound row is never processed as inbound,
  // so guard on direction explicitly. Never inject an outbound message as a reply.
  if (existing?.direction === "OUTBOUND") {
    console.log(
      `[inbound-email] skip — message ${externalMessageId} is our own outbound echo (job ${job.id})`,
    );
    return;
  }
  // NB: a persisted-but-unprocessed row (existing != null, processedAt == null)
  // falls through — the persist step below is idempotent on externalMessageId
  // (persistInboundMessageOnce), so re-processing after a crash never double-inserts.

  if (isTerminal(instance.currentState)) {
    console.log(
      `[inbound-email] skip — instance ${instanceId} already terminal (${instance.currentState}) (job ${job.id})`,
    );
    return;
  }

  // ── Acquire instance lock ────────────────────────────────────────────────
  // CRITICAL-6 (a): a busy lock must THROW, not return success. The old code
  // logged "skip" and returned — which COMPLETES the BullMQ job, so the inbound
  // reply was never persisted and never retried: silently and permanently lost.
  // Throwing lets BullMQ retry with backoff once the other worker releases the
  // lock. HARD-R2's fencing token means the retry can't collide with the holder.
  const lockToken = await acquireLock(instanceId);
  if (!lockToken) {
    throw new Error(
      `[inbound-email] lock busy for ${instanceId} (job ${job.id}) — throwing to force BullMQ retry (reply must not be dropped)`,
    );
  }

  // Phase 7: resolveIntent returns undefined when mockIntent is absent (real
  // webhook path). agentProvider with no replyIntent routes through the
  // ClassificationProvider (mock keyword-based or real LangGraph).
  const intent = resolveIntent(mockIntent);
  console.log(
    `[inbound-email] processing reply for ${instanceId} (state: ${instance.currentState}, classification: ${intent ?? "real"}) (job ${job.id})`,
  );

  const runtime = new WorkflowRuntime(
    emailProvider(),
    agentProvider(intent !== undefined ? { replyIntent: intent } : {}),
  );

  // CRITICAL-6: only mark the reply PROCESSED when a branch completes without an
  // unhandled throw. On success (or an OCC conflict, which means the reply is
  // being/was handled by the winning worker) we set `processed = true` and stamp
  // processedAt in the finally. If a branch throws unexpectedly, processed stays
  // false, processedAt is left NULL, and BullMQ retries re-process the persisted
  // row rather than the idempotency check skipping it (the old lost-reply bug).
  let processed = false;

  try {
    // ── Reward Setup reply branch ──────────────────────────────────────────
    // A reply that arrives while the instance is in REWARD_PENDING is the
    // creator confirming (or not) the finalized agreement — NOT a first reply
    // and NOT a negotiation turn. Route it to the Reward Setup reply handler,
    // which persists the message, classifies agreement, and advances to
    // REWARD_CONFIRMED (or keeps waiting). This bypasses injectReply's forced
    // REPLY_RECEIVED transition, which is invalid from REWARD_PENDING.
    if (instance.currentState === "REWARD_PENDING") {
      try {
        await runtime.handleRewardReply(instanceId, {
          subject,
          body,
          threadId,
          externalMessageId,
          ...(effectiveEmailAccountId ? { emailAccountId: effectiveEmailAccountId } : {}),
          worker: "inbound-email",
          queueJobId: job.id,
        });
      } catch (err) {
        if (err instanceof StaleInstanceError) {
          console.log(
            `[inbound-email] OCC conflict on handleRewardReply — ${err.message} (job ${job.id})`,
          );
          processed = true; // handled by the winning worker — don't retry-loop
          return;
        }
        throw err;
      }
      processed = true;

      // The agreement reply may have advanced the instance to REWARD_CONFIRMED.
      // That transition happens here (inbound worker), not via a node-execution
      // job, so the node-execution worker's auto-chain never sees it. Enqueue the
      // Payment Info step from here so a confirmed agreement flows straight into
      // the payout-form email (guarded for legacy graphs without a PAYMENT_INFO
      // node, which leave REWARD_CONFIRMED terminal).
      const afterReward = await findInstanceById(instanceId);
      if (
        afterReward?.currentState === "REWARD_CONFIRMED" &&
        (await runtime.paymentInfoApplies(instanceId))
      ) {
        await enqueueNodeExecution({
          instanceId,
          expectedState: "REWARD_CONFIRMED",
          triggerRef: `auto-payment-info-${instanceId}`,
        });
        console.log(
          `[inbound-email] auto-enqueued payment-info step for ${instanceId} (REWARD_CONFIRMED)`,
        );
      }
      return;
    }

    // (An escalated instance is now terminal MANUAL_REVIEW (#14) — a reply to it
    // is dropped by the isTerminal guard at the top of this handler, so there is
    // no brand-decision reply branch here anymore.)

    // ── Deal-handoff reply branch (PLU-70) ─────────────────────────────────
    // A reply arriving in NEEDS_DEAL_FINALIZATION is the creator answering the
    // "I'm looping in our campaign manager" note. An OPERATOR owns this thread
    // now, so we do NOT classify, negotiate, transition, or auto-reply — an
    // automated answer would cut across a human mid-conversation. We persist the
    // message (it shows in the inspector's thread) and forward it to the operator
    // so a plain "reply" reaches them just as a "reply all" would.
    //
    // This branch is load-bearing, not cosmetic: without it the reply falls
    // through to injectReply, whose forced REPLY_RECEIVED transition is invalid
    // from NEEDS_DEAL_FINALIZATION — it would throw after persisting the row and
    // BullMQ would retry-loop on every delivery.
    if (instance.currentState === "NEEDS_DEAL_FINALIZATION") {
      await runtime.recordHandoffReply(instanceId, {
        subject,
        body,
        threadId,
        externalMessageId,
        ...(effectiveEmailAccountId ? { emailAccountId: effectiveEmailAccountId } : {}),
      });
      processed = true;
      return;
    }

    // ── Payment Info reply branch ──────────────────────────────────────────
    // A reply that arrives while the instance is in PAYMENT_PENDING is an email
    // sent while we're waiting on the creator's hosted payout FORM — usually a
    // question or a re-negotiation attempt, NOT the form. Route it to the payment
    // reply handler, which sends the "rate is fixed" auto-reply (redirecting to
    // the form) and keeps the instance in PAYMENT_PENDING. This bypasses
    // injectReply's forced REPLY_RECEIVED transition, which is invalid here.
    if (instance.currentState === "PAYMENT_PENDING") {
      try {
        await runtime.handlePaymentReply(instanceId, {
          subject,
          body,
          threadId,
          externalMessageId,
          ...(effectiveEmailAccountId ? { emailAccountId: effectiveEmailAccountId } : {}),
          worker: "inbound-email",
          queueJobId: job.id,
        });
      } catch (err) {
        if (err instanceof StaleInstanceError) {
          console.log(
            `[inbound-email] OCC conflict on handlePaymentReply — ${err.message} (job ${job.id})`,
          );
          processed = true; // handled by the winning worker — don't retry-loop
          return;
        }
        throw err;
      }
      processed = true;
      return;
    }

    // ── Content-links reply branch ─────────────────────────────────────────
    // A reply that arrives while the instance is in CONTENT_LINKS_PENDING is the
    // creator sharing the link(s) to their published content (or a question / "not
    // live yet"). Route it to the content-links reply handler, which extracts URLs
    // and escalates to MANUAL_REVIEW when present, or nudges and stays waiting when
    // absent. This bypasses injectReply's forced REPLY_RECEIVED transition, which
    // is invalid from CONTENT_LINKS_PENDING.
    if (instance.currentState === "CONTENT_LINKS_PENDING") {
      try {
        await runtime.handleContentLinksReply(instanceId, {
          subject,
          body,
          threadId,
          externalMessageId,
          ...(effectiveEmailAccountId ? { emailAccountId: effectiveEmailAccountId } : {}),
          worker: "inbound-email",
          queueJobId: job.id,
        });
      } catch (err) {
        if (err instanceof StaleInstanceError) {
          console.log(
            `[inbound-email] OCC conflict on handleContentLinksReply — ${err.message} (job ${job.id})`,
          );
          processed = true; // handled by the winning worker — don't retry-loop
          return;
        }
        throw err;
      }
      processed = true;
      return;
    }

    try {
      await runtime.injectReply(instanceId, {
        subject,
        body,
        threadId,
        externalMessageId,
        ...(effectiveEmailAccountId ? { emailAccountId: effectiveEmailAccountId } : {}),
      });
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        console.log(`[inbound-email] OCC conflict on injectReply — ${err.message} (job ${job.id})`);
        processed = true; // handled by the winning worker — don't retry-loop
        return;
      }
      throw err;
    }

    // stepInstance runs executeReplyDetection → classifies → transitions.
    // Source is left to be inferred from the emitted event (REPLY_CLASSIFIED →
    // classification-agent) so the timeline attributes the decision to the
    // agent, not the worker; worker/job are still recorded for traceability.
    try {
      await runtime.stepInstance(instanceId, {
        worker: "inbound-email",
        queueJobId: job.id,
      });
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        console.log(`[inbound-email] OCC conflict on stepInstance — ${err.message} (job ${job.id})`);
        processed = true; // handled by the winning worker — don't retry-loop
        return;
      }
      throw err;
    }
    processed = true;
  } finally {
    // CRITICAL-6: stamp processedAt only on a clean completion (or OCC conflict).
    // Released the lock first so the mark can't extend lock-hold time. If a branch
    // threw, `processed` is false and the reply stays re-processable on retry.
    await releaseLock(instanceId, lockToken);
    if (processed) {
      await markMessageProcessed(externalMessageId, effectiveEmailAccountId);
    }
  }

  const updated = await findInstanceById(instanceId);
  const newState = updated?.currentState ?? "unknown";
  console.log(
    `[inbound-email] done — ${instanceId}: REPLY_RECEIVED → ${newState} (job ${job.id})`,
  );

  // Reply detection classified the reply and landed on NEGOTIATING.
  // Enqueue a node-execution job to run the negotiation executor immediately
  // so the agent sends a response without waiting for a manual trigger.
  //
  // The triggerRef (→ BullMQ jobId) MUST be unique per reply, not per round.
  // A PRESENT_OFFER turn (answering a "what's the rate?" question) deliberately
  // does NOT increment negotiationRound, so two distinct replies can both occur
  // at the same round. Keying the job on the round alone would collide with the
  // earlier (completed) round-N job and BullMQ would silently drop the add —
  // stranding the instance at NEGOTIATING. Keying on the inbound message id (one
  // per reply) makes every reply enqueue its own negotiation step.
  if (newState === "NEGOTIATING") {
    await enqueueNodeExecution({
      instanceId,
      expectedState: "NEGOTIATING",
      triggerRef: `auto-negotiate-${instanceId}-msg-${externalMessageId}`,
    });
    console.log(
      `[inbound-email] auto-enqueued negotiation step for ${instanceId} (reply ${externalMessageId})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

// HARD-S1: per-worker concurrency is env-tunable (WORKER_CONCURRENCY /
// INBOUND_EMAIL_CONCURRENCY) so the inbound-reply fleet can be scaled to load.
export function createInboundEmailWorker(): Worker<InboundEmailJobData> {
  const concurrency = workerConcurrency("INBOUND_EMAIL_CONCURRENCY");
  const worker = new Worker<InboundEmailJobData>(
    QUEUE_INBOUND_EMAIL,
    handleInboundEmail,
    {
      connection: redisConnection(),
      concurrency,
    },
  );
  console.log(`[inbound-email] worker started (concurrency ${concurrency})`);

  worker.on("failed", (job, err) => {
    console.error(
      `[inbound-email] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}/${job?.opts?.attempts ?? "?"}):`,
      err.message,
    );
    // BUG-Q1/Q2: on the final exhausted attempt, persist the job durably. This is
    // the ONLY recovery path for a lost creator reply — the inbound re-drive sweep
    // re-enqueues it (an AWAITING_REPLY instance is otherwise unreachable).
    void deadLetterIfExhausted(QUEUE_INBOUND_EMAIL, job, err);
  });

  worker.on("error", (err) => {
    console.error("[inbound-email] worker error:", err.message);
  });

  return worker;
}
