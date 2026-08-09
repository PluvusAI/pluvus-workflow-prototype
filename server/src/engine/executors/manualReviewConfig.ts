// PLU-154 manual-review timeout config. A parked MANUAL_REVIEW case gets a deadline
// (stamped into dueAt on entry), pre-deadline brand nudges, and is expired by the
// sweep if unresolved. The timeout is MANDATORY — durations are env-tunable, the
// on/off is not — so no creator can sit in MANUAL_REVIEW forever.

// Non-negative integer env var, else fallback. Local copy by convention
// (brandApprovalSweep/sendDelay do the same); the exported envInt drags in
// express-rate-limit, so reusing it would pollute this module's deps.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Module-private: only manualReviewDueAt reads it.
const manualReviewTimeoutMs: number = envInt("MANUAL_REVIEW_TIMEOUT_MS", 7 * 24 * 60 * 60_000);

// Milliseconds-before-deadline for each brand nudge (env: comma list, e.g. "3d,1d").
export const manualReviewNudgeOffsetsMs: number[] = parseNudgeOffsets(
  process.env["MANUAL_REVIEW_NUDGE_OFFSETS_MS"],
);

function parseNudgeOffsets(raw: string | undefined): number[] {
  const fallback = [3 * 24 * 60 * 60_000, 1 * 24 * 60 * 60_000]; // 3d, 1d
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  const sorted = [...new Set(parsed)].sort((a, b) => b - a); // largest first = nudge #1 earliest
  return sorted.length > 0 ? sorted : fallback;
}

/** Deadline to stamp on MANUAL_REVIEW entry: now + timeout. Always set (mandatory). */
export function manualReviewDueAt(now: Date): Date {
  return new Date(now.getTime() + manualReviewTimeoutMs);
}

/** Is the next unsent nudge due at `now`? Nudge i fires at deadline - offsets[i];
 *  past the deadline it's the sweep's job to expire, not nudge. */
export function nudgeDueAt(
  now: Date,
  deadline: Date,
  nudgesSent: number,
  offsets: number[] = manualReviewNudgeOffsetsMs,
): boolean {
  if (nudgesSent >= offsets.length) return false;
  if (now.getTime() >= deadline.getTime()) return false;
  return now.getTime() >= deadline.getTime() - offsets[nudgesSent]!;
}
