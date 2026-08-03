// ---------------------------------------------------------------------------
// Nylas webhook replay protection (BUG-SEC4)
// ---------------------------------------------------------------------------
// The HMAC signature proves a delivery is AUTHENTIC (Nylas signed it) but not
// FRESH — a captured, correctly-signed body can be replayed indefinitely to
// re-inject a stale reply into a live instance. Two independent guards close
// this:
//
//   1. Timestamp freshness — Nylas v3 puts a top-level unix-seconds `time` on
//      every webhook. We reject a delivery whose `time` is older than
//      WEBHOOK_MAX_AGE_SECONDS (default 300s / 5 min). If `time` is ABSENT we
//      fail OPEN on this check alone (can't prove staleness) — the seen-id guard
//      below is the backstop for that case.
//
//   2. Seen-delivery-id — a bounded in-process set of Nylas notification ids
//      (the top-level webhook envelope `id`), scoped by grant at the route. A
//      repeat within the retention window is treated as a replay/duplicate. This
//      is a best-effort, per-process guard (a multi-process fleet each keeps its
//      own set); the durable backstop remains downstream: BullMQ and Message use
//      the connected-account + provider-message-id tuple, with a separate null-
//      account namespace for legacy/mock rows. Its job here is to reject an
//      obvious replay at the edge.
//
// Both are pure/injectable so they unit-test without a clock or Express.

/** Parse WEBHOOK_MAX_AGE_SECONDS; default 300s. 0 disables the freshness check. */
export function resolveMaxAgeSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["WEBHOOK_MAX_AGE_SECONDS"];
  if (raw === undefined || raw.trim() === "") return 300;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 300;
  return Math.floor(n);
}

/** Pull the top-level unix-seconds `time` from a parsed Nylas webhook payload, or
 *  undefined when absent/not a number. */
export function extractDeliveryTime(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const t = (payload as Record<string, unknown>)["time"];
  return typeof t === "number" && Number.isFinite(t) ? t : undefined;
}

/**
 * Is this delivery fresh enough to accept?
 *  - maxAgeSeconds <= 0 → check disabled → always true.
 *  - deliveryTimeSec undefined → cannot prove staleness → true (fail open; the
 *    seen-id guard is the backstop).
 *  - otherwise true iff (now - deliveryTime) <= maxAge, and it isn't absurdly in
 *    the future (a >maxAge future skew is also rejected as suspicious).
 */
export function isFreshDelivery(
  deliveryTimeSec: number | undefined,
  nowMs: number,
  maxAgeSeconds: number,
): boolean {
  if (maxAgeSeconds <= 0) return true;
  if (deliveryTimeSec === undefined) return true;
  const ageSec = nowMs / 1000 - deliveryTimeSec;
  return Math.abs(ageSec) <= maxAgeSeconds;
}

/**
 * A small bounded "recently seen delivery ids" set. Insertion-ordered eviction
 * (oldest out first) once `capacity` is exceeded — enough to catch an immediate
 * replay burst without unbounded memory growth. Not a security boundary on its
 * own (the DB unique constraint is); an edge-level replay reject.
 */
export class SeenDeliveryIds {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity: number = 5000) {}

  /**
   * Record `id`. Returns true if it was NEW (accept), false if it was already
   * seen (replay → reject).
   */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      // Evict the oldest (first-inserted) id.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}
