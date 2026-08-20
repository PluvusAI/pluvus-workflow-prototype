import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  finalAgreements,
  type ApprovedDeviation,
  type FinalAgreement,
  type FinalAgreementInsert,
} from "./schema.js";
import type { Deliverable } from "../domain/deliverables.js";

// ---------------------------------------------------------------------------
// FinalAgreement — the ONE canonical accepted-terms record (PLU-169, 1f).
// ---------------------------------------------------------------------------
// One row per ExecutionInstance, enforced by a UNIQUE instanceId — the exact
// idempotency story createDealHandoffOnce (dealHandoffs.ts) already proved
// out: the accept turn runs inside a BullMQ job that may be retried, so
// recordFinalAgreementOnce swallows the unique violation and returns the row
// that already exists. Written for EVERY accepted journey regardless of
// postAcceptanceMode — unlike DealHandoff, this is not an operator-handoff-
// specific display snapshot.

/**
 * Insert the final-agreement snapshot, or return the existing row if one is
 * already there. Never throws on a duplicate — a retried accept turn is a
 * no-op write here (the runtime's own OCC guard is what actually prevents a
 * double state transition; this only prevents a double INSERT).
 */
export async function recordFinalAgreementOnce(
  data: FinalAgreementInsert,
  client: Db | DbTx = db,
): Promise<FinalAgreement> {
  try {
    const rows = await client.insert(finalAgreements).values(data).returning();
    return rows[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findFinalAgreementByInstance(data.instanceId, client);
      if (existing) return existing;
    }
    throw err;
  }
}

export async function findFinalAgreementByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<FinalAgreement | null> {
  const rows = await client
    .select()
    .from(finalAgreements)
    .where(eq(finalAgreements.instanceId, instanceId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The BUILDER — pure, no I/O, testable without a DB.
// ---------------------------------------------------------------------------

export interface BuildFinalAgreementInput {
  instanceId: string;
  campaignTermsSnapshotId: string | null;
  negotiationPolicySnapshotId: string | null;
  effectiveConfig: Record<string, unknown>; // from resolveEffectiveNegotiationConfig
  detailsSnapshot: Record<string, unknown> | undefined; // termsSnapshot.detailsSnapshot, for commissionMode/gift fields effectiveConfig doesn't carry
  // The campaign's structured deliverables, ALREADY resolved to this
  // instance's final state — see resolveFinalDeliverables. Phase 1 (this
  // ticket) is always a pass-through of the pinned snapshot's
  // deliverableQuantities; negotiation-delta resolution is a separate future
  // ticket (PLU-169 decision #5).
  finalDeliverables: Deliverable[];
  agreedFeeCents: number | undefined; // derived from proposedRate at the accept turn
  acceptanceSource: FinalAgreementInsert["acceptanceSource"];
  sourceMessageId: string | undefined;
  acceptedAt: Date;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseCommissionMode(v: unknown): FinalAgreementInsert["finalCommissionMode"] {
  return v === "percent" ? "PERCENT" : v === "flat" ? "FLAT" : null;
}

const GIFT_DISPOSITIONS = new Set(["KEEP", "LOAN", "RETURN"]);
function parseGiftDisposition(v: unknown): FinalAgreementInsert["finalGiftDisposition"] {
  return typeof v === "string" && GIFT_DISPOSITIONS.has(v)
    ? (v as "KEEP" | "LOAN" | "RETURN")
    : null;
}

/** Pure assembly — no DB, no snapshot loading. Every input is already
 *  resolved by the caller (negotiation.ts has all of it in scope at the
 *  accept turn with zero extra work). */
export function buildFinalAgreementInput(input: BuildFinalAgreementInput): FinalAgreementInsert {
  const { effectiveConfig: cfg, detailsSnapshot: d } = input;
  return {
    instanceId: input.instanceId,
    campaignTermsSnapshotId: input.campaignTermsSnapshotId,
    negotiationPolicySnapshotId: input.negotiationPolicySnapshotId,
    finalFeeCents: input.agreedFeeCents ?? null,
    finalCommissionMode: parseCommissionMode(d?.["commissionMode"]),
    finalCommissionRate: numberOrNull(cfg["commissionRate"]),
    finalCommissionAmountCents: null, // FLAT mode amount — future, no current source populates this
    finalCommissionDurationDays: numberOrNull(d?.["commissionDurationDays"]),
    finalCommissionConditions: stringOrNull(d?.["commissionConditions"]),
    finalGiftProductDescription: stringOrNull(cfg["rewardDescription"]),
    finalGiftDisposition: parseGiftDisposition(d?.["giftDisposition"]),
    finalFulfillmentTerms: null, // no current source column — PLU-169 decision #3
    finalDeliverables: input.finalDeliverables,
    finalTimeline: stringOrNull(cfg["timeline"]),
    finalPostingDate: null, // no current source column — PLU-169 decision #3
    finalUsageRights: stringOrNull(cfg["usageRights"]),
    finalExclusivity: stringOrNull(cfg["exclusivity"]),
    finalAttributionWindow: stringOrNull(cfg["attributionWindow"]),
    finalPaymentTerms: stringOrNull(cfg["paymentTerms"]),
    finalScriptSubmissionRequired: false, // no current source column — PLU-169 decision #3
    approvedDeviations: null as ApprovedDeviation[] | null,
    acceptanceSource: input.acceptanceSource,
    sourceMessageId: input.sourceMessageId ?? null,
    acceptedAt: input.acceptedAt,
  };
}

// ---------------------------------------------------------------------------
// resolveFinalDeliverables — Phase 1: pure pass-through.
// ---------------------------------------------------------------------------
// PLU-169 decision #5: negotiation-delta application (DeliverableChange /
// applyDeliverableChanges) is a SEPARATE future ticket — deliverables stay
// atomic/non-negotiable in this phase, exactly as they behave today. This
// function exists now so negotiation.ts has a single, stable call site to
// wire; a future ticket extends its BODY (folding accepted deltas from the
// instance's NEGOTIATION_TURN history onto the baseline), never its callers.

/**
 * Resolve this instance's final deliverables from the pinned snapshot's
 * `deliverableQuantities` (already validated at write time — routes/campaigns.ts
 * — so this only re-validates defensively, matching the "validate once, trust
 * everywhere downstream" discipline knowledgePrecedence.ts already argues
 * for). An invalid/missing baseline resolves to an empty array rather than
 * throwing — a legacy campaign with no structured deliverables recorded yet
 * is a normal, valid state (the free-text `deliverables` notes field still
 * carries whatever scope was agreed, per PLU-169 decision #9).
 */
export function resolveFinalDeliverables(args: {
  baseline: unknown; // termsSnapshot.detailsSnapshot["deliverableQuantities"]
}): Deliverable[] {
  if (!Array.isArray(args.baseline)) return [];
  return args.baseline.filter(isPlausibleDeliverableShape).map(normalizeDeliverable);
}

// A defensive, non-throwing shape check — NOT a replacement for
// deliverablesSchema (routes/campaigns.ts already validated this array at
// write time). Checks only the fields that carry the deal's actual content
// (platform/format/quantity); `id` is intentionally NOT required here — see
// normalizeDeliverable below for why.
function isPlausibleDeliverableShape(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["platform"] === "string" &&
    typeof r["format"] === "string" &&
    typeof r["quantity"] === "number"
  );
}

// PLU-169 (1f) — Greptile review (PR #46) fix: a launched CampaignTermsSnapshot
// is IMMUTABLE (written once by launchCampaign(), never updated after — see
// its own doc comment in schema.ts), so the one-time id backfill script
// (decision #4), which only writes to the MUTABLE CampaignDetails row, can
// never reach an already-launched campaign's frozen snapshot. Dropping
// id-less items here (the original approach) would therefore silently lose
// EVERY deliverable on EVERY campaign that launched before this ticket
// shipped. Mint a fresh id at resolve time instead, so the deal's actual
// content (platform/format/quantity/etc.) is always preserved. This id is
// NOT written back to the immutable snapshot and is only guaranteed stable
// for the lifetime of this one FinalAgreement row — acceptable for Phase 1,
// since nothing references a deliverable id yet (negotiation-delta support,
// decision #5, is a separate future ticket that will need its own answer for
// referencing an id inside an immutable snapshot before it can rely on
// reproducibility here).
function normalizeDeliverable(r: Record<string, unknown>): Deliverable {
  const out: Record<string, unknown> = {
    id: typeof r["id"] === "string" && r["id"].length > 0 ? r["id"] : createId(),
    platform: r["platform"],
    format: r["format"],
    quantity: r["quantity"],
  };
  if (r["requirements"] !== undefined) out["requirements"] = r["requirements"];
  if (r["customLabel"] !== undefined) out["customLabel"] = r["customLabel"];
  if (r["notes"] !== undefined) out["notes"] = r["notes"];
  return out as unknown as Deliverable;
}

// ---------------------------------------------------------------------------
// Creator-safe projection.
// ---------------------------------------------------------------------------
// Per FinalAgreement's own doc comment, the table never holds private policy
// — there is no floor/ceiling/strategy column to accidentally expose. Still,
// mirroring this codebase's established defense-in-depth pattern
// (DraftContext structurally lacking a policyAuthority field at all, not
// just omitting it at render time), a narrower TS view type rather than
// trusting every future caller to hand-pick safe fields.

export type CreatorFinalAgreementView = Omit<
  FinalAgreement,
  "id" | "instanceId" | "createdAt" | "updatedAt"
>;

export function toCreatorFinalAgreementView(record: FinalAgreement): CreatorFinalAgreementView {
  const { id: _id, instanceId: _instanceId, createdAt: _createdAt, updatedAt: _updatedAt, ...view } = record;
  return view;
}
