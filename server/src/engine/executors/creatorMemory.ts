// PLU-113: pure helpers for campaign-scoped creator memory.
//
// Everything here is a PURE function over extracted facts + existing live rows —
// no DB, no I/O — so it is unit-testable in isolation (§4.5). The executor calls
// buildMemoryWritePlan to turn this turn's extracted `creatorFacts` (plus the
// already-validated creatorRequestedRate) into a write plan, then the runtime
// applies it in-tx via upsertMemoryFact. buildCreatorMemoryBlock turns the live
// rows into the sanitized read payload threaded into /negotiate + /draft (§4.8).
//
// See .claude/spec/plu-113-campaign-scoped-creator-memory/PLAN.md.

import type { CampaignCreatorMemory, MemoryFactKey } from "../../db/schema.js";
// PLU-113: reuse the single ExtractedFact shape from the adapter types (the wire
// contract) so there's one source of truth across the seam.
import type { ExtractedFact } from "../../adapters/negotiation/types.js";

export type { ExtractedFact };

/** The 9-key taxonomy (§4.3). Kept in sync with memoryFactKeyEnum. */
export const MEMORY_FACT_KEYS: MemoryFactKey[] = [
  "REQUESTED_RATE",
  "MINIMUM_RATE",
  "AVAILABILITY",
  "LOGISTICS_CONSTRAINT",
  "OBJECTION",
  "DELIVERABLE_PREFERENCE",
  "COMPENSATION_PREFERENCE",
  "MANAGER_INVOLVED",
  "MANAGER_CONTACT",
];

/**
 * Singleton keys hold one live value per instance (a material change → CONFLICTED,
 * not a new row). List keys accumulate multiple distinct rows. (§4.1)
 */
const SINGLETON_KEYS: ReadonlySet<MemoryFactKey> = new Set<MemoryFactKey>([
  "REQUESTED_RATE",
  "MINIMUM_RATE",
  "AVAILABILITY",
  "MANAGER_INVOLVED",
  "MANAGER_CONTACT",
]);

/** Numeric keys carry a valueNumber mirror + numeric material-change test. */
const NUMERIC_KEYS: ReadonlySet<MemoryFactKey> = new Set<MemoryFactKey>([
  "REQUESTED_RATE",
  "MINIMUM_RATE",
]);

export function isSingletonMemoryKey(key: MemoryFactKey): boolean {
  return SINGLETON_KEYS.has(key);
}

export function isNumericMemoryKey(key: MemoryFactKey): boolean {
  return NUMERIC_KEYS.has(key);
}

/** Default confidence floor (§4.5 / O2). Facts below this are dropped as guesses. */
export const DEFAULT_MEMORY_MIN_CONFIDENCE = 0.5;

/**
 * Normalize a fact value for dedup / material-change comparison (§4.5, §4.6).
 * Same shape as normalizeObligationKey: lowercase, NFKC, punctuation-stripped,
 * whitespace-collapsed. Conservative — no fuzzy/semantic merging, so two genuinely
 * different constraints stay distinct (O3). MUST stay identical to the DB module's
 * `normalizedActual` (it re-normalizes the stored value for the singleton compare).
 */
export function normalizeMemoryValue(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A per-key sentinel used as the live-unique index key for singleton facts. */
export function singletonSentinel(key: MemoryFactKey): string {
  return `__singleton__${key}`;
}

/**
 * The dedup/index key for a fact, given its key + already-normalized value: a
 * per-key sentinel for singletons (one live row per key), normalize(value) for
 * lists. The one place both the extractor path and the operator-create path derive
 * the index key, so they can't drift.
 */
export function memoryDedupKey(
  key: MemoryFactKey,
  normalizedValue: string,
): string {
  return isSingletonMemoryKey(key) ? singletonSentinel(key) : normalizedValue;
}

/** One planned memory write for the turn — pure; applied later in-tx (§4.5). */
export interface MemoryWritePlanItem {
  key: MemoryFactKey;
  singleton: boolean;
  value: string;
  valueNumber: number | null;
  /** The index/dedup key: sentinel for singletons, normalize(value) for lists. */
  normalizedValue: string;
  /** The normalized ACTUAL value, for the singleton material-change compare. */
  matchValue: string;
  confidence: number;
  category?: string | undefined;
}

export interface BuildMemoryWritePlanArgs {
  /** The model's extracted facts this turn (may be undefined / empty). */
  creatorFacts?: ExtractedFact[] | undefined;
  /**
   * The already-validated creator ask (MED-N3). Reused to populate
   * REQUESTED_RATE so the memory rate and the copy-side ack rate can't disagree
   * (§4.4). Any REQUESTED_RATE the model also put in creatorFacts is ignored in
   * favor of this validated number.
   */
  creatorRequestedRate?: number | null | undefined;
  /** Facts below this confidence are dropped (§4.5). */
  minConfidence?: number;
}

/**
 * Build the turn's memory write plan (§4.5, §4.6) — pure. The runtime applies each
 * item via upsertMemoryFact inside stepInstance's tx.
 *
 *   1. REQUESTED_RATE is derived from the validated creatorRequestedRate (not the
 *      model's own facts) so it can't disagree with the copy-side ack rate.
 *   2. Every other fact must clear the confidence floor (§4.5) — a low-confidence
 *      extraction is the "unnecessary subjective inference" the issue warns against.
 *   3. Values are normalized; singleton keys get a per-key sentinel index key so
 *      the DB collapses to one live row per key; list keys get normalize(value).
 *   4. Intra-turn dedup: two incoming facts that normalize to the same (key,value)
 *      collapse to one plan item; a duplicate REQUESTED_RATE from the model is
 *      dropped in favor of the derived one.
 */
export function buildMemoryWritePlan(
  args: BuildMemoryWritePlanArgs,
): MemoryWritePlanItem[] {
  const minConfidence = args.minConfidence ?? DEFAULT_MEMORY_MIN_CONFIDENCE;
  const plan: MemoryWritePlanItem[] = [];
  const seen = new Set<string>();

  const push = (item: MemoryWritePlanItem): void => {
    const dedupKey = `${item.key}::${item.normalizedValue}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    plan.push(item);
  };

  // 1. REQUESTED_RATE from the validated ask (§4.4). Always trusted (confidence 1)
  //    since it already passed the MED-N3 substring validation agent-side.
  if (
    typeof args.creatorRequestedRate === "number" &&
    Number.isFinite(args.creatorRequestedRate)
  ) {
    const value = formatRate(args.creatorRequestedRate);
    push({
      key: "REQUESTED_RATE",
      singleton: true,
      value,
      valueNumber: args.creatorRequestedRate,
      normalizedValue: singletonSentinel("REQUESTED_RATE"),
      matchValue: normalizeMemoryValue(value),
      confidence: 1,
    });
  }

  // 2. The model's other extracted facts.
  for (const raw of args.creatorFacts ?? []) {
    if (!raw || typeof raw.value !== "string") continue;
    if (!MEMORY_FACT_KEYS.includes(raw.key)) continue;
    // REQUESTED_RATE is owned by the validated ask above — ignore the model's.
    if (raw.key === "REQUESTED_RATE") continue;

    const value = raw.value.trim();
    if (!value) continue;
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? raw.confidence
        : 0;
    if (confidence < minConfidence) continue; // drop guesses (§4.5)

    const matchValue = normalizeMemoryValue(value);
    if (!matchValue) continue;

    const singleton = isSingletonMemoryKey(raw.key);
    const numeric = isNumericMemoryKey(raw.key);
    const valueNumber = numeric ? coerceRate(value) : null;

    push({
      key: raw.key,
      singleton,
      value,
      valueNumber,
      normalizedValue: singleton ? singletonSentinel(raw.key) : matchValue,
      matchValue,
      confidence,
      ...(raw.category ? { category: raw.category } : {}),
    });
  }

  return plan;
}

/** Stringify a rate the way the DB stores it ("600", not "600.00"). */
function formatRate(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Best-effort numeric coercion of a MINIMUM_RATE the model emitted as text. */
function coerceRate(value: string): number | null {
  const digits = value.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Read payload (§4.8) — sanitized DATA threaded into /negotiate + /draft
// ---------------------------------------------------------------------------

export interface CreatorMemoryConflict {
  key: MemoryFactKey;
  current: string;
  prior: string | null;
}

/**
 * The structured memory payload the agent renders as a sanitized DATA block
 * (§4.8). Only LIVE facts (ACTIVE + CONFLICTED) — the caller passes those rows.
 * requestedRate / minimumRate are CONTEXT (what the creator said they want), NOT
 * the offer figure (invariant #6); the agent block labels them so.
 */
export interface CreatorMemoryPayload {
  requestedRate?: string;
  minimumRate?: string;
  availability?: string;
  logisticsConstraints: string[];
  objections: string[];
  deliverablePreferences: string[];
  compensationPreferences: string[];
  managerInvolved?: boolean;
  managerContact?: string;
  conflicts: CreatorMemoryConflict[];
}

/**
 * Turn the live memory rows into the read payload (§4.8). Pure. Groups by key;
 * for CONFLICTED singleton rows the current value is used and the conflict (both
 * values) is surfaced in `conflicts` so the model sees "was X, now Y". Returns
 * null when there is nothing live — the caller omits the block entirely so the
 * prompt is byte-identical (invariant #8).
 */
export function buildCreatorMemoryBlock(
  rows: CampaignCreatorMemory[],
): CreatorMemoryPayload | null {
  const live = rows.filter(
    (r) => r.status === "ACTIVE" || r.status === "CONFLICTED",
  );
  if (live.length === 0) return null;

  const payload: CreatorMemoryPayload = {
    logisticsConstraints: [],
    objections: [],
    deliverablePreferences: [],
    compensationPreferences: [],
    conflicts: [],
  };

  for (const r of live) {
    switch (r.key) {
      case "REQUESTED_RATE":
        payload.requestedRate = r.value;
        break;
      case "MINIMUM_RATE":
        payload.minimumRate = r.value;
        break;
      case "AVAILABILITY":
        payload.availability = r.value;
        break;
      case "LOGISTICS_CONSTRAINT":
        payload.logisticsConstraints.push(r.value);
        break;
      case "OBJECTION":
        payload.objections.push(r.value);
        break;
      case "DELIVERABLE_PREFERENCE":
        payload.deliverablePreferences.push(r.value);
        break;
      case "COMPENSATION_PREFERENCE":
        payload.compensationPreferences.push(r.value);
        break;
      case "MANAGER_INVOLVED":
        payload.managerInvolved = parseBoolish(r.value);
        break;
      case "MANAGER_CONTACT":
        payload.managerContact = r.value;
        break;
    }
    if (r.status === "CONFLICTED") {
      payload.conflicts.push({
        key: r.key,
        current: r.value,
        prior: r.priorValue,
      });
    }
  }

  return payload;
}

function parseBoolish(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1";
}
