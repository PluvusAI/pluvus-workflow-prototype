// ---------------------------------------------------------------------------
// Job payload types for all Phase 4 queues
// ---------------------------------------------------------------------------

/**
 * Advance an execution instance by one step through the current node.
 *
 * idempotency key: `instanceId + expectedState`
 * The worker re-reads the instance state on entry and no-ops if it has already
 * moved past `expectedState`, so re-delivered jobs are harmless.
 */
export interface NodeExecutionJobData {
  instanceId: string;
  /**
   * The InstanceState the instance must be in for this job to execute.
   * If the instance is already in a different state when the job runs, it was
   * delivered more than once and the worker will skip it.
   */
  expectedState: string;
  /**
   * Opaque correlation id so each logical trigger produces exactly one job
   * even if the producer retries. BullMQ deduplicates on jobId.
   */
  triggerRef: string;
}

/**
 * Process an inbound email reply and advance the instance to REPLY_RECEIVED.
 *
 * idempotency key: `emailAccountId + externalMessageId`
 * Provider ids are grant-local. The worker checks the Message row in that
 * account's namespace before creating one, so a re-delivered job is a safe
 * no-op without colliding with another connected mailbox. Jobs without an
 * account remain in the account-less legacy/mock namespace.
 */
/**
 * Flush a reserved OUTBOUND message after a randomized delay (Randomized Send
 * Delay — §4.2). The reserved Message row is the durable outbox; this job carries
 * ONLY its id. The send context (recipient, reply target, campaign name) is
 * RELOADED at flush time (§4.1a), not carried on the job, so the job stays a thin
 * handle and a config change can't retro-alter an already-enqueued send.
 *
 * idempotency: the first-enqueue jobId is `send|<messageId>` (a pure function of
 * the stable reserved id → producer retries dedupe). The poller safety-net sweep
 * re-drives with a DISTINCT jobId `send|<messageId>|redrive-<n>` (§4.4). Neither
 * jobId is the exactly-once guarantee — that is the per-send lock + post-lock NULL
 * re-check in flushOutbound (§4.2a).
 */
export interface DelayedSendJobData {
  /** The reserved Message DB row id to flush. */
  messageId: string;
}

export interface InboundEmailJobData {
  instanceId: string;
  /** The Nylas (or mock) message id — unique within emailAccountId. */
  externalMessageId: string;
  /** Connected mailbox/grant namespace. Absent only for legacy/mock intake. */
  emailAccountId?: string;
  threadId: string;
  subject: string;
  body: string;
  /**
   * The From: address of the inbound message. Carried from the webhook for
   * audit/correlation of the reply. Optional: the mocked injection path (queues
   * route / harness) omits it, and a real webhook may occasionally lack a
   * parseable from.
   */
  senderEmail?: string;
  /**
   * Declared reply intent for Phase 4 (mocked).
   * Phase 6: real Nylas-webhook-originated jobs OMIT this field — the webhook
   * only ingests and correlates, it does not classify. The worker currently
   * defaults the intent to POSITIVE when absent; Phase 7 replaces that default
   * with a real LangGraph classify call. The field stays optional so both the
   * mocked-injection path (queues route / harness) and the real webhook path
   * share one job type.
   */
  mockIntent?: string;
}
