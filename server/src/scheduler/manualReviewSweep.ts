import {
  listExpiredManualReviewCases,
  listManualReviewCasesForNudge,
  countNudges,
  resolveManualReviewCase,
  ManualReviewRaceError,
  appendEvent,
} from "../db/index.js";
import type { ExecutionInstance } from "../db/schema.js";
import {
  manualReviewTimeoutEnabled,
  manualReviewNudgeOffsetsMs,
  nudgeDueAt,
} from "../engine/executors/manualReviewConfig.js";
import { notifyBrandOfEscalation } from "../notifications/escalation.js";
import { emailProvider } from "../engine/providerFactory.js";
import type { IEmailProvider } from "../engine/providers.js";

// ---------------------------------------------------------------------------
// Manual-review timeout + nudge sweep (PLU-154)
// ---------------------------------------------------------------------------
// Runs on the poller cadence under the leader lease. Two jobs:
//   1. EXPIRE cases whose deadline (instance.dueAt) has passed → EXPIRED, a
//      distinguishable timeout terminal (never NO_RESPONSE). The transition is the
//      SAME OCC-CAS resolveManualReviewCase a human uses, so if a human just
//      resolved the case the CAS loses the race and the sweep no-ops — deterministic:
//      human wins, sweep skips.
//   2. NUDGE the brand before the deadline: re-fire the existing (idempotent)
//      escalation notice with a per-nudge discriminator so each nudge sends once.
//      The notice targets the BRAND/operator (campaign notifyEmail → BRAND_NOTIFY_
//      EMAIL → operator), never the creator — creator-facing closure is PLU-155.
//
// The whole sweep is OFF unless MANUAL_REVIEW_TIMEOUT_ENABLED (dark default): with
// it off no deadline is ever stamped, so both queries return nothing anyway; the
// early return just avoids the work.

export interface ManualReviewSweepDeps {
  listExpiredManualReviewCases(args: { now: Date; limit?: number }): Promise<ExecutionInstance[]>;
  listManualReviewCasesForNudge(args: { now: Date; limit?: number }): Promise<ExecutionInstance[]>;
  countNudges(instanceId: string): Promise<number>;
  resolveManualReviewCase: typeof resolveManualReviewCase;
  notifyBrandOfEscalation(email: IEmailProvider, instanceId: string, reason: string): Promise<unknown>;
  appendEvent: typeof appendEvent;
  email(): IEmailProvider;
  now(): Date;
}

const defaultDeps: ManualReviewSweepDeps = {
  listExpiredManualReviewCases,
  listManualReviewCasesForNudge,
  countNudges,
  resolveManualReviewCase,
  notifyBrandOfEscalation,
  appendEvent,
  email: emailProvider,
  // Date.now() is fine in app code (only Workflow scripts forbid it); wrapped so
  // tests can inject a fixed clock.
  now: () => new Date(),
};

export interface ManualReviewSweepResult {
  expired: number;
  nudged: number;
}

export async function sweepManualReviewTimeouts(
  deps: ManualReviewSweepDeps = defaultDeps,
): Promise<ManualReviewSweepResult> {
  if (!manualReviewTimeoutEnabled()) return { expired: 0, nudged: 0 };

  const now = deps.now();
  let expired = 0;
  let nudged = 0;

  // ── 1. Expire past-deadline cases ────────────────────────────────────────
  let expiredCases: ExecutionInstance[] = [];
  try {
    expiredCases = await deps.listExpiredManualReviewCases({ now, limit: 200 });
  } catch (err) {
    console.error(
      "[scheduler/manual-review-sweep] expired query failed:",
      err instanceof Error ? err.message : err,
    );
  }

  for (const inst of expiredCases) {
    try {
      await deps.resolveManualReviewCase(inst.id, {
        to: "EXPIRED",
        resolvedBy: "system",
        reason: "manual_review_timeout",
        source: "system",
      });
      // The resolution appended MANUAL_REVIEW_RESOLVED + STATE_TRANSITION; add the
      // distinguishing timeout marker so the timeline reads unambiguously as a
      // brand-inactivity expiry (not a creator no-response).
      await deps.appendEvent({
        instanceId: inst.id,
        type: "MANUAL_REVIEW_EXPIRED",
        payload: { deadline: inst.dueAt?.toISOString() ?? null, at: now.toISOString() },
        occurredAt: now,
      });
      expired++;
      console.log(`[scheduler/manual-review-sweep] expired case ${inst.id} → EXPIRED`);
    } catch (err) {
      if (err instanceof ManualReviewRaceError) {
        // A human resolved it first — deterministic: human wins, skip.
        continue;
      }
      console.error(
        `[scheduler/manual-review-sweep] expire failed for ${inst.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── 2. Nudge cases whose next nudge is due ───────────────────────────────
  let nudgeCandidates: ExecutionInstance[] = [];
  try {
    nudgeCandidates = await deps.listManualReviewCasesForNudge({ now, limit: 200 });
  } catch (err) {
    console.error(
      "[scheduler/manual-review-sweep] nudge query failed:",
      err instanceof Error ? err.message : err,
    );
  }

  for (const inst of nudgeCandidates) {
    if (!inst.dueAt) continue; // defensive; the query already filters
    let sent: number;
    try {
      sent = await deps.countNudges(inst.id);
    } catch (err) {
      console.error(
        `[scheduler/manual-review-sweep] nudge count failed for ${inst.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!nudgeDueAt(now, inst.dueAt, sent, manualReviewNudgeOffsetsMs)) continue;

    try {
      // Per-nudge discriminator forces a fresh send past the notice's idempotency.
      await deps.notifyBrandOfEscalation(deps.email(), inst.id, `manual-review-nudge-${sent + 1}`);
      await deps.appendEvent({
        instanceId: inst.id,
        type: "MANUAL_REVIEW_NUDGED",
        payload: { nudgeNumber: sent + 1, at: now.toISOString() },
        occurredAt: now,
      });
      nudged++;
      console.log(
        `[scheduler/manual-review-sweep] nudged brand for ${inst.id} (nudge #${sent + 1})`,
      );
    } catch (err) {
      console.error(
        `[scheduler/manual-review-sweep] nudge send failed for ${inst.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (expired || nudged) {
    console.log(`[scheduler/manual-review-sweep] expired ${expired}, nudged ${nudged}`);
  }
  return { expired, nudged };
}
