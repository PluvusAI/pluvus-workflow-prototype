// PLU-154 manual-review resolution DB layer. A "case" is the ExecutionInstance
// while parked for a human — no new table: deadline reuses dueAt, audit reuses the
// Event log, approved terms reuse DealHandoff. resolveManualReviewCase is the one
// atomic write for every terminal outcome (approve/reject/opt-out/timeout).

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

/** OCC-CAS lost the race — the case was already resolved. Rolls back the tx (no
 *  orphan DealHandoff); the route/sweep catches it and reports the existing outcome. */
export class ManualReviewRaceError extends Error {
  constructor(public readonly instanceId: string) {
    super(`Manual-review case ${instanceId} was already resolved (OCC race)`);
    this.name = "ManualReviewRaceError";
  }
}

/** Approve fee outside the pinned band with no approvedDeviation. Validated before
 *  the tx opens, so a bad request never starts a transaction. */
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

/** Load the pinned negotiation-policy snapshot by id (read-only → stays immutable). */
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

/** Throw BandViolationError if the approve fee is outside [floorCents, ceilingCents]
 *  (null bound = open) unless approvedDeviation. No band/no fee → no-op. Pure. */
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

/** The one atomic resolution write: MANUAL_REVIEW → `to` + optional DealHandoff +
 *  MANUAL_REVIEW_RESOLVED + STATE_TRANSITION, in one tx. Throws ManualReviewRaceError
 *  if the OCC-CAS lost. Caller runs assertFeeWithinBand first (needs the snapshot). */
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

    // OCC-CAS FIRST, then DealHandoff. A lost race throws before any handoff write
    // (no orphan). Order matters: insert-first would trip the DealHandoff unique
    // constraint on a retry, aborting the PG tx so the idempotent fallback SELECT
    // can't run. Targets are terminal → completedAt stamped, dueAt cleared.
    const updated = await updateInstanceStateConditional(
      instanceId,
      "MANUAL_REVIEW",
      { currentState: input.to as InstanceState, dueAt: null, completedAt: now },
      tx,
    );
    if (!updated) throw new ManualReviewRaceError(instanceId);

    // Approve → final terms to DealHandoff (winning path only; first & only insert).
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
  deadline: Date | null;
  /** Nudges sent — MANUAL_REVIEW_NUDGED only (NOT BRAND_NOTIFIED, which the
   *  original escalation notice also emits, so it would over-count). */
  nudgeCount: number;
}

/** Case meta for the queue row — deadline + nudge count. Pure (no extra query). */
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
