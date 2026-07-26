// ---------------------------------------------------------------------------
// Campaign-scoped creator memory (PLU-113) — feature flag + confidence floor
// ---------------------------------------------------------------------------
// Memory persists durable creator facts (rate, availability, objections, manager,
// preferences) per campaign so the AI stops re-inferring them from the raw
// transcript every turn. It is OFF by default (invariant #8): with the flag off,
// no facts are requested/extracted, no writes happen, and no memory block is
// rendered — /negotiate and /draft prompts are byte-identical to today. The flag
// is read in the negotiation executor per turn, so flipping it never retroactively
// backfills an instance's prior transcript (O10) — memory populates forward.

export function creatorMemoryEnabled(): boolean {
  return process.env["CREATOR_MEMORY_ENABLED"] === "true";
}

/**
 * The confidence floor below which an extracted fact is dropped as an
 * "unnecessary subjective inference" (§4.5 / O2). Overridable via
 * MEMORY_MIN_CONFIDENCE; defaults to a conservative 0.5. An out-of-range or
 * unparseable value falls back to the default.
 */
export function memoryMinConfidence(): number {
  const raw = process.env["MEMORY_MIN_CONFIDENCE"];
  if (raw === undefined) return 0.5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.5;
  return n;
}
