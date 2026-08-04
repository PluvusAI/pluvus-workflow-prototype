// ---------------------------------------------------------------------------
// PLU-113 — campaign-scoped creator memory: feature flag + confidence floor
// ---------------------------------------------------------------------------
// Memory persists durable creator facts (rate, availability, objections, manager,
// preferences) per campaign so the AI stops re-inferring them from the raw
// transcript every turn. OFF by default: with the flag off, no facts are
// extracted or written and no memory block is rendered — /negotiate and /draft
// prompts are byte-identical to today. Read per turn in the executor, so flipping
// it never backfills an instance's prior transcript; memory populates forward.

export function creatorMemoryEnabled(): boolean {
  return process.env["CREATOR_MEMORY_ENABLED"] === "true";
}

/**
 * The confidence floor below which an extracted fact is dropped as an unnecessary
 * subjective inference. Overridable via MEMORY_MIN_CONFIDENCE (default 0.5). An
 * out-of-range or unparseable value falls back to the default. Note: confidence is
 * a floor, NOT evidence — every fact must ALSO pass the evidence check (review #3).
 */
export function memoryMinConfidence(): number {
  const raw = process.env["MEMORY_MIN_CONFIDENCE"];
  if (raw === undefined) return 0.5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.5;
  return n;
}
