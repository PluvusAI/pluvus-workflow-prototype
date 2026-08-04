import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  campaignCreatorMemory,
  campaignCreatorMemoryRevision,
  failedMemoryWrite,
  type CampaignCreatorMemory,
  type CampaignCreatorMemoryRevision,
  type FailedMemoryWrite,
  type JsonValue,
  memoryFactKeyEnum,
} from "./schema.js";
import {
  isNumericMemoryKey,
  MEMORY_KEY_METADATA,
  type MemoryFactKey,
  type MemoryWritePlanItem,
} from "../engine/memoryKeys.js";

// ---------------------------------------------------------------------------
// Campaign-scoped creator-memory access module (PLU-113)
// ---------------------------------------------------------------------------
// The CampaignCreatorMemory row is the LIVE HEAD (one per fact); every value it
// ever held is an immutable CampaignCreatorMemoryRevision (Calvin review #4), so
// no earlier value is lost. Writes are `client: Db | DbTx = db`-injectable so the
// turn's plan applies INSIDE stepInstance's transaction, atomic with the state
// write + NEGOTIATION_TURN event. Operator edits (review #5) and failed-write
// recovery (review #6) are separate paths.
//
// Compile-time guard (review #7): the pgEnum members MUST match MEMORY_KEY_METADATA
// in engine/memoryKeys.ts — the single source of truth. This bidirectional type
// assertion fails the build if the two ever drift (a key added to one but not the
// other collapses one side to `never`).
type _AssertKeysMatch =
  (typeof memoryFactKeyEnum.enumValues)[number] extends MemoryFactKey
    ? MemoryFactKey extends (typeof memoryFactKeyEnum.enumValues)[number]
      ? true
      : never
    : never;
const _assertKeysMatch: _AssertKeysMatch = true;
void _assertKeysMatch;

/** The statuses that keep a fact LIVE (read into AI context + hold the dedup slot). */
export const LIVE_MEMORY_STATUSES = ["ACTIVE", "CONFLICTED"] as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The LIVE memory heads for an instance (ACTIVE/CONFLICTED), oldest-first. This is
 * the single read the context-builder loader uses (Calvin review #2). SUPERSEDED/
 * REMOVED heads are excluded — they are history, surfaced only in the operator read.
 */
export async function listLiveCreatorMemory(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory[]> {
  return client
    .select()
    .from(campaignCreatorMemory)
    .where(
      and(
        eq(campaignCreatorMemory.instanceId, instanceId),
        inArray(campaignCreatorMemory.status, [...LIVE_MEMORY_STATUSES]),
      ),
    )
    .orderBy(asc(campaignCreatorMemory.createdAt));
}

export interface CreatorMemoryWithRevisions {
  fact: CampaignCreatorMemory;
  revisions: CampaignCreatorMemoryRevision[];
}

/**
 * Every fact for an instance (ANY status) with its FULL immutable revision history,
 * newest revision first — the operator observability read (review #4, #8). Includes
 * SUPERSEDED/REMOVED heads so an operator sees the complete audit trail.
 */
export async function listCreatorMemoryWithRevisions(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<CreatorMemoryWithRevisions[]> {
  const facts = await client
    .select()
    .from(campaignCreatorMemory)
    .where(eq(campaignCreatorMemory.instanceId, instanceId))
    .orderBy(asc(campaignCreatorMemory.createdAt));
  if (facts.length === 0) return [];
  const revisions = await client
    .select()
    .from(campaignCreatorMemoryRevision)
    .where(
      inArray(
        campaignCreatorMemoryRevision.memoryId,
        facts.map((f) => f.id),
      ),
    )
    .orderBy(desc(campaignCreatorMemoryRevision.createdAt));
  const byFact = new Map<string, CampaignCreatorMemoryRevision[]>();
  for (const r of revisions) {
    const list = byFact.get(r.memoryId) ?? [];
    list.push(r);
    byFact.set(r.memoryId, list);
  }
  return facts.map((fact) => ({ fact, revisions: byFact.get(fact.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// Write-plan application (the turn's creator-sourced facts) — §ledger
// ---------------------------------------------------------------------------

/**
 * Apply this turn's memory write plan (creator-sourced). For each item: append an
 * immutable revision, then upsert the live head. Runs inside the caller's
 * transaction. Returns a count summary for observability.
 *
 * Semantics per key kind:
 *   * List key: one live row per distinct normalized value. A repeat of the same
 *     value no-ops (idempotent via the live-unique index); a new distinct value
 *     adds a new fact.
 *   * Singleton key: one live row per (instance, key). The FIRST value creates it.
 *     A materially-different value SUPERSEDES the old head into history and creates
 *     a new head marked CONFLICTED, carrying the prior value/source as the conflict
 *     pair — the model sees "was X, now Y" and nothing is silently overwritten
 *     (Calvin review). The same value just appends a confirming revision.
 */
export interface ApplyMemoryPlanResult {
  created: number;
  updated: number;
  conflicted: number;
  unchanged: number;
}

export async function applyMemoryWritePlan(
  instanceId: string,
  items: MemoryWritePlanItem[],
  client: Db | DbTx = db,
): Promise<ApplyMemoryPlanResult> {
  const result: ApplyMemoryPlanResult = {
    created: 0,
    updated: 0,
    conflicted: 0,
    unchanged: 0,
  };
  for (const item of items) {
    const outcome = await applyOneMemoryItem(instanceId, item, client);
    result[outcome] += 1;
  }
  return result;
}

type OneItemOutcome = keyof ApplyMemoryPlanResult;

async function applyOneMemoryItem(
  instanceId: string,
  item: MemoryWritePlanItem,
  client: Db | DbTx,
): Promise<OneItemOutcome> {
  const singleton = MEMORY_KEY_METADATA[item.key].singleton;

  // The existing LIVE head under this (instance, key, normalizedValue). For a
  // singleton the normalizedValue is the per-key sentinel, so this finds THE live
  // head for the key regardless of its current value; for a list key it finds only
  // an exact-value match.
  const [existing] = await client
    .select()
    .from(campaignCreatorMemory)
    .where(
      and(
        eq(campaignCreatorMemory.instanceId, instanceId),
        eq(campaignCreatorMemory.key, item.key),
        eq(campaignCreatorMemory.normalizedValue, item.normalizedValue),
        inArray(campaignCreatorMemory.status, [...LIVE_MEMORY_STATUSES]),
      ),
    )
    .limit(1);

  if (!existing) {
    await insertFactWithRevision(instanceId, item, "ACTIVE", null, null, client);
    return "created";
  }

  const sameValue = normalizedMatchesHead(existing.value, item);
  if (!singleton) {
    // List key with an exact live match already present — append a confirming
    // revision (audit) but the head is unchanged.
    if (sameValue) {
      await appendCreatorRevision(existing.id, item, client);
      return "unchanged";
    }
    // A list key never collides on a different value (its normalizedValue differs),
    // so this branch is unreachable; guard it as "created" for safety.
    await insertFactWithRevision(instanceId, item, "ACTIVE", null, null, client);
    return "created";
  }

  // Singleton key with a live head. Same value → confirming revision only.
  if (sameValue) {
    await appendCreatorRevision(existing.id, item, client);
    return "unchanged";
  }

  // Singleton MATERIAL change (Calvin — never silently overwrite). Supersede the
  // old head into history (its revisions stay), then create a fresh CONFLICTED head
  // carrying the prior value + its source as the conflict pair. Nothing is lost.
  const priorSourceMessageId = await headSourceMessageId(existing, client);
  await client
    .update(campaignCreatorMemory)
    .set({ status: "SUPERSEDED", updatedAt: new Date() })
    .where(eq(campaignCreatorMemory.id, existing.id));

  await insertFactWithRevision(
    instanceId,
    item,
    "CONFLICTED",
    existing.value,
    priorSourceMessageId,
    client,
  );
  return "conflicted";
}

/** Whether a head's stored value normalizes equal to the incoming item's actual
 *  value — the material-change test (numeric keys compare their numeric mirror). */
function normalizedMatchesHead(headValue: string, item: MemoryWritePlanItem): boolean {
  if (isNumericMemoryKey(item.key)) {
    const headNum = Number(headValue.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(headNum) && item.valueNumber !== null) {
      return headNum === item.valueNumber;
    }
  }
  return normalizeForCompare(headValue) === item.matchValue;
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A head does not itself store a sourceMessageId; its provenance lives on the
 *  current revision. For the conflict pair we resolve the prior value's source by
 *  reading the head's current revision. Returns null when unavailable (an operator-
 *  authored current revision has no source message — review #5). */
async function headSourceMessageId(
  head: CampaignCreatorMemory,
  client: Db | DbTx,
): Promise<string | null> {
  if (!head.currentRevisionId) return null;
  const [rev] = await client
    .select()
    .from(campaignCreatorMemoryRevision)
    .where(eq(campaignCreatorMemoryRevision.id, head.currentRevisionId))
    .limit(1);
  return rev?.sourceMessageId ?? null;
}

/** Insert a new head + its first (creator) revision, wiring currentRevisionId. */
async function insertFactWithRevision(
  instanceId: string,
  item: MemoryWritePlanItem,
  status: "ACTIVE" | "CONFLICTED",
  conflictValue: string | null,
  conflictSourceMessageId: string | null,
  client: Db | DbTx,
): Promise<CampaignCreatorMemory> {
  const [head] = await client
    .insert(campaignCreatorMemory)
    .values({
      instanceId,
      key: item.key,
      status,
      value: item.value,
      valueNumber: item.valueNumber,
      normalizedValue: item.normalizedValue,
      ...(item.category ? { category: item.category } : {}),
      ...(conflictValue !== null ? { conflictValue } : {}),
      ...(conflictSourceMessageId
        ? { conflictSourceMessageId }
        : {}),
    })
    .returning();
  const [rev] = await client
    .insert(campaignCreatorMemoryRevision)
    .values({
      memoryId: head!.id,
      value: item.value,
      valueNumber: item.valueNumber,
      source: "creator",
      sourceMessageId: item.sourceMessageId,
      evidenceText: item.evidenceText,
      confidence: item.confidence,
    })
    .returning();
  const [updated] = await client
    .update(campaignCreatorMemory)
    .set({ currentRevisionId: rev!.id, updatedAt: new Date() })
    .where(eq(campaignCreatorMemory.id, head!.id))
    .returning();
  return updated!;
}

/** Append a confirming creator revision to an existing head (value unchanged). */
async function appendCreatorRevision(
  memoryId: string,
  item: MemoryWritePlanItem,
  client: Db | DbTx,
): Promise<void> {
  const [rev] = await client
    .insert(campaignCreatorMemoryRevision)
    .values({
      memoryId,
      value: item.value,
      valueNumber: item.valueNumber,
      source: "creator",
      sourceMessageId: item.sourceMessageId,
      evidenceText: item.evidenceText,
      confidence: item.confidence,
    })
    .returning();
  await client
    .update(campaignCreatorMemory)
    .set({ currentRevisionId: rev!.id, updatedAt: new Date() })
    .where(eq(campaignCreatorMemory.id, memoryId));
}

// ---------------------------------------------------------------------------
// Operator edits (Calvin review #5) — unambiguous operator provenance
// ---------------------------------------------------------------------------

/**
 * An operator corrects a fact's live value. Appends an OPERATOR revision (source=
 * operator, NO sourceMessageId — the value did not come from a creator message),
 * updates the head value + recalculates the numeric mirror, and clears any conflict
 * (status → ACTIVE) — an operator edit is a deliberate reconciliation. The prior
 * revisions stay attached (history intact). Returns null if the fact does not exist.
 */
export async function operatorCorrectFact(
  memoryId: string,
  opts: { value: string; note?: string | null },
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory | null> {
  const [head] = await client
    .select()
    .from(campaignCreatorMemory)
    .where(eq(campaignCreatorMemory.id, memoryId))
    .limit(1);
  if (!head) return null;

  const key = head.key as MemoryFactKey;
  const valueNumber = isNumericMemoryKey(key) ? coerceNumber(opts.value) : null;

  const [rev] = await client
    .insert(campaignCreatorMemoryRevision)
    .values({
      memoryId,
      value: opts.value,
      valueNumber,
      source: "operator",
      // NO sourceMessageId (review #5) — the previous source stays only on the
      // historical creator revision, never presented as the operator value's source.
      confidence: 1,
      ...(opts.note ? { note: opts.note } : {}),
    })
    .returning();

  const [updated] = await client
    .update(campaignCreatorMemory)
    .set({
      value: opts.value,
      valueNumber,
      status: "ACTIVE",
      currentRevisionId: rev!.id,
      // Clear the conflict pair — the operator has reconciled it.
      conflictValue: null,
      conflictSourceMessageId: null,
      updatedAt: new Date(),
    })
    .where(eq(campaignCreatorMemory.id, memoryId))
    .returning();
  return updated ?? null;
}

/** An operator removes a fact (soft): head → REMOVED, revisions kept for audit. */
export async function operatorRemoveFact(
  memoryId: string,
  note: string | null,
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory | null> {
  const [rev] = await client
    .insert(campaignCreatorMemoryRevision)
    .values({
      memoryId,
      value: "",
      source: "operator",
      confidence: 1,
      ...(note ? { note } : {}),
    })
    .returning();
  const [updated] = await client
    .update(campaignCreatorMemory)
    .set({ status: "REMOVED", currentRevisionId: rev!.id, updatedAt: new Date() })
    .where(eq(campaignCreatorMemory.id, memoryId))
    .returning();
  return updated ?? null;
}

/**
 * An operator creates a fact by hand (source=operator). Used to record something a
 * creator said out-of-band, or to seed a known constraint. Numeric mirror computed
 * for numeric keys. Returns null on a live-unique collision (an operator trying to
 * add a value that already lives).
 */
export async function operatorCreateFact(
  instanceId: string,
  opts: {
    key: MemoryFactKey;
    value: string;
    normalizedValue: string;
    category?: string | null;
    note?: string | null;
  },
  client: Db | DbTx = db,
): Promise<CampaignCreatorMemory | null> {
  const valueNumber = isNumericMemoryKey(opts.key) ? coerceNumber(opts.value) : null;
  const [head] = await client
    .insert(campaignCreatorMemory)
    .values({
      instanceId,
      key: opts.key,
      status: "ACTIVE",
      value: opts.value,
      valueNumber,
      normalizedValue: opts.normalizedValue,
      ...(opts.category ? { category: opts.category } : {}),
    })
    .returning();
  const [rev] = await client
    .insert(campaignCreatorMemoryRevision)
    .values({
      memoryId: head!.id,
      value: opts.value,
      valueNumber,
      source: "operator",
      confidence: 1,
      ...(opts.note ? { note: opts.note } : {}),
    })
    .returning();
  const [updated] = await client
    .update(campaignCreatorMemory)
    .set({ currentRevisionId: rev!.id, updatedAt: new Date() })
    .where(eq(campaignCreatorMemory.id, head!.id))
    .returning();
  return updated ?? null;
}

function coerceNumber(value: string): number | null {
  const digits = value.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Failed memory writes (Calvin review #6) — recoverable, operator-visible
// ---------------------------------------------------------------------------

/**
 * Record a memory write plan that failed to apply, so it is not lost to stdout. The
 * creator turn stays fail-soft; this row is written OUTSIDE the failed tx (its own
 * write) so a rolled-back memory tx still leaves a recoverable trace.
 */
export async function recordFailedMemoryWrite(
  args: {
    instanceId: string;
    plan: MemoryWritePlanItem[];
    sourceMessageId?: string | null;
    error: string;
  },
  client: Db | DbTx = db,
): Promise<FailedMemoryWrite> {
  const [row] = await client
    .insert(failedMemoryWrite)
    .values({
      instanceId: args.instanceId,
      plan: args.plan as unknown as JsonValue,
      ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
      error: args.error.slice(0, 2000),
    })
    .returning();
  return row!;
}

/** Pending failed writes for an instance (operator surface + retry sweep source). */
export async function listPendingFailedMemoryWrites(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<FailedMemoryWrite[]> {
  return client
    .select()
    .from(failedMemoryWrite)
    .where(
      and(
        eq(failedMemoryWrite.instanceId, instanceId),
        eq(failedMemoryWrite.status, "PENDING"),
      ),
    )
    .orderBy(asc(failedMemoryWrite.createdAt));
}

/** Mark a failed write resolved (REDRIVEN after a successful retry, or DISCARDED by
 *  an operator). Idempotent on the PENDING predicate. */
export async function resolveFailedMemoryWrite(
  id: string,
  status: "REDRIVEN" | "DISCARDED",
  client: Db | DbTx = db,
): Promise<void> {
  const now = new Date();
  await client
    .update(failedMemoryWrite)
    .set({ status, resolvedAt: now, updatedAt: now })
    .where(
      and(eq(failedMemoryWrite.id, id), eq(failedMemoryWrite.status, "PENDING")),
    );
}
