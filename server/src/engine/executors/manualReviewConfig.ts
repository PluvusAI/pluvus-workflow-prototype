// ---------------------------------------------------------------------------
// Manual-review resolution + timeout — configuration (PLU-154)
// ---------------------------------------------------------------------------
// A MANUAL_REVIEW case is the ExecutionInstance itself while it is parked for a
// human. PLU-154 gives it a DEADLINE (stamped into the existing dueAt column on
// entry) and a set of pre-deadline brand NUDGES, and a timeout sweep that expires
// the case if no human acts.
//
// The whole timeout mechanism is OFF by default (repo convention: every new
// behavior ships dark). With MANUAL_REVIEW_TIMEOUT_ENABLED unset, manualReviewDueAt
// returns null → no deadline is stamped → the sweep finds nothing → today's
// behavior (a case sits in MANUAL_REVIEW until a human acts) is byte-identical.
// Enabling it in staging/prod is what makes the "no creator remains indefinitely
// in MANUAL_REVIEW" acceptance criterion hold live.

/** Non-negative integer env var, else fallback. Mirrors brandApprovalSweep.envInt. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Dark by default. Read at MR-entry (dueAt stamping) and in the sweep. */
export function manualReviewTimeoutEnabled(): boolean {
  return process.env["MANUAL_REVIEW_TIMEOUT_ENABLED"] === "true";
}

/** How long a case may sit in MANUAL_REVIEW before the sweep expires it. 7d default. */
export const manualReviewTimeoutMs: number = envInt(
  "MANUAL_REVIEW_TIMEOUT_MS",
  7 * 24 * 60 * 60_000,
);

/**
 * Milliseconds-before-deadline at which to send each brand nudge, largest first.
 * Env is a comma list of "ms before deadline" (e.g. "259200000,86400000" = 3d,1d).
 * Defaults to [3d, 1d]. Invalid/negative entries are dropped; parse failure falls
 * back to the default rather than throwing at import time.
 */
export const manualReviewNudgeOffsetsMs: number[] = parseNudgeOffsets(
  process.env["MANUAL_REVIEW_NUDGE_OFFSETS_MS"],
);

function parseNudgeOffsets(raw: string | undefined): number[] {
  const fallback = [3 * 24 * 60 * 60_000, 1 * 24 * 60 * 60_000]; // 3d, 1d
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  // Largest offset first so nudge #1 is the earliest. Dedup keeps the schedule
  // clean if the env repeats a value.
  const sorted = [...new Set(parsed)].sort((a, b) => b - a);
  return sorted.length > 0 ? sorted : fallback;
}

/**
 * The deadline to stamp when an instance enters MANUAL_REVIEW: now + timeout, or
 * null when the timeout feature is off (leaving dueAt null = no timeout, exactly
 * today's behavior). Both MR write paths in runtime.ts call this.
 */
export function manualReviewDueAt(now: Date): Date | null {
  if (!manualReviewTimeoutEnabled()) return null;
  return new Date(now.getTime() + manualReviewTimeoutMs);
}

/**
 * Given a case's deadline and how many nudges have already been sent, decide
 * whether another nudge is due at `now`. A nudge is due when `now` has passed the
 * offset for the NEXT unsent nudge (offsets are largest-first, so nudge index i
 * fires at deadline - offsets[i]) and the deadline itself hasn't passed yet
 * (once expired, the sweep expires the case rather than nudging it). Pure, so the
 * sweep test can drive it directly.
 */
export function nudgeDueAt(
  now: Date,
  deadline: Date,
  nudgesSent: number,
  offsets: number[] = manualReviewNudgeOffsetsMs,
): boolean {
  if (nudgesSent >= offsets.length) return false; // all nudges sent
  if (now.getTime() >= deadline.getTime()) return false; // expired: let the sweep expire it
  const fireAt = deadline.getTime() - offsets[nudgesSent]!;
  return now.getTime() >= fireAt;
}
