// ---------------------------------------------------------------------------
// Structured transition logging (Phase 9, Part 9)
// ---------------------------------------------------------------------------
// Every state transition in the engine must be traceable end-to-end. This
// module emits a single structured JSON line per transition with a stable
// shape so logs can be grepped, shipped to a log aggregator, or correlated by
// instanceId / queueJobId.
//
// The same `source` value that is logged here is also persisted onto the
// STATE_TRANSITION event payload (see runtime.ts), so the timeline and the
// /observability/logs endpoint can reconstruct "who triggered this" without
// reading process stdout.
//
// Design note: this is intentionally dependency-free (no pino/winston) to keep
// the prototype's footprint small. The shape — not the transport — is what
// matters for the observability story.

/**
 * Who/what caused a transition. This is the answer to Phase 9 Part 10's
 * "who triggered the transition?" question and is surfaced in the timeline,
 * logs, and inspector.
 */
export type TransitionSource =
  | "scheduler" // due-instance poller enqueued the job
  | "node-execution-worker" // BullMQ node-execution worker advanced the instance
  | "inbound-email-worker" // BullMQ inbound-email worker processed a reply
  | "inbound-email" // an inbound reply itself (injectReply transition)
  | "classification-agent" // reply classification decided the route
  | "negotiation-agent" // negotiation decided the route
  | "payment-form" // the creator submitted the hosted payout form
  | "brand-approval-link" // the brand clicked an approve/reject magic link
  | "manual" // a human / harness / API call drove the transition
  | "system"; // unattributed / internal

export interface TransitionLogFields {
  instanceId: string;
  creatorId?: string;
  fromState: string;
  toState: string;
  source: TransitionSource;
  /** Worker name that performed the write, when applicable. */
  worker?: string | undefined;
  /** BullMQ job id that drove this transition, when applicable. */
  queueJobId?: string | undefined;
  /** Node id within the workflow version's nodeGraph. */
  nodeId?: string | null | undefined;
  /** Free-form extra context (e.g. negotiation round, intent, confidence). */
  meta?: Record<string, unknown>;
}

/**
 * Emit a single structured transition log line.
 *
 * Output is a JSON object prefixed with a stable tag so it is easy to filter
 * out of mixed stdout:  `[transition] {"event":"state_transition",...}`
 *
 * `timestamp` is added here (ISO 8601) so callers never have to.
 */
export function logTransition(fields: TransitionLogFields): void {
  const line = {
    event: "state_transition",
    timestamp: new Date().toISOString(),
    instanceId: fields.instanceId,
    creatorId: fields.creatorId ?? null,
    fromState: fields.fromState,
    toState: fields.toState,
    source: fields.source,
    worker: fields.worker ?? null,
    queueJobId: fields.queueJobId ?? null,
    nodeId: fields.nodeId ?? null,
    ...(fields.meta ? { meta: fields.meta } : {}),
  };
  // Single line, parseable. Tag lets operators grep `[transition]`.
  console.log(`[transition] ${JSON.stringify(line)}`);
}

/**
 * Emit a structured log line for any non-transition observable event
 * (job picked up, classification result, lock skip, etc). Same envelope so a
 * single grep surfaces the whole lifecycle.
 */
export function logTrace(
  event: string,
  fields: Record<string, unknown>,
): void {
  const line = {
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  console.log(`[trace] ${JSON.stringify(line)}`);
}
