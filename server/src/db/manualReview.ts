// ---------------------------------------------------------------------------
// Manual-review case resolution + timeout — DB layer (PLU-154)
// ---------------------------------------------------------------------------
// A MANUAL_REVIEW "case" is the ExecutionInstance itself while it is parked for a
// human. There is NO new case table: identity/reason/entered-at reconstruct from
// the append-only Event log, the deadline reuses the instance's dueAt column, and
// final approved terms reuse the existing DealHandoff side table. This mirrors the
// audit-on-events + OCC-CAS pattern PLU-153 established for campaign lifecycle.
//
// resolveManualReviewCase is the ONE atomic write for every terminal outcome
// (approve / reject / opt-out / timeout): it does the state transition, the
// optional DealHandoff insert, and both audit events in a single transaction, so
// a lost OCC race rolls the whole thing back. Only one terminal resolution can win.

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  events as eventsTable,
  executionInstances,
  negotiationPolicySnapshots,
  type Event,
  type ExecutionInstance,
  type InputJsonValue,
  type InstanceState,
  type NegotiationPolicySnapshot,
} from "./schema.js";
import { appendEvent } from "./events.js";
import { updateInstanceStateConditional } from "./instances.js";
import { createDealHandoffOnce } from "./dealHandoffs.js";
import { assertTransition } from "../engine/stateMachine.js";

/** The four terminal outcomes a MANUAL_REVIEW case can resolve to. */
export type ManualReviewOutcome =
  | "NEEDS_DEAL_FINALIZATION" // approve / finalize
  | "REJECTED" // brand reject / close
  | "OPTED_OUT" // creator withdrew
  | "EXPIRED"; // timeout

/** Final creator-specific terms captured on an approve (all optional). */
export interface ResolvedTerms {
  fixedFee?: number | null;
  commissionRate?: number | null;
  deliverables?: string | null;
  timeline?: string | null;
  paymentTerms?: string | null;
  rewardDescription?: string | null;
  /** When true, a final fee outside the pinned band is accepted (an "approved
   *  structured deviation" in the ticket) instead of rejected. */
  approvedDeviation?: boolean;
}

/** The creator identity the DealHandoff NOT-NULL columns require on approve. */
export interface ResolverCreator {
  name: string;
  email: string;
}

export interface ResolveInput {
  to: ManualReviewOutcome;
  resolvedBy: string;
  reason: string;
  /** Approve only: the final creator-specific terms → DealHandoff. */
  terms?: ResolvedTerms;
  /** Approve only: creator identity for the DealHandoff NOT-NULL fields. */
  creator?: ResolverCreator;
  /** Approve only: campaign name for the DealHandoff (nullable). */
  campaignName?: string | null;
  /** "operator" (human action) or "system" (timeout sweep) — audit provenance. */
  source?: "operator" | "system";
}

/**
 * Thrown when the OCC-CAS lost the race — the case was already resolved (or
 * concurrently resolved) by another actor. The route/sweep catches it and reports
 * the existing outcome; inside the tx it forces a rollback so no orphan
 * DealHandoff is left behind.
 */
export class ManualReviewRaceError extends Error {
  constructor(public readonly instanceId: string) {
    super(`Manual-review case ${instanceId} was already resolved (OCC race)`);
    this.name = "ManualReviewRaceError";
  }
}

/** Thrown when an approve's final fee falls outside the pinned band and no
 *  approvedDeviation was passed. Validated BEFORE the tx opens, so a bad request
 *  never starts a transaction. */
export class BandViolationError extends Error {
  constructor(
    public readonly fixedFee: number,
    public readonly floorCents: number | null,
    public readonly ceilingCents: number | null,
  ) {
    super(
      `Final fee $${fixedFee} is outside the pinned band ` +
        `[${floorCents === null ? "—" : floorCents / 100}, ${ceilingCents === null ? "—" : ceilingCents / 100}]`,
    );
    this.name = "BandViolationError";
  }
}

/** Load the pinned negotiation-policy snapshot (READ-ONLY — never written, so the
 *  snapshot stays immutable during MR). Null when the instance has none pinned. */
export async function findNegotiationPolicySnapshotById(
  id: string,
  client: Db | DbTx = db,
): Promise<NegotiationPolicySnapshot | null> {
  const rows = await client
    .select()
    .from(negotiationPolicySnapshots)
    .where(eq(negotiationPolicySnapshots.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Validate a final approved fee against the pinned band. Throws BandViolationError
 * when the fee is outside [floor, ceiling] (either bound in cents; null = open on
 * that side) unless terms.approvedDeviation is set. No band pinned / no fee → no-op.
 * Pure given the snapshot, so the route validates before opening any transaction.
 */
export function assertFeeWithinBand(
  terms: ResolvedTerms | undefined,
  snapshot: NegotiationPolicySnapshot | null,
): void {
  const fee = terms?.fixedFee;
  if (fee === undefined || fee === null || !Number.isFinite(fee)) return;
  if (terms?.approvedDeviation) return;
  if (!snapshot) return;
  const feeCents = Math.round(fee * 100);
  const { floorCents, ceilingCents } = snapshot;
  const belowFloor = floorCents !== null && feeCents < floorCents;
  const aboveCeiling = ceilingCents !== null && feeCents > ceilingCents;
  if (belowFloor || aboveCeiling) {
    throw new BandViolationError(fee, floorCents, ceilingCents);
  }
}

/**
 * The ONE atomic resolution write. Transitions MANUAL_REVIEW → `to`, optionally
 * inserts the DealHandoff (approve), and appends MANUAL_REVIEW_RESOLVED +
 * STATE_TRANSITION — all in one transaction.
 *
 * Returns the resolved instance. Throws ManualReviewRaceError if the OCC-CAS lost
 * (case already left MANUAL_REVIEW) so the tx rolls back.
 *
 * NOTE: band validation is the caller's job (call assertFeeWithinBand first) — it
 * needs the snapshot loaded and must run before the tx opens.
 */
export async function resolveManualReviewCase(
  instanceId: string,
  input: ResolveInput,
  client: Db = db,
): Promise<ExecutionInstance> {
  assertTransition("MANUAL_REVIEW", input.to);
  const now = new Date();
  const source = input.source ?? "operator";

  return client.transaction(async (tx) => {
    if (input.to === "NEEDS_DEAL_FINALIZATION" && !input.creator) {
      throw new Error("approve requires creator identity for the DealHandoff");
    }

    // OCC-CAS FIRST — only advances a row STILL in MANUAL_REVIEW. A lost race
    // throws here, rolling the whole tx back BEFORE any DealHandoff write, so a
    // concurrent/retried approve leaves no orphan handoff. (Insert-first would trip
    // the DealHandoff unique constraint on a retry, which aborts the Postgres tx and
    // makes the idempotent catch's fallback SELECT unrunnable — so order matters.)
    // All four targets are terminal, so completedAt is stamped and dueAt cleared.
    const updated = await updateInstanceStateConditional(
      instanceId,
      "MANUAL_REVIEW",
      { currentState: input.to as InstanceState, dueAt: null, completedAt: now },
      tx,
    );
    if (!updated) throw new ManualReviewRaceError(instanceId);

    // Approve → write the final creator-specific terms to DealHandoff (still inside
    // the tx, only on the winning path). The case just left MANUAL_REVIEW, so this
    // is the first and only handoff insert; a retry never reaches here.
    if (input.to === "NEEDS_DEAL_FINALIZATION") {
      await createDealHandoffOnce(
        {
          instanceId,
          creatorName: input.creator!.name,
          creatorEmail: input.creator!.email,
          campaignName: input.campaignName ?? null,
          fixedFee: input.terms?.fixedFee ?? null,
          commissionRate: input.terms?.commissionRate ?? null,
          deliverables: input.terms?.deliverables ?? null,
          timeline: input.terms?.timeline ?? null,
          paymentTerms: input.terms?.paymentTerms ?? null,
          rewardDescription: input.terms?.rewardDescription ?? null,
          acceptedAt: now,
          status: "AWAITING_FINALIZATION",
        },
        tx,
      );
    }

    await appendEvent(
      {
        instanceId,
        type: "MANUAL_REVIEW_RESOLVED",
        payload: {
          outcome: input.to,
          resolvedBy: input.resolvedBy,
          reason: input.reason,
          source,
          ...(input.terms ? { terms: input.terms as Record<string, unknown> } : {}),
        } as InputJsonValue,
        occurredAt: now,
      },
      tx,
    );
    await appendEvent(
      {
        instanceId,
        type: "STATE_TRANSITION",
        payload: { from: "MANUAL_REVIEW", to: input.to, source },
        occurredAt: now,
      },
      tx,
    );
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Read helpers — case metadata + sweep queries
// ---------------------------------------------------------------------------

export interface ManualReviewCaseMeta {
  /** The case deadline (instance.dueAt); null when the timeout feature is off. */
  deadline: Date | null;
  /** Count of brand nudges sent — MANUAL_REVIEW_NUDGED events ONLY (never
   *  BRAND_NOTIFIED, which the original escalation notice also emits). */
  nudgeCount: number;
}

/** Case metadata for the queue list/detail. `events` is the instance's log
 *  (caller already loads it for deriveEscalation); deadline comes from the
 *  instance row. Pure counting, so no extra query. */
export function getManualReviewCaseMeta(
  instance: Pick<ExecutionInstance, "dueAt">,
  events: Event[],
): ManualReviewCaseMeta {
  const nudgeCount = events.filter((e) => e.type === "MANUAL_REVIEW_NUDGED").length;
  return { deadline: instance.dueAt ?? null, nudgeCount };
}

/** Cases whose deadline has passed — the timeout sweep expires these. Index-backed
 *  by (currentState, dueAt). */
export async function listExpiredManualReviewCases(
  args: { now: Date; limit?: number },
  client: Db | DbTx = db,
): Promise<ExecutionInstance[]> {
  return client
    .select()
    .from(executionInstances)
    .where(
      and(
        eq(executionInstances.currentState, "MANUAL_REVIEW"),
        isNotNull(executionInstances.dueAt),
        lte(executionInstances.dueAt, args.now),
      ),
    )
    .orderBy(asc(executionInstances.dueAt))
    .limit(args.limit ?? 200);
}

/** MANUAL_REVIEW cases with a deadline still in the FUTURE — nudge candidates. The
 *  sweep decides per-row (via nudgeDueAt + nudgeCount) whether one is actually due. */
export async function listManualReviewCasesForNudge(
  args: { now: Date; limit?: number },
  client: Db | DbTx = db,
): Promise<ExecutionInstance[]> {
  const rows = await client
    .select()
    .from(executionInstances)
    .where(
      and(
        eq(executionInstances.currentState, "MANUAL_REVIEW"),
        isNotNull(executionInstances.dueAt),
      ),
    )
    .orderBy(asc(executionInstances.dueAt))
    .limit(args.limit ?? 200);
  // Future-deadline only: an expired case is the timeout sweep's job, not a nudge.
  return rows.filter((r) => r.dueAt !== null && r.dueAt.getTime() > args.now.getTime());
}

/** Count MANUAL_REVIEW_NUDGED events for one instance — the sweep reads this to
 *  decide which nudge offset is next. */
export async function countNudges(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<number> {
  const rows = await client
    .select({ id: eventsTable.id })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.instanceId, instanceId),
        eq(eventsTable.type, "MANUAL_REVIEW_NUDGED"),
      ),
    );
  return rows.length;
}
