import { and, asc, eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  campaignCreatorMemory,
  type CampaignCreatorMemory,
  type MemoryFactKey,
  type MemoryFactStatus,
} from "./schema.js";

// ---------------------------------------------------------------------------
// CampaignCreatorMemory access module (PLU-113)
// ---------------------------------------------------------------------------
// A narrow, campaign-scoped (per-ExecutionInstance) ledger of durable creator
// facts — each a value + provenance + lifecycle, traced to the inbound Message
// that stated it. See .claude/spec/plu-113-campaign-scoped-creator-memory/PLAN.md.
//
// Mirrors conversationObligations.ts: every fn takes `client: Db | DbTx = db` so
// the upsert runs INSIDE stepInstance's transaction (invariant #9, §4.7). The
// insert path catches isUniqueViolation and reloads the raced row (the partial-
// unique `CampaignCreatorMemory_live_key` is the DB backstop against a concurrent
// double-insert, §4.6).
//
// Live (fed to the model) = ACTIVE + CONFLICTED. Non-live = SUPERSEDED + REMOVED.

/** The statuses that keep a fact live (fed to AI + hold the live-unique slot). */
export const LIVE_MEMORY_STATUSES: MemoryFactStatus[] = ["ACTIVE", "CONFLICTED"];

export function isLiveMemoryStatus(status: MemoryFactStatus): boolean {
  return LIVE_MEMORY_STATUSES.includes(status);
}

// Singleton keys hold one live value per instance; their normalizedValue is a
// per-key sentinel (so the live-unique index collapses to one row per key). Kept
// here (not imported from the engine helper) to avoid a db→engine import; must
// stay in sync with creatorMemory.ts's SINGLETON_KEYS.
const SINGLETON_KEYS: ReadonlySet<MemoryFactKey> = new Set<MemoryFactKey>([
  "REQUESTED_RATE",
  "MINIMUM_RATE",
  "AVAILABILITY",
  "MANAGER_INVOLVED",
  "MANAGER_CONTACT",
]);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Live facts (ACTIVE + CONFLICTED) for an instance, oldest-first. This is the
 * AI-context read (§4.8) and the upsert-time conflict lookup source.
 */
export async function listLiveMemoryByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory[]> {
  return client
    .select()
    .from(campaignCreatorMemory)
    .where(
      and(
        eq(campaignCreatorMemory.instanceId, instanceId),
        inArray(campaignCreatorMemory.status, LIVE_MEMORY_STATUSES),
      ),
    )
    .orderBy(asc(campaignCreatorMemory.createdAt));
}

/**
 * Every fact for an instance (any status), oldest-first — for the observability
 * surface (§4.10). Includes SUPERSEDED/REMOVED so an operator can see the full
 * history of what was learned and how it was corrected.
 */
export async function listMemoryByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory[]> {
  return client
    .select()
    .from(campaignCreatorMemory)
    .where(eq(campaignCreatorMemory.instanceId, instanceId))
    .orderBy(asc(campaignCreatorMemory.createdAt));
}

// ---------------------------------------------------------------------------
// Upsert + conflict policy (§4.6 — never silently overwrite)
// ---------------------------------------------------------------------------

export interface UpsertMemoryFactArgs {
  instanceId: string;
  key: MemoryFactKey;
  /** Whether this key holds one live value per instance (§4.1). */
  singleton: boolean;
  /** Canonical value as text (numbers stringified). */
  value: string;
  /** Convenience numeric mirror for the rate facts; null otherwise. */
  valueNumber?: number | null;
  /**
   * Dedup/index key. For LIST keys this is normalize(value). For SINGLETON keys
   * it is a per-key sentinel (so the live-unique index collapses to one row per
   * (instance, key)); the ACTUAL value comparison for conflict uses
   * `matchValue` below, not this sentinel.
   */
  normalizedValue: string;
  /**
   * The normalized ACTUAL value, used to decide "same restatement vs material
   * change" for singleton keys (§4.6). For list keys it equals normalizedValue.
   */
  matchValue: string;
  sourceMessageId?: string | null;
  confidence: number;
  category?: string | null;
}

export interface UpsertMemoryFactResult {
  fact: CampaignCreatorMemory;
  /** "inserted" | "touched" (consistent restatement) | "conflicted" (material change). */
  outcome: "inserted" | "touched" | "conflicted";
}

/**
 * Insert a new fact, touch an existing live one (consistent restatement), or
 * conflict it (material change on a singleton key) — the §4.6 crux.
 *
 * LIST keys (OBJECTION, LOGISTICS_CONSTRAINT, DELIVERABLE_PREFERENCE,
 * COMPENSATION_PREFERENCE): dedup on (instance, key, normalizedValue). Hit → touch
 * (refresh confidence to max, bump updatedAt). Miss → insert a new ACTIVE row
 * (several distinct objections accumulate).
 *
 * SINGLETON keys (REQUESTED_RATE, MINIMUM_RATE, AVAILABILITY, MANAGER_INVOLVED,
 * MANAGER_CONTACT): one live row per (instance, key). No live row → insert ACTIVE.
 * Live row with the SAME value → touch. Live row with a MATERIALLY DIFFERENT value
 * → CONFLICT: update the row to the new value, move the old value into priorValue
 * + priorSourceMessageId, set status=CONFLICTED. The old value is never lost.
 *
 * Idempotent under a concurrent double-insert: the partial-unique index rejects
 * the second insert, we catch isUniqueViolation, reload the raced row, and retry
 * the touch/conflict path against it.
 */
export async function upsertMemoryFact(
  args: UpsertMemoryFactArgs,
  client: Db | DbTx = db,
): Promise<UpsertMemoryFactResult> {
  const existing = args.singleton
    ? await findLiveSingleton(args.instanceId, args.key, client)
    : await findLiveByNormalizedValue(
        args.instanceId,
        args.key,
        args.normalizedValue,
        client,
      );

  if (existing) {
    return applyToExisting(existing, args, client);
  }

  try {
    const rows = await client
      .insert(campaignCreatorMemory)
      .values({
        instanceId: args.instanceId,
        key: args.key,
        status: "ACTIVE",
        value: args.value,
        valueNumber: args.valueNumber ?? null,
        normalizedValue: args.normalizedValue,
        confidence: args.confidence,
        source: "ai",
        ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
        ...(args.category ? { category: args.category } : {}),
      })
      .returning();
    return { fact: rows[0]!, outcome: "inserted" };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent writer won the race — the live row is now present under our
    // key/value. Reload it and fall through to the touch/conflict path.
    const raced = args.singleton
      ? await findLiveSingleton(args.instanceId, args.key, client)
      : await findLiveByNormalizedValue(
          args.instanceId,
          args.key,
          args.normalizedValue,
          client,
        );
    if (raced) return applyToExisting(raced, args, client);
    throw err;
  }
}

/**
 * Reconcile an incoming fact against the existing live row: touch on a consistent
 * restatement, conflict on a material singleton change (§4.6). List keys only
 * ever reach here on an exact-normalizedValue hit → always a touch.
 */
async function applyToExisting(
  existing: CampaignCreatorMemory,
  args: UpsertMemoryFactArgs,
  client: Db | DbTx,
): Promise<UpsertMemoryFactResult> {
  const now = new Date();

  // Material-difference test (§4.6): numeric keys compare valueNumber; everything
  // else compares the normalized ACTUAL value. List keys reached here on an exact
  // normalizedValue hit, so they are never "material" (matchValue equals).
  const material =
    args.singleton &&
    (typeof args.valueNumber === "number" && existing.valueNumber !== null
      ? args.valueNumber !== existing.valueNumber
      : normalizedActual(existing) !== args.matchValue);

  if (!material) {
    // Consistent restatement (or a list dedup hit): refresh confidence to the max
    // seen and bump updatedAt. Do not overwrite the value or provenance.
    const nextConfidence = Math.max(existing.confidence, args.confidence);
    const rows = await client
      .update(campaignCreatorMemory)
      .set({ confidence: nextConfidence, updatedAt: now })
      .where(eq(campaignCreatorMemory.id, existing.id))
      .returning();
    return { fact: rows[0] ?? existing, outcome: "touched" };
  }

  // Material change on a singleton key → CONFLICT. Adopt the new value, retain the
  // prior value + its source, flag CONFLICTED. Never silently overwrite.
  const rows = await client
    .update(campaignCreatorMemory)
    .set({
      status: "CONFLICTED",
      value: args.value,
      valueNumber: args.valueNumber ?? null,
      confidence: args.confidence,
      source: "ai",
      sourceMessageId: args.sourceMessageId ?? null,
      priorValue: existing.value,
      priorSourceMessageId: existing.sourceMessageId,
      updatedAt: now,
    })
    .where(eq(campaignCreatorMemory.id, existing.id))
    .returning();
  return { fact: rows[0] ?? existing, outcome: "conflicted" };
}

/**
 * The normalized ACTUAL value of a stored singleton row, for the material-change
 * comparison. We store the per-key sentinel in normalizedValue (so the live-unique
 * index enforces one row per key), so we cannot compare on that column; instead we
 * normalize the stored `value` the same way the incoming matchValue was produced.
 * Kept in-module and value-only so it stays a pure lowercase/trim/collapse — the
 * canonical normalize lives in the executor helper (normalizeMemoryValue) and is
 * the source both sides run; this mirror is intentionally identical in shape.
 */
function normalizedActual(row: CampaignCreatorMemory): string {
  return row.value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The single live row for a singleton key (via the per-key sentinel index). */
async function findLiveSingleton(
  instanceId: string,
  key: MemoryFactKey,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory | null> {
  const rows = await client
    .select()
    .from(campaignCreatorMemory)
    .where(
      and(
        eq(campaignCreatorMemory.instanceId, instanceId),
        eq(campaignCreatorMemory.key, key),
        inArray(campaignCreatorMemory.status, LIVE_MEMORY_STATUSES),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The live row for a list key with an exact normalizedValue match. */
async function findLiveByNormalizedValue(
  instanceId: string,
  key: MemoryFactKey,
  normalizedValue: string,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory | null> {
  const rows = await client
    .select()
    .from(campaignCreatorMemory)
    .where(
      and(
        eq(campaignCreatorMemory.instanceId, instanceId),
        eq(campaignCreatorMemory.key, key),
        eq(campaignCreatorMemory.normalizedValue, normalizedValue),
        inArray(campaignCreatorMemory.status, LIVE_MEMORY_STATUSES),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Operator create + correct (§4.10)
// ---------------------------------------------------------------------------

export interface OperatorCreateMemoryArgs {
  instanceId: string;
  key: MemoryFactKey;
  singleton: boolean;
  value: string;
  valueNumber?: number | null;
  normalizedValue: string;
  category?: string | null;
  note?: string | null;
}

/**
 * Create a purely operator-authored fact (O7): no AI extraction, no source
 * message. source="operator", confidence=1.0. Routed through upsert semantics so
 * a duplicate operator entry touches rather than double-inserts, and a
 * singleton whose value differs from a live one conflicts as usual (the operator
 * then RESOLVE_CONFLICTs it). We set source/confidence explicitly afterward
 * because upsertMemoryFact stamps "ai" on its writes.
 */
export async function createOperatorMemoryFact(
  args: OperatorCreateMemoryArgs,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory> {
  const res = await upsertMemoryFact(
    {
      instanceId: args.instanceId,
      key: args.key,
      singleton: args.singleton,
      value: args.value,
      valueNumber: args.valueNumber ?? null,
      normalizedValue: args.normalizedValue,
      matchValue: args.normalizedValue,
      sourceMessageId: null,
      confidence: 1,
      ...(args.category ? { category: args.category } : {}),
    },
    client,
  );
  const rows = await client
    .update(campaignCreatorMemory)
    .set({
      source: "operator",
      confidence: 1,
      sourceMessageId: null,
      ...(args.note ? { note: args.note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(campaignCreatorMemory.id, res.fact.id))
    .returning();
  return rows[0] ?? res.fact;
}

export type CorrectMemoryAction = "EDIT" | "RESOLVE_CONFLICT" | "REMOVE";

export interface CorrectMemoryArgs {
  action: CorrectMemoryAction;
  /** New value (EDIT), or the value to keep as authoritative (RESOLVE_CONFLICT). */
  value?: string | null;
  valueNumber?: number | null;
  normalizedValue?: string | null;
  note?: string | null;
}

/**
 * Operator correction of one fact (§4.10). Idempotent; operator writes carry
 * source="operator", confidence=1.0.
 *
 *   EDIT            → set a new value (+ valueNumber/normalizedValue), retain the
 *                     old value in priorValue, status → ACTIVE (clears a conflict).
 *   RESOLVE_CONFLICT→ the operator picks the authoritative value: if `value` is
 *                     given it becomes the value; otherwise the current value
 *                     stands. status → ACTIVE, the prior trail is retained.
 *   REMOVE          → status → REMOVED (drops out of context; kept for audit).
 */
export async function correctMemoryFact(
  id: string,
  args: CorrectMemoryArgs,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory | null> {
  const rows = await client
    .select()
    .from(campaignCreatorMemory)
    .where(eq(campaignCreatorMemory.id, id))
    .limit(1);
  const existing = rows[0];
  if (!existing) return null;

  const now = new Date();

  if (args.action === "REMOVE") {
    const updated = await client
      .update(campaignCreatorMemory)
      .set({
        status: "REMOVED",
        source: "operator",
        ...(args.note ? { note: args.note } : {}),
        updatedAt: now,
      })
      .where(eq(campaignCreatorMemory.id, id))
      .returning();
    return updated[0] ?? existing;
  }

  if (args.action === "EDIT") {
    const nextValue =
      typeof args.value === "string" ? args.value : existing.value;
    // A singleton row keeps its per-key sentinel as normalizedValue (the index key
    // that enforces one-live-row-per-key); only a LIST row adopts a new
    // normalize(value). So the operator-supplied normalizedValue is ignored for
    // singletons — its dedup key never changes.
    const nextNormalized = SINGLETON_KEYS.has(existing.key)
      ? existing.normalizedValue
      : typeof args.normalizedValue === "string" && args.normalizedValue
        ? args.normalizedValue
        : existing.normalizedValue;
    const updated = await client
      .update(campaignCreatorMemory)
      .set({
        status: "ACTIVE",
        value: nextValue,
        valueNumber:
          args.valueNumber !== undefined
            ? args.valueNumber
            : existing.valueNumber,
        normalizedValue: nextNormalized,
        source: "operator",
        confidence: 1,
        // Keep the old value visible as the prior only when it actually changed.
        ...(nextValue !== existing.value
          ? {
              priorValue: existing.value,
              priorSourceMessageId: existing.sourceMessageId,
            }
          : {}),
        ...(args.note ? { note: args.note } : {}),
        updatedAt: now,
      })
      .where(eq(campaignCreatorMemory.id, id))
      .returning();
    return updated[0] ?? existing;
  }

  // RESOLVE_CONFLICT: operator picks the authoritative value; clear the conflict.
  const nextValue = typeof args.value === "string" ? args.value : existing.value;
  const changed = nextValue !== existing.value;
  // Singleton rows keep their sentinel index key; only list rows may re-key.
  const resolveNormalized =
    !SINGLETON_KEYS.has(existing.key) &&
    typeof args.normalizedValue === "string" &&
    args.normalizedValue
      ? args.normalizedValue
      : undefined;
  const updated = await client
    .update(campaignCreatorMemory)
    .set({
      status: "ACTIVE",
      value: nextValue,
      ...(args.valueNumber !== undefined
        ? { valueNumber: args.valueNumber }
        : {}),
      ...(resolveNormalized !== undefined
        ? { normalizedValue: resolveNormalized }
        : {}),
      source: "operator",
      confidence: 1,
      // If the operator chose the PRIOR value, swap the trail so the retained
      // prior reflects the value that was dropped.
      ...(changed
        ? { priorValue: existing.value, priorSourceMessageId: existing.sourceMessageId }
        : {}),
      ...(args.note ? { note: args.note } : {}),
      updatedAt: now,
    })
    .where(eq(campaignCreatorMemory.id, id))
    .returning();
  return updated[0] ?? existing;
}
