import { and, eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  dealHandoffs,
  type DealHandoff,
  type DealHandoffInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// DealHandoff — the closed-deal snapshot an operator finalizes by hand (PLU-70).
// ---------------------------------------------------------------------------
// One row per ExecutionInstance, enforced by a UNIQUE instanceId. That constraint
// is the whole idempotency story: the handoff executor runs inside a BullMQ job
// that may be retried, so `createDealHandoffOnce` swallows the unique violation
// and returns the row that already exists. The acceptance record is therefore
// written exactly once no matter how many times the step (or the follow-on
// notification) is retried.

/**
 * Insert the acceptance snapshot, or return the existing row if one is already
 * there. Never throws on a duplicate — a retried handoff step is a no-op.
 */
// `client` is injectable (defaults to the top-level `db`) so the insert can enlist
// in an open transaction — PLU-154 writes the DealHandoff in the SAME tx as the
// MANUAL_REVIEW→NEEDS_DEAL_FINALIZATION OCC transition, so a lost race rolls back
// the handoff too (no orphan row). Existing callers pass nothing → unchanged.
export async function createDealHandoffOnce(
  data: DealHandoffInsert,
  client: Db | DbTx = db,
): Promise<DealHandoff> {
  try {
    const rows = await client.insert(dealHandoffs).values(data).returning();
    return rows[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findDealHandoffByInstance(data.instanceId, client);
      if (existing) return existing;
    }
    throw err;
  }
}

export async function findDealHandoffByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<DealHandoff | null> {
  const rows = await client
    .select()
    .from(dealHandoffs)
    .where(eq(dealHandoffs.instanceId, instanceId))
    .limit(1);
  return rows[0] ?? null;
}

/** Handoffs for a set of instances in one query, keyed by instanceId. Used by
 *  the Manual Queue list so each row can show the agreed compensation without
 *  a per-row lookup. */
export async function listDealHandoffsForInstances(
  instanceIds: string[],
): Promise<Map<string, DealHandoff>> {
  if (instanceIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(dealHandoffs)
    .where(inArray(dealHandoffs.instanceId, instanceIds));
  return new Map(rows.map((r) => [r.instanceId, r]));
}

/**
 * Mark a handoff finalized.
 *
 * Idempotent by predicate: the update only matches a row still in
 * AWAITING_FINALIZATION, so a double-click or a retried request cannot overwrite
 * the original completedAt/completedBy with a later one. When nothing matched we
 * return the row as it stands, so the caller can proceed (and, if the instance
 * transition failed on the first attempt, still finish the job) rather than
 * treating an already-completed handoff as an error.
 */
export async function completeDealHandoff(
  instanceId: string,
  opts: { completedBy?: string | null; completedAt?: Date } = {},
): Promise<DealHandoff | null> {
  const rows = await db
    .update(dealHandoffs)
    .set({
      status: "COMPLETED",
      completedAt: opts.completedAt ?? new Date(),
      completedBy: opts.completedBy ?? null,
    })
    .where(
      and(
        eq(dealHandoffs.instanceId, instanceId),
        eq(dealHandoffs.status, "AWAITING_FINALIZATION"),
      ),
    )
    .returning();
  return rows[0] ?? (await findDealHandoffByInstance(instanceId));
}
