import {
  listPendingDeadLetters,
  markDeadLetterRedriven,
} from "../db/index.js";
import { QUEUE_INBOUND_EMAIL, enqueueInboundEmail } from "../workers/queues.js";
import type { InboundEmailJobData } from "../workers/jobs.js";
import type { DeadLetterJob } from "../db/schema.js";
import { logTrace } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Inbound-email re-drive sweep (BUG-Q2)
// ---------------------------------------------------------------------------
// BUG-Q2: the inbound-email queue had NO reconciliation coverage. A failed
// inbound job (all attempts exhausted) left the instance in AWAITING_REPLY — a
// state the poller + reconciliation sweep deliberately DON'T touch (it normally
// carries a future dueAt and waits for the creator). So a lost reply had no
// recovery, ever: the creator replied and the system silently never processed it.
//
// Now that exhausted inbound jobs are dead-lettered (BUG-Q1), this sweep is the
// recovery: on the scheduler cadence (under the leader lease), read PENDING
// DeadLetterJob rows for the inbound-email queue and RE-ENQUEUE them. Re-enqueue
// uses the SAME jobId (inbound|externalMessageId) so BullMQ dedupe + the worker's
// processedAt idempotency guarantee at most one actual processing. Each row is
// marked REDRIVEN under a PENDING guard, so two concurrent sweeps can't both
// re-enqueue it, and a persistently-failing reply is re-driven at most once
// (its re-exhaustion dead-letter no-ops on the queue+jobId dedupe) rather than
// looping forever — the row stays for a human to inspect.

// Injectable seam so the sweep is unit-testable without a live DB or Redis.
export interface InboundRedriveDeps {
  listPendingDeadLetters(queue: string, limit?: number): Promise<DeadLetterJob[]>;
  markDeadLetterRedriven(id: string): Promise<DeadLetterJob | null>;
  enqueueInboundEmail(data: InboundEmailJobData): Promise<void>;
}

const defaultDeps: InboundRedriveDeps = {
  listPendingDeadLetters,
  markDeadLetterRedriven,
  enqueueInboundEmail,
};

/** Reconstruct the inbound job data from a dead-letter payload, or null if the
 *  payload is missing the fields the worker requires. */
export function inboundJobFromPayload(
  payload: unknown,
): InboundEmailJobData | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const instanceId = p["instanceId"];
  const externalMessageId = p["externalMessageId"];
  const threadId = p["threadId"];
  const subject = p["subject"];
  const body = p["body"];
  if (typeof instanceId !== "string" || !instanceId) return null;
  if (typeof externalMessageId !== "string" || !externalMessageId) return null;
  const data: InboundEmailJobData = {
    instanceId,
    externalMessageId,
    threadId: typeof threadId === "string" ? threadId : "",
    subject: typeof subject === "string" ? subject : "",
    body: typeof body === "string" ? body : "",
  };
  if (typeof p["emailAccountId"] === "string" && p["emailAccountId"]) {
    data.emailAccountId = p["emailAccountId"];
  }
  if (typeof p["senderEmail"] === "string") data.senderEmail = p["senderEmail"];
  if (typeof p["mockIntent"] === "string") data.mockIntent = p["mockIntent"];
  return data;
}

export async function redriveInboundDeadLetters(
  deps: InboundRedriveDeps = defaultDeps,
): Promise<number> {
  let pending: DeadLetterJob[];
  try {
    pending = await deps.listPendingDeadLetters(QUEUE_INBOUND_EMAIL);
  } catch (err) {
    console.error(
      "[scheduler/inbound-redrive] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  if (pending.length === 0) return 0;

  console.log(
    `[scheduler/inbound-redrive] ${pending.length} dead-lettered inbound reply(ies) to re-drive`,
  );

  let redriven = 0;
  for (const row of pending) {
    const data = inboundJobFromPayload(row.payload);
    if (!data) {
      console.error(
        `[scheduler/inbound-redrive] dead-letter ${row.id} has an unusable payload — skipping (mark DISCARDED manually)`,
      );
      continue;
    }
    // Claim the row first (PENDING → REDRIVEN, guarded) so a concurrent sweep
    // can't also re-enqueue it. Only the winner proceeds to enqueue.
    let claimed;
    try {
      claimed = await deps.markDeadLetterRedriven(row.id);
    } catch (err) {
      console.error(
        `[scheduler/inbound-redrive] failed to claim dead-letter ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!claimed) continue; // lost the race — another sweep already claimed it.

    try {
      await deps.enqueueInboundEmail(data);
      redriven++;
      console.log(
        `[scheduler/inbound-redrive] re-enqueued inbound reply for ${data.instanceId} (msg ${data.externalMessageId}, dead-letter ${row.id})`,
      );
      logTrace("inbound_redriven", {
        source: "scheduler",
        instanceId: data.instanceId,
        externalMessageId: data.externalMessageId,
        deadLetterId: row.id,
      });
    } catch (err) {
      // The enqueue failed after we marked it REDRIVEN. The job data is preserved
      // in the (now REDRIVEN) dead-letter row for manual recovery; log loudly.
      console.error(
        `[scheduler/inbound-redrive] re-enqueue FAILED for dead-letter ${row.id} (already marked REDRIVEN):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return redriven;
}
