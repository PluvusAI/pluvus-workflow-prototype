import {
  listStrandedOutboundReservations,
  incrementRedriveCount,
  listEventsByInstance,
} from "../db/index.js";
import { enqueueDelayedSend } from "../workers/queues.js";
import type { Message } from "../db/schema.js";
import { sendDelayConfig } from "../engine/sendDelay.js";
import { logTrace } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Randomized Send Delay — safety-net sweep (§4.4)
// ---------------------------------------------------------------------------
// The primary send timer is the BullMQ delayed job (Redis-durable, survives a
// worker restart). This sweep is the RECOVERY path for the one case that timer
// can't cover: Redis lost the delayed job (flush, eviction, or it dead-lettered
// past all attempts). The reserved OUTBOUND row is still there with
// externalMessageId IS NULL, so this reclaims it.
//
// It is RECOVERY, not a perpetual retry loop. Four bounds (§4.4):
//   - Lower bound (MAX window + grace): don't race a legit delayed job that is
//     still pending. `grace` must exceed the worst-case reserve→enqueue lag
//     (§4.3a option A enqueues after the OCC commit), so it's configurable.
//   - Upper age bound (MAX_SWEEP_AGE): a row older than this is a permanent-
//     failure poison message — stop re-driving, leave it for manual inspection.
//   - redriveCount < MAX_REDRIVES: a row swept a few times without success is
//     abandoned (poison-loop bound).
//   - Orphan guard (§4.3a): a reserved row whose owning turn ROLLED BACK
//     (StaleInstanceError) also has externalMessageId NULL and an old createdAt.
//     Flushing it would COMPLETE a send the rollback meant to prevent. Under
//     enqueue-after-commit (option A) a rolled-back turn appends NO
//     NEGOTIATION_TURN event, so we require a committed NEGOTIATION_TURN event at
//     or after the row's createdAt before re-driving. The guard is RESERVATION-TYPE
//     AWARE (PLU-118, Calvin review §2): a brand-reject close email
//     (idempotencyKey `brand-reject-close:*`) is reserved by the reject path, which
//     appends BRAND_REJECTED — never NEGOTIATION_TURN — so for those rows the guard
//     looks for a committed BRAND_REJECTED instead. Without this, a genuinely
//     committed reject whose delayed enqueue was lost would be permanently mistaken
//     for an orphan and its close email dropped.
//
// Exactly-once is preserved by the per-send lock + post-lock NULL re-check in
// flushOutbound (§4.2a), NOT by the jobId — so the re-drive MUST use a DISTINCT
// jobId (send|<id>|redrive-<n>), because BullMQ v5 `add()` with an existing
// custom jobId is a no-op (it will not promote a delayed/failed original).
//
// Runs inside poll(), which already holds the scheduler leader lease — no extra
// leader guard needed.

// A small tolerance for the orphan-guard timestamp comparison. The reserved row
// is written on its own auto-commit a fraction of a second BEFORE the OCC
// transaction appends the NEGOTIATION_TURN event, so the event's occurredAt is
// essentially concurrent with (never earlier than) the row's createdAt. Allow a
// generous skew so a committed turn is never mistaken for an orphan.
const ORPHAN_GUARD_SKEW_MS = 60_000;

export interface SendDelaySweepDeps {
  listStrandedOutboundReservations(args: {
    now: Date;
    lowerBoundMs: number;
    scheduleGraceMs: number;
    maxAgeMs: number;
    maxRedrives: number;
    limit?: number;
  }): Promise<Message[]>;
  incrementRedriveCount(id: string): Promise<number>;
  enqueueDelayedSend(
    data: { messageId: string },
    delayMs?: number,
    jobId?: string,
  ): Promise<void>;
  /** Returns true when the reservation's owning action COMMITTED — i.e. the
   *  committing event for THIS reservation type exists for the instance at/after
   *  the row's reserve time (minus skew). A rolled-back action has none → orphan →
   *  skip. The row is passed (not just instanceId) so the guard can pick the right
   *  committing event by the reservation's idempotencyKey (PLU-118 §2). */
  turnCommitted(row: Message, reservedAt: Date): Promise<boolean>;
  now(): Date;
}

// The idempotencyKey prefix for the brand-reject creator close email. Kept in sync
// with brandRejectCloseKey() in brandRejectEmail.ts (`brand-reject-close:<id>`).
export const BRAND_REJECT_CLOSE_PREFIX = "brand-reject-close:";
export const INITIAL_OUTREACH_PREFIX = "outreach:";
// PLU-110: a negotiation follow-up send commits FOLLOW_UP_DUE, not NEGOTIATION_TURN.
export const NEGOTIATION_FOLLOWUP_PREFIX = "negotiation-followup:";

// Map a reservation to the event type whose committed presence proves its owning
// action committed. Default is NEGOTIATION_TURN (AI negotiation replies, the
// overwhelming majority of delayed sends); a brand-reject close email is committed
// by the reject transition's BRAND_REJECTED event instead. Exported for unit tests.
export function committingEventType(
  row: Message,
): "NEGOTIATION_TURN" | "BRAND_REJECTED" | "OUTREACH_DRAFTED" | "FOLLOW_UP_DUE" {
  if (row.idempotencyKey?.startsWith(BRAND_REJECT_CLOSE_PREFIX)) return "BRAND_REJECTED";
  if (row.idempotencyKey?.startsWith(INITIAL_OUTREACH_PREFIX)) return "OUTREACH_DRAFTED";
  // PLU-110: without this a stranded follow-up whose flush job was lost would be
  // misread as a rolled-back orphan and its email silently dropped forever.
  if (row.idempotencyKey?.startsWith(NEGOTIATION_FOLLOWUP_PREFIX)) return "FOLLOW_UP_DUE";
  return "NEGOTIATION_TURN";
}

async function defaultTurnCommitted(row: Message, reservedAt: Date): Promise<boolean> {
  const events = await listEventsByInstance(row.instanceId, {
    type: committingEventType(row),
  });
  const floor = reservedAt.getTime() - ORPHAN_GUARD_SKEW_MS;
  return events.some((e) => e.occurredAt.getTime() >= floor);
}

const defaultDeps: SendDelaySweepDeps = {
  listStrandedOutboundReservations,
  incrementRedriveCount,
  enqueueDelayedSend,
  turnCommitted: defaultTurnCommitted,
  // Date.now() is fine in app code (only Workflow scripts forbid it); wrapped so
  // tests can inject a fixed clock.
  now: () => new Date(),
};

/** Number of stranded reservations reclaimed this tick, split by outcome, for
 *  the §9 optional metric (flushed vs. poison-abandoned). */
export interface SendDelaySweepResult {
  reclaimed: number;
  orphansSkipped: number;
}

export async function sweepStrandedSends(
  deps: SendDelaySweepDeps = defaultDeps,
): Promise<SendDelaySweepResult> {
  const cfg = sendDelayConfig;
  const now = deps.now();
  // Lower bound = the max window + grace, measured from createdAt (reserve time).
  const lowerBoundMs = cfg.maxMs + cfg.sweepGraceMs;

  let stranded: Message[];
  try {
    stranded = await deps.listStrandedOutboundReservations({
      now,
      lowerBoundMs,
      scheduleGraceMs: cfg.sweepGraceMs,
      maxAgeMs: cfg.maxSweepAgeMs,
      maxRedrives: cfg.maxRedrives,
      limit: 100,
    });
  } catch (err) {
    console.error(
      "[scheduler/send-delay-sweep] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return { reclaimed: 0, orphansSkipped: 0 };
  }

  if (stranded.length === 0) return { reclaimed: 0, orphansSkipped: 0 };

  console.log(
    `[scheduler/send-delay-sweep] ${stranded.length} stranded reservation(s) to inspect`,
  );

  let reclaimed = 0;
  let orphansSkipped = 0;

  for (const row of stranded) {
    // Orphan guard (§4.3a): skip a reservation whose owning turn rolled back —
    // flushing it would complete a send the rollback meant to prevent.
    let committed: boolean;
    try {
      committed = await deps.turnCommitted(row, row.createdAt);
    } catch (err) {
      console.error(
        `[scheduler/send-delay-sweep] orphan-guard check failed for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue; // fail safe — don't re-drive on an uncertain guard.
    }
    if (!committed) {
      orphansSkipped++;
      console.log(
        `[scheduler/send-delay-sweep] ${row.id} has no committed turn (rolled-back reservation) — skip`,
      );
      continue;
    }

    // Claim the row by bumping redriveCount FIRST (§4.4 once-only-ish claim), so
    // two overlapping sweeps advance the same counter and a persistently-failing
    // row is bounded. The new count also names the DISTINCT re-drive jobId.
    let count: number;
    try {
      count = await deps.incrementRedriveCount(row.id);
    } catch (err) {
      console.error(
        `[scheduler/send-delay-sweep] failed to claim ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    // DISTINCT jobId per re-drive (§4.4 BullMQ jobId semantics): send|<id>|redrive-<n>.
    // delay 0 → flush ASAP. Exactly-once still held by the flush lock + NULL re-check.
    const jobId = `send|${row.id}|redrive-${count}`;
    try {
      await deps.enqueueDelayedSend({ messageId: row.id }, 0, jobId);
      reclaimed++;
      console.log(
        `[scheduler/send-delay-sweep] re-drove ${row.id} (redrive #${count}, job ${jobId})`,
      );
      logTrace("send_delay_redriven", {
        source: "scheduler",
        instanceId: row.instanceId,
        messageId: row.id,
        redriveCount: count,
      });
    } catch (err) {
      console.error(
        `[scheduler/send-delay-sweep] re-enqueue FAILED for ${row.id} (redriveCount already bumped to ${count}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (reclaimed || orphansSkipped) {
    console.log(
      `[scheduler/send-delay-sweep] reclaimed ${reclaimed}, skipped ${orphansSkipped} orphan(s)`,
    );
  }
  return { reclaimed, orphansSkipped };
}
