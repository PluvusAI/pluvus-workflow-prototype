// ---------------------------------------------------------------------------
// PLU-113 — Campaign-scoped creator-memory KEY METADATA (single source of truth)
// ---------------------------------------------------------------------------
// Calvin review #7: the singleton/numeric classification of each memory key used
// to live in more than one module with "keep these in sync" comments. This is the
// ONE neutral module that owns that metadata. It imports nothing from the DB or
// engine layers (so both can import it with no cycle) and derives every list from
// the single MEMORY_KEY_METADATA table below — there is no second place to edit.

/** The durable-fact taxonomy (§ issue "Suggested direction"). Kept byte-identical
 *  to the MemoryFactKey pgEnum in schema.ts (the migration lists the same members). */
export type MemoryFactKey =
  | "REQUESTED_RATE"
  | "MINIMUM_RATE"
  | "AVAILABILITY"
  | "LOGISTICS_CONSTRAINT"
  | "OBJECTION"
  | "DELIVERABLE_PREFERENCE"
  | "COMPENSATION_PREFERENCE"
  | "MANAGER_INVOLVED"
  | "MANAGER_CONTACT";

/** Per-key metadata. `singleton`: one live fact per (instance,key) — a material
 *  change supersedes the prior live fact rather than adding a second row. `numeric`:
 *  carries a validated `valueNumber` mirror and uses the numeric material-change
 *  test. Everything downstream (dedup key, write plan, DB upsert, operator recalc)
 *  is derived from THIS table — never re-listed. */
export interface MemoryKeyMeta {
  singleton: boolean;
  numeric: boolean;
}

export const MEMORY_KEY_METADATA: Readonly<Record<MemoryFactKey, MemoryKeyMeta>> = {
  REQUESTED_RATE: { singleton: true, numeric: true },
  MINIMUM_RATE: { singleton: true, numeric: true },
  AVAILABILITY: { singleton: true, numeric: false },
  MANAGER_INVOLVED: { singleton: true, numeric: false },
  MANAGER_CONTACT: { singleton: true, numeric: false },
  LOGISTICS_CONSTRAINT: { singleton: false, numeric: false },
  OBJECTION: { singleton: false, numeric: false },
  DELIVERABLE_PREFERENCE: { singleton: false, numeric: false },
  COMPENSATION_PREFERENCE: { singleton: false, numeric: false },
};

/** All memory keys, derived from the metadata table (one source of truth). */
export const MEMORY_FACT_KEYS = Object.keys(MEMORY_KEY_METADATA) as MemoryFactKey[];

export function isMemoryFactKey(key: string): key is MemoryFactKey {
  return Object.prototype.hasOwnProperty.call(MEMORY_KEY_METADATA, key);
}

export function isSingletonMemoryKey(key: MemoryFactKey): boolean {
  return MEMORY_KEY_METADATA[key].singleton;
}

export function isNumericMemoryKey(key: MemoryFactKey): boolean {
  return MEMORY_KEY_METADATA[key].numeric;
}

/**
 * Normalize a fact value for dedup + material-change comparison: lowercase, NFKC,
 * punctuation-stripped, whitespace-collapsed. Conservative — no fuzzy/semantic
 * merging, so two genuinely different constraints stay distinct rows. Mirrors the
 * obligation-ledger normalizer so behaviour is consistent across the two ledgers.
 */
export function normalizeMemoryValue(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Per-key sentinel used as the live-unique dedup key for singleton facts, so the
 *  partial-unique index collapses to one live row per (instance, key). */
export function singletonSentinel(key: MemoryFactKey): string {
  return `__singleton__${key}`;
}

/** The live-index dedup key for a fact: a per-key sentinel for singletons, the
 *  normalized value for list keys. The ONE place both the extractor path and the
 *  operator-create path derive it, so they cannot drift. */
export function memoryDedupKey(key: MemoryFactKey, normalizedValue: string): string {
  return isSingletonMemoryKey(key) ? singletonSentinel(key) : normalizedValue;
}

/**
 * One planned memory write for the turn — PURE data produced by the executor and
 * applied later by the DB layer inside stepInstance's transaction. Every item is
 * a CREATOR-sourced revision (operator edits go through a separate DB call), so it
 * always carries the source message + the server-verified evidence phrase.
 * Defined here (the neutral shared module) so both the engine that builds it and
 * the DB layer that applies it import the SAME shape (no drift).
 */
export interface MemoryWritePlanItem {
  key: MemoryFactKey;
  /** Current canonical value as text (numbers stringified). */
  value: string;
  /** Numeric mirror for numeric keys; null otherwise. */
  valueNumber: number | null;
  /** memoryDedupKey(key, normalize(value)) — the live-unique index key. */
  normalizedValue: string;
  /** normalize(value) — the ACTUAL normalized value, for the material-change test. */
  matchValue: string;
  confidence: number;
  /** The inbound Message this fact was extracted from (provenance). */
  sourceMessageId: string;
  /** The verbatim creator phrase supporting the value (server-verified — review #3). */
  evidenceText: string;
  category?: string | undefined;
}
