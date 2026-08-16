import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import type {
  NodeExecutionJobData,
  InboundEmailJobData,
  DelayedSendJobData,
  CampaignBriefRenderJobData,
} from "./jobs.js";

// ---------------------------------------------------------------------------
// Queue names — single source of truth
// ---------------------------------------------------------------------------

export const QUEUE_NODE_EXECUTION = "node-execution";
export const QUEUE_INBOUND_EMAIL = "inbound-email";
// Randomized Send Delay (§4.2): delayed flush of reserved OUTBOUND AI replies.
export const QUEUE_DELAYED_SEND = "delayed-send";
// PLU-139 §6: async CampaignBrief rendering — Puppeteer can crash the whole
// worker process, so this must never run inline in an HTTP handler.
export const QUEUE_CAMPAIGN_BRIEF_RENDER = "campaign-brief-render";

// ---------------------------------------------------------------------------
// Worker concurrency (HARD-S1)
// ---------------------------------------------------------------------------
// Concurrency was hardcoded to 5/worker/process, so the whole system's LLM
// throughput was pinned regardless of how many replicas ran or how much agent-
// service capacity existed. HARD-A1 (Batch 1) split the process topology so a
// worker fleet can scale horizontally (PROCESS_ROLE=worker); this makes the
// PER-WORKER concurrency tunable too, so a fleet can be sized to the agent
// service's real capacity (each in-flight step holds a slot for a 45-120s LLM
// call, so the right number is capacity-matched, not a constant).
//
//   WORKER_CONCURRENCY               — default for both workers (default 5)
//   NODE_EXECUTION_CONCURRENCY       — override for the node-execution worker
//   INBOUND_EMAIL_CONCURRENCY        — override for the inbound-email worker
//
// Load-test note (the acceptance criterion, NOT satisfied by this diff): reaching
// 1,000 concurrent requires a multi-replica worker deployment + a capacity-matched
// agent service, then a load test proving it. This code makes the knob exist;
// the score only moves once that deployment + load evidence exist.
const DEFAULT_WORKER_CONCURRENCY = 5;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function workerConcurrency(specificEnv?: string): number {
  const base = positiveEnvInt("WORKER_CONCURRENCY", DEFAULT_WORKER_CONCURRENCY);
  return specificEnv ? positiveEnvInt(specificEnv, base) : base;
}

// PLU-139 §6: the brief-render worker does NOT inherit WORKER_CONCURRENCY's
// default of 5 the way every other worker's `specificEnv` override does
// (workerConcurrency() above falls back to the shared default when the
// specific env is unset) — each concurrent job here is a full headless
// Chromium instance, a meaningfully different memory footprint than 5
// concurrent node-execution jobs. CAMPAIGN_BRIEF_RENDER_CONCURRENCY has its
// OWN low default (2), independent of WORKER_CONCURRENCY.
const DEFAULT_CAMPAIGN_BRIEF_RENDER_CONCURRENCY = 2;

export function campaignBriefRenderConcurrency(): number {
  return positiveEnvInt("CAMPAIGN_BRIEF_RENDER_CONCURRENCY", DEFAULT_CAMPAIGN_BRIEF_RENDER_CONCURRENCY);
}

// ---------------------------------------------------------------------------
// Default retry / backoff configuration
// ---------------------------------------------------------------------------
// 3 attempts: immediate → 5 s → 25 s (exponential, base 5 s)

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 5_000,
  },
  // Remove completed jobs after 24 h to keep Redis lean
  removeOnComplete: { age: 86_400 },
  // BUG-Q1: the durable record of an exhausted job is the DeadLetterJob row
  // written by on("failed"); Redis is NOT the system of record for failures. But
  // the old removeOnFail{count:100} evicted the 101st failure from Redis — and if
  // that eviction raced ahead of the async DLQ write, the job vanished before it
  // was recorded. Keep failed jobs generously (age + a high count) so the DLQ
  // write always wins, and a human can still inspect the raw failed job in Redis.
  removeOnFail: { age: 7 * 86_400, count: 10_000 },
};

// ---------------------------------------------------------------------------
// Queue singletons — lazy-initialized, one per process
// ---------------------------------------------------------------------------
// Using `any` for the generic workaround: BullMQ v5 with exactOptionalPropertyTypes
// produces a spurious error when the Queue data type is inferred through the
// new ExtractDataType conditional. Casting to `Queue<T>` after construction
// is safe because add() is called with explicit typed data.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nodeExecutionQueue: Queue<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _inboundEmailQueue: Queue<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _delayedSendQueue: Queue<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _campaignBriefRenderQueue: Queue<any> | undefined;

export function getNodeExecutionQueue(): Queue<NodeExecutionJobData> {
  if (!_nodeExecutionQueue) {
    _nodeExecutionQueue = new Queue(QUEUE_NODE_EXECUTION, {
      connection: redisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _nodeExecutionQueue as Queue<NodeExecutionJobData>;
}

export function getInboundEmailQueue(): Queue<InboundEmailJobData> {
  if (!_inboundEmailQueue) {
    _inboundEmailQueue = new Queue(QUEUE_INBOUND_EMAIL, {
      connection: redisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _inboundEmailQueue as Queue<InboundEmailJobData>;
}

export function getDelayedSendQueue(): Queue<DelayedSendJobData> {
  if (!_delayedSendQueue) {
    _delayedSendQueue = new Queue(QUEUE_DELAYED_SEND, {
      connection: redisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _delayedSendQueue as Queue<DelayedSendJobData>;
}

export function getCampaignBriefRenderQueue(): Queue<CampaignBriefRenderJobData> {
  if (!_campaignBriefRenderQueue) {
    // PLU-139 §6 open question #5: reuses the shared DEFAULT_JOB_OPTIONS
    // (3 attempts, exponential backoff from 5s) rather than a bespoke
    // retry policy — a single transient failure (a momentary resource
    // spike) shouldn't need a human to intervene, and §6b's stale-render
    // sweep is the real backstop for the "worker process died" case that
    // `attempts` can't help with either way (a dead process can't retry
    // itself). Flagged explicitly in the plan doc rather than inherited
    // silently, since this is the one queue where "just reuse what
    // everything else uses" isn't obviously correct by analogy alone.
    _campaignBriefRenderQueue = new Queue(QUEUE_CAMPAIGN_BRIEF_RENDER, {
      connection: redisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _campaignBriefRenderQueue as Queue<CampaignBriefRenderJobData>;
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a node-execution job.
 *
 * jobId uses | as separator (BullMQ v5 disallows : in custom jobIds).
 * BullMQ deduplicates on jobId within the active+waiting set, so a duplicate
 * enqueue from a retrying producer is a no-op.
 */
export async function enqueueNodeExecution(
  data: NodeExecutionJobData,
): Promise<void> {
  const queue = getNodeExecutionQueue();
  const jobId = `node-exec|${data.instanceId}|${data.expectedState}|${data.triggerRef}`;
  await queue.add("advance", data, { jobId });
}

/**
 * Enqueue an inbound-email job.
 *
 * jobId uses | as separator (BullMQ v5 disallows : in custom jobIds).
 * Guarantees exactly one processing attempt per unique inbound message even if
 * the producer retries.
 */
export async function enqueueInboundEmail(
  data: InboundEmailJobData,
): Promise<void> {
  const queue = getInboundEmailQueue();
  const jobId = inboundEmailJobId(data);
  await queue.add("reply", data, { jobId });
}

/**
 * BullMQ dedupe key for one provider-account message namespace. Keep the exact
 * legacy shape when no account is supplied so already-enqueued/dead-lettered
 * single-mailbox jobs remain compatible. Modern account-scoped components are
 * URI-encoded so a provider id containing `|` cannot alias another tuple.
 */
export function inboundEmailJobId(
  data: Pick<InboundEmailJobData, "emailAccountId" | "externalMessageId">,
): string {
  if (!data.emailAccountId) return `inbound|${data.externalMessageId}`;
  return (
    `inbound|account|${encodeURIComponent(data.emailAccountId)}` +
    `|message|${encodeURIComponent(data.externalMessageId)}`
  );
}

/**
 * Enqueue a delayed flush of a reserved OUTBOUND row (Randomized Send Delay
 * §4.2). `delayMs` is BullMQ-native: the job is invisible to workers until
 * `now + delayMs`, then becomes waiting. Redis persists it across restarts.
 *
 * jobId (BullMQ v5 disallows : — use |):
 *   - FIRST enqueue: `send|<messageId>` (default). A pure function of the stable
 *     reserved id, so a producer (node-execution) retry re-adds the identical id
 *     and BullMQ dedupes → exactly one delayed job (§4.6).
 *   - SWEEP re-drive: the caller passes `send|<messageId>|redrive-<n>` (§4.4). A
 *     DISTINCT id is REQUIRED because BullMQ v5 `add()` with an existing custom
 *     jobId is a no-op returning the existing job — it will NOT promote/replace a
 *     delayed-or-failed job. Exactly-once is still preserved by the per-send lock
 *     + post-lock NULL re-check in flushOutbound, not by the jobId.
 *
 * `delayMs` defaults to 0 (disabled-mode / degenerate window → flush ASAP, still
 * via the queue+worker — NOT a synchronous bypass, §4.5).
 */
export async function enqueueDelayedSend(
  data: DelayedSendJobData,
  delayMs = 0,
  jobId = `send|${data.messageId}`,
): Promise<void> {
  const queue = getDelayedSendQueue();
  await queue.add("flush", data, { jobId, delay: Math.max(0, Math.floor(delayMs)) });
}

/**
 * Enqueue a CampaignBrief render job. jobId is keyed on `campaignBriefId`
 * (the row THIS job exists to complete), NOT `campaignId` or
 * `renderRequestId` — see CampaignBriefRenderJobData's doc comment. BullMQ
 * dedupes on jobId, so a producer retry (the route calling this again after
 * an ambiguous failure) is a safe no-op against the same row.
 */
export async function enqueueCampaignBriefRender(
  data: CampaignBriefRenderJobData,
): Promise<void> {
  const queue = getCampaignBriefRenderQueue();
  const jobId = `brief-render|${data.campaignBriefId}`;
  await queue.add("render", data, { jobId });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function closeQueues(): Promise<void> {
  await Promise.all([
    _nodeExecutionQueue?.close(),
    _inboundEmailQueue?.close(),
    _delayedSendQueue?.close(),
    _campaignBriefRenderQueue?.close(),
  ]);
}
