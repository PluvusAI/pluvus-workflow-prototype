import { and, asc, count, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  executionInstances,
  type ExecutionInstance,
  type ExecutionInstanceInsert,
  type InstanceState,
} from "./schema.js";

/** The mutable state/scheduling fields a workflow step may patch. */
export type InstancePatch = Partial<
  Pick<
    ExecutionInstanceInsert,
    | "currentState"
    | "currentNodeId"
    | "followUpCount"
    | "negotiationRound"
    | "negotiationFollowUpCount"
    | "dueAt"
    | "completedAt"
  >
>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function findInstanceById(id: string): Promise<ExecutionInstance | null> {
  const rows = await db
    .select()
    .from(executionInstances)
    .where(eq(executionInstances.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findInstanceByCreatorAndVersion(
  creatorId: string,
  workflowVersionId: string,
): Promise<ExecutionInstance | null> {
  const rows = await db
    .select()
    .from(executionInstances)
    .where(
      and(
        eq(executionInstances.workflowVersionId, workflowVersionId),
        eq(executionInstances.creatorId, creatorId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listInstancesByVersion(
  workflowVersionId: string,
): Promise<ExecutionInstance[]> {
  return db
    .select()
    .from(executionInstances)
    .where(eq(executionInstances.workflowVersionId, workflowVersionId))
    .orderBy(asc(executionInstances.enrolledAt));
}

export async function listInstancesByState(
  state: InstanceState,
): Promise<ExecutionInstance[]> {
  return db
    .select()
    .from(executionInstances)
    .where(eq(executionInstances.currentState, state))
    .orderBy(asc(executionInstances.updatedAt));
}

/** Returns per-node creator counts for the pipeline visualization. */
export async function countInstancesByNode(
  workflowVersionId: string,
): Promise<Array<{ currentNodeId: string | null; _count: number }>> {
  return db
    .select({
      currentNodeId: executionInstances.currentNodeId,
      _count: count(),
    })
    .from(executionInstances)
    .where(eq(executionInstances.workflowVersionId, workflowVersionId))
    .groupBy(executionInstances.currentNodeId);
}

// ---------------------------------------------------------------------------
// Write  (workers are the only callers in Phase 3+; these are the hooks)
// ---------------------------------------------------------------------------

export async function createInstance(
  data: ExecutionInstanceInsert,
): Promise<ExecutionInstance> {
  const rows = await db.insert(executionInstances).values(data).returning();
  return rows[0]!;
}

export async function updateInstanceState(
  id: string,
  patch: InstancePatch,
): Promise<ExecutionInstance> {
  const rows = await db
    .update(executionInstances)
    .set(patch)
    .where(eq(executionInstances.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; callers treat a missing instance as fatal.
    throw new Error(`ExecutionInstance ${id} not found`);
  }
  return updated;
}

/**
 * Optimistic concurrency control variant of updateInstanceState.
 *
 * Adds `currentState = expectedCurrentState` to the WHERE clause. If the
 * instance has already moved to a different state (concurrent worker), the
 * UPDATE matches 0 rows and this returns null — it never throws for the
 * lose-the-race case. Callers branch on the null.
 *
 * BUG-E1: an optional `expectedVersion` tightens the predicate to
 * (currentState AND version) and the SET bumps `version = version + 1`. This is
 * what guards X→X SELF-transitions: currentState alone matches on every
 * concurrent attempt (both read state X, both write X), so without the version
 * check two writers would both commit → double events + double side effects.
 * With it, the first writer bumps the version and the second matches the stale
 * version → 0 rows → clean no-op. When `expectedVersion` is omitted (legacy /
 * tests that don't thread it), behavior is the state-only OCC as before, but the
 * version is STILL bumped so the counter stays monotonic for any caller that
 * does check it.
 *
 * `client` is injectable so the OCC race test can run against an embedded
 * Postgres (PGlite) with the real migration DDL applied, AND so the runtime can
 * enlist this write in the same transaction as the follow-on event append (W-7).
 */
export async function updateInstanceStateConditional(
  id: string,
  expectedCurrentState: InstanceState,
  patch: InstancePatch,
  client: Db | DbTx = db,
  expectedVersion?: number,
): Promise<ExecutionInstance | null> {
  const predicates = [
    eq(executionInstances.id, id),
    eq(executionInstances.currentState, expectedCurrentState),
  ];
  if (expectedVersion !== undefined) {
    predicates.push(eq(executionInstances.version, expectedVersion));
  }
  const rows = await client
    .update(executionInstances)
    .set({ ...patch, version: sql`${executionInstances.version} + 1` })
    .where(and(...predicates))
    .returning();
  return rows[0] ?? null;
}

// HARD-R1: cap how many instances a single poll pulls, so a large backlog is
// drained in bounded batches (successive polls pick up the rest) rather than one
// unbounded query loading the whole table into memory at once.
const POLL_BATCH_LIMIT = 200;

/**
 * Returns instances whose dueAt is in the past and whose current state is one the
 * scheduler should act on (AWAITING_REPLY, FOLLOWED_UP). Used by the scheduler
 * poller every 30 s. Bounded by POLL_BATCH_LIMIT (HARD-R1) and index-backed by
 * the (currentState, dueAt) composite index.
 */
export async function listDueInstances(
  now: Date = new Date(),
): Promise<ExecutionInstance[]> {
  return db
    .select()
    .from(executionInstances)
    .where(
      and(
        lte(executionInstances.dueAt, now),
        inArray(executionInstances.currentState, ["AWAITING_REPLY", "FOLLOWED_UP"]),
      ),
    )
    .orderBy(asc(executionInstances.dueAt))
    .limit(POLL_BATCH_LIMIT);
}

// HARD-R1: the TRANSIENT non-terminal states — ones a crash/Redis blip between an
// OCC commit and the follow-on enqueue can strand invisibly. These are the states
// the reconciliation sweep re-enqueues. Deliberately EXCLUDES the genuinely
// WAITING states (AWAITING_REPLY — always carries a future dueAt, covered by the
// due poller; REWARD_PENDING/PAYMENT_PENDING — parked on an external reply/form):
// re-enqueuing those would spam, not recover.
//
// W-2: FOLLOWED_UP is INCLUDED. It looks like a waiting state but is actually
// transient: executeFollowUp commits FOLLOWED_UP with dueAt=null and relies on the
// auto-chain enqueue to reschedule it straight back to AWAITING_REPLY (Case 2 in
// followUp.ts — a pure reschedule, no send, safe to re-run). If that enqueue is
// lost (crash/Redis blip), the due poller CANNOT recover it (its WHERE requires
// dueAt <= now, and dueAt is null) — so this was the one stranding mode with NO
// recovery. The sweep only re-enqueues rows whose updatedAt is past the stale
// window, so a FOLLOWED_UP instance that auto-chains normally (within one job
// cycle) is never swept; only a genuinely-stuck one is.
//
// Exported so the H8 reconciliation-coverage test can assert the selection set
// directly — specifically that NEGOTIATING and REPLY_RECEIVED are recovered (the
// review flagged sweep coverage of those two as unverified) and that the true
// WAITING states are NOT swept. The DB query below is the only consumer.
export const RECONCILE_STATES: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_SENT",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_CONFIRMED",
  "PAYMENT_RECEIVED",
];

/**
 * Returns instances stuck in a TRANSIENT non-terminal state whose last update is
 * older than `staleBefore` (HARD-R1 reconciliation sweep). An instance sitting in
 * one of these states well past the moment it should have auto-advanced was
 * almost certainly stranded by a crash between its state commit and the follow-on
 * job enqueue. Bounded by POLL_BATCH_LIMIT; index-backed by (currentState, dueAt).
 */
export async function listStuckInstances(
  staleBefore: Date,
): Promise<ExecutionInstance[]> {
  return db
    .select()
    .from(executionInstances)
    .where(
      and(
        inArray(executionInstances.currentState, RECONCILE_STATES),
        lt(executionInstances.updatedAt, staleBefore),
      ),
    )
    .orderBy(asc(executionInstances.updatedAt))
    .limit(POLL_BATCH_LIMIT);
}
