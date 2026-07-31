import type { Campaign } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Randomized send delay (Randomized Send Delay — §4.5, §5)
// ---------------------------------------------------------------------------
// Decouples "an AI reply is generated" from "the reply is sent" by a randomized
// 30s–5min delay, so replies land on a human-plausible cadence instead of
// microseconds after the creator's email (a strong "automated sender" signal).
//
// This module owns ONLY the delay math + its config. The actual deferral is a
// BullMQ delayed job (workers/queues.ts enqueueDelayedSend); the flush is
// idempotentSend.flushOutbound. The delay is decided ONCE here at enqueue time —
// a job already sitting in Redis is unaffected by any later config change.
//
// Config (read once at module load, matching the existing env-read patterns):
//   SEND_DELAY_ENABLED         master switch (default true)
//   SEND_DELAY_MIN_MS          lower bound of the window (default 30_000)
//   SEND_DELAY_MAX_MS          upper bound of the window (default 300_000)
//   SEND_DELAY_SWEEP_GRACE_MS  poller safety-net lower-bound grace (default 120_000)
//   SEND_DELAY_MAX_SWEEP_AGE_MS poison upper age bound (default 86_400_000)
//   SEND_DELAY_MAX_REDRIVES    max sweep re-drives per reservation (default 3)
//
// Bounds validation at boot (mirrors the W1 config-bounds guard): if MIN > MAX,
// log a warning and treat the feature as DISABLED (fail safe = send immediately,
// never strand). Also assert GRACE < MAX_SWEEP_AGE so the sweep window is
// non-empty; otherwise clamp GRACE and warn.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A non-finite or negative value is a misconfiguration — fall back rather than
  // propagate a NaN into the delay math (which would produce a NaN delay).
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

// ---------------------------------------------------------------------------
// Resolved config — computed once at module load.
// ---------------------------------------------------------------------------

export interface SendDelayConfig {
  enabled: boolean;
  minMs: number;
  maxMs: number;
  sweepGraceMs: number;
  maxSweepAgeMs: number;
  maxRedrives: number;
}

function resolveConfig(): SendDelayConfig {
  // Under the test runner (NODE_ENV=test) default the feature OFF so the suite
  // stays fast and deterministic (§5/§8) without every test setting env — an
  // explicit SEND_DELAY_ENABLED=true still overrides for a test that WANTS a
  // delay. Every other environment defaults ON.
  const defaultEnabled = process.env["NODE_ENV"] === "test" ? false : true;
  const enabledEnv = envBool("SEND_DELAY_ENABLED", defaultEnabled);
  const minMs = envInt("SEND_DELAY_MIN_MS", 30_000);
  const maxMs = envInt("SEND_DELAY_MAX_MS", 300_000);
  let sweepGraceMs = envInt("SEND_DELAY_SWEEP_GRACE_MS", 120_000);
  const maxSweepAgeMs = envInt("SEND_DELAY_MAX_SWEEP_AGE_MS", 86_400_000);
  const maxRedrives = envInt("SEND_DELAY_MAX_REDRIVES", 3);

  // Fail-safe (W1 parity): an inverted window is a misconfiguration. Rather than
  // strand every reply behind a degenerate delay, treat the feature as disabled
  // → send immediately (delay 0). randomSendDelayMs() also guards `max <= min`,
  // so this is belt-and-suspenders; disabling here makes the intent explicit and
  // keeps the boot log honest.
  let enabled = enabledEnv;
  if (minMs > maxMs) {
    console.warn(
      `[send-delay] SEND_DELAY_MIN_MS (${minMs}) > SEND_DELAY_MAX_MS (${maxMs}) — ` +
        `treating the feature as DISABLED (sends go out immediately).`,
    );
    enabled = false;
  }

  // The sweep window must be non-empty: a reservation is eligible only when it is
  // OLDER than (maxMs + grace) but YOUNGER than maxSweepAge. If grace already
  // pushes the lower bound past the upper bound, nothing is ever swept. Clamp and
  // warn rather than silently disable recovery.
  if (sweepGraceMs + maxMs >= maxSweepAgeMs) {
    const clamped = Math.max(0, Math.floor(maxSweepAgeMs / 2) - maxMs);
    console.warn(
      `[send-delay] SEND_DELAY_SWEEP_GRACE_MS (${sweepGraceMs}) + max window (${maxMs}) ` +
        `>= SEND_DELAY_MAX_SWEEP_AGE_MS (${maxSweepAgeMs}); the sweep window would be empty. ` +
        `Clamping grace to ${clamped}ms.`,
    );
    sweepGraceMs = clamped;
  }

  return { enabled, minMs, maxMs, sweepGraceMs, maxSweepAgeMs, maxRedrives };
}

// Computed once. Env is read at process start, matching every other config read
// in the codebase; changing an env var requires a restart to take effect.
export const sendDelayConfig: SendDelayConfig = resolveConfig();

// ---------------------------------------------------------------------------
// randomSendDelayMs — the drawn delay for one AI reply.
// ---------------------------------------------------------------------------

/**
 * A uniform random delay in [MIN, MAX] milliseconds for the next AI reply.
 *
 * Returns 0 when the feature is disabled or the window is degenerate
 * (`max <= min`) — in that case the send still routes through the delayed-send
 * queue+worker, it just fires with delay 0 (as soon as a worker picks it up).
 * `SEND_DELAY_ENABLED=false` is delay-0, NOT a synchronous bypass (§4.5).
 *
 * `Math.random()` is intentional — this is jitter to break timing regularity,
 * not a security primitive.
 */
export function randomSendDelayMs(
  cfg: SendDelayConfig = sendDelayConfig,
  random: () => number = Math.random,
): number {
  if (!cfg.enabled || cfg.maxMs <= cfg.minMs) return 0;
  // Uniform inclusive over [min, max].
  return cfg.minMs + Math.floor(random() * (cfg.maxMs - cfg.minMs + 1));
}

/**
 * Resolve the negotiation-reply delay for a campaign. New/edited campaigns use
 * their persisted minute window; legacy campaigns with null settings retain
 * the existing process-wide SEND_DELAY_* behaviour exactly.
 */
export function negotiationReplyDelayMs(
  campaign: Pick<
    Campaign,
    "negotiationReplyPacingMinMinutes" | "negotiationReplyPacingMaxMinutes"
  > | null | undefined,
  legacyConfig: SendDelayConfig = sendDelayConfig,
  random: () => number = Math.random,
): number {
  const min = campaign?.negotiationReplyPacingMinMinutes;
  const max = campaign?.negotiationReplyPacingMaxMinutes;
  if (
    min === null || min === undefined ||
    max === null || max === undefined ||
    !Number.isInteger(min) || !Number.isInteger(max) ||
    min < 1 || max > 60 || min > max
  ) {
    return randomSendDelayMs(legacyConfig, random);
  }

  const minMs = min * 60_000;
  const maxMs = max * 60_000;
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}
