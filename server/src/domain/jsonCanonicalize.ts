// ---------------------------------------------------------------------------
// Shared micro-util: deterministic, key-order-independent JSON comparison
// ---------------------------------------------------------------------------
// Recursively sorts object keys (arrays keep their order — order IS
// significant for an array) so two structurally-identical values compare
// equal by `JSON.stringify` regardless of how their keys happened to be
// serialized. Two independent call sites need exactly this:
//   - deliverablesValidator.ts's resolveDeliverableSave (PLU-143 round 3):
//     "is this submitted item identical to something already stored" must
//     not be defeated by a client re-serializing the same object with keys
//     in a different order.
//   - domain/draftRevision.ts's computeRevisionId (PLU-172): the approval
//     hash must not depend on the undocumented fact that Postgres jsonb
//     happens to normalize key order on storage.
// Extracted here rather than duplicated so the two never drift into subtly
// different comparison semantics.

export function canonicalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForComparison);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeForComparison((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** `canonicalizeForComparison` + `JSON.stringify` in one call — the
 *  comparison KEY most callers actually want. */
export function canonicalJsonKey(value: unknown): string {
  return JSON.stringify(canonicalizeForComparison(value));
}
