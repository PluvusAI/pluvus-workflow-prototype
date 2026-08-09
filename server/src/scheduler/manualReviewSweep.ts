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
  manualReviewNudgeOffsetsMs,
  nudgeDueAt,
} from "../engine/executors/manualReviewConfig.js";
import { notifyBrandOfEscalation } from "../notifications/escalation.js";
import { emailProvider } from "../engine/providerFactory.js";
import type { IEmailProvider } from "../engine/providers.js";

// PLU-154 manual-review timeout + nudge sweep. Runs each poll under the leader lease:
//   1. EXPIRE past-deadline cases → EXPIRED (distinct from NO_RESPONSE) via the same
//      OCC-CAS a human uses, so a human who just resolved wins the race and the sweep
//      no-ops.
//   2. NUDGE the brand pre-deadline: re-fire the escalation notice with a per-nudge
//      discriminator (each sends once). Brand/operator only, never the creator (PLU-155).
// The timeout is mandatory, so this sweep always has work to do.

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
  now: () => new Date(), // wrapped so tests can inject a fixed clock
};

export interface ManualReviewSweepResult {
  expired: number;
  nudged: number;
}

export async function sweepManualReviewTimeouts(
  deps: ManualReviewSweepDeps = defaultDeps,
): Promise<ManualReviewSweepResult> {
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
      // Add the timeout marker so the timeline reads as a brand-inactivity expiry.
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
