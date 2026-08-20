import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  finalAgreements,
  type ApprovedDeviation,
  type FinalAgreement,
  type FinalAgreementInsert,
} from "./schema.js";
import type { Deliverable } from "../domain/deliverables.js";
import { validateDeliverables } from "../domain/deliverablesValidator.js";

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
 *
 * Review fix (PR #48): runtime.ts calls this WITH the accept turn's own OCC
 * transaction (`tx`), not the bare `db` singleton dealHandoffs.ts's identical-
 * looking catch-and-select pattern relies on. Postgres aborts an ENTIRE
 * transaction after any statement inside it fails — a caught unique-violation
 * on the INSERT still poisons `tx`, so the "catch, then SELECT on the same
 * client" fallback would itself throw `current transaction is aborted`
 * instead of returning the existing row, defeating the whole point of this
 * function when called inside a transaction. `onConflictDoNothing` avoids the
 * error path entirely — no failed statement, so `tx` stays usable — and a
 * conflict is then just an empty `returning()`, resolved by a plain SELECT.
 */
export async function recordFinalAgreementOnce(
  data: FinalAgreementInsert,
  client: Db | DbTx = db,
): Promise<FinalAgreement> {
  const rows = await client
    .insert(finalAgreements)
    .values(data)
    .onConflictDoNothing({ target: finalAgreements.instanceId })
    .returning();
  if (rows[0]) return rows[0];
  const existing = await findFinalAgreementByInstance(data.instanceId, client);
  if (existing) return existing;
  // Unreachable in practice: onConflictDoNothing() only returns zero rows
  // when a row with this instanceId already exists, and the SELECT above
  // reads with the SAME client — READ COMMITTED sees the row that caused the
  // conflict. A defensive throw beats silently returning `undefined` as if it
  // were a FinalAgreement.
  throw new Error(`recordFinalAgreementOnce: conflict on instance ${data.instanceId} but no row found`);
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

// Review fix (PR #48): CampaignDetails' single "commissionAmount" UI control
// (S7.A1) stores ONE number whose UNIT is decided by the companion
// `commissionMode` field — a percentage when "percent", a flat DOLLAR amount
// when "flat" (see web's PricingGrid/commissionAmount control comment). The
// old code always wrote that number into finalCommissionRate regardless of
// mode, leaving finalCommissionAmountCents permanently null for every flat
// deal even though the schema has a dedicated column for it. Route by mode
// instead, converting the flat dollar figure to cents (matches finalFeeCents'
// own dollars->cents convention).
function splitCommissionValue(
  mode: FinalAgreementInsert["finalCommissionMode"],
  raw: unknown,
): Pick<FinalAgreementInsert, "finalCommissionRate" | "finalCommissionAmountCents"> {
  const value = numberOrNull(raw);
  if (value === null) return { finalCommissionRate: null, finalCommissionAmountCents: null };
  if (mode === "FLAT") {
    return { finalCommissionRate: null, finalCommissionAmountCents: Math.round(value * 100) };
  }
  // PERCENT (the default when commissionMode is unset/unrecognized — matches
  // the pre-existing behavior for every campaign that predates S7.A1).
  return { finalCommissionRate: value, finalCommissionAmountCents: null };
}

// Review fix (PR #48): finalFulfillmentTerms was always null even though
// CampaignDetails already stores exactly the fields a creator needs to
// actually receive a gift — giftDeliveryMethod ("promo_code" |
// "manual_contact"), the promo code itself, the manual-contact email, and
// whether shipping info is required. finalFulfillmentTerms is a single text
// column (no structured fulfillment table exists), so this folds those into
// one human-readable line rather than dropping them.
function buildFulfillmentTerms(d: Record<string, unknown> | undefined): string | null {
  if (!d) return null;
  const parts: string[] = [];
  const method = d["giftDeliveryMethod"];
  if (method === "promo_code") {
    const code = stringOrNull(d["promoCode"]);
    parts.push(code ? `Promo code: ${code}` : "Delivered via promo code");
  } else if (method === "manual_contact") {
    const email = stringOrNull(d["giftContactEmail"]);
    parts.push(email ? `Manual fulfillment — contact ${email}` : "Delivered via manual contact");
  }
  if (d["requiresShippingInfo"] === true) {
    parts.push("Shipping information required");
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Pure assembly — no DB, no snapshot loading. Every input is already
 *  resolved by the caller (negotiation.ts has all of it in scope at the
 *  accept turn with zero extra work). */
export function buildFinalAgreementInput(input: BuildFinalAgreementInput): FinalAgreementInsert {
  const { effectiveConfig: cfg, detailsSnapshot: d } = input;
  const commissionMode = parseCommissionMode(d?.["commissionMode"]);
  return {
    instanceId: input.instanceId,
    campaignTermsSnapshotId: input.campaignTermsSnapshotId,
    negotiationPolicySnapshotId: input.negotiationPolicySnapshotId,
    finalFeeCents: input.agreedFeeCents ?? null,
    finalCommissionMode: commissionMode,
    ...splitCommissionValue(commissionMode, cfg["commissionRate"]),
    finalCommissionDurationDays: numberOrNull(d?.["commissionDurationDays"]),
    finalCommissionConditions: stringOrNull(d?.["commissionConditions"]),
    finalGiftProductDescription: stringOrNull(cfg["rewardDescription"]),
    finalGiftDisposition: parseGiftDisposition(d?.["giftDisposition"]),
    finalFulfillmentTerms: buildFulfillmentTerms(d),
    finalDeliverables: input.finalDeliverables,
    finalTimeline: stringOrNull(cfg["timeline"]),
    finalPostingDate: null, // no current source column — PLU-169 decision #3
    finalUsageRights: stringOrNull(cfg["usageRights"]),
    finalExclusivity: stringOrNull(cfg["exclusivity"]),
    finalAttributionWindow: stringOrNull(cfg["attributionWindow"]),
    finalPaymentTerms: stringOrNull(cfg["paymentTerms"]),
    // S5.6 "require" | "skip" — anything else (unset/legacy) defaults to false.
    finalScriptSubmissionRequired: d?.["scriptSubmission"] === "require",
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

export type ResolveFinalDeliverablesResult =
  | { ok: true; deliverables: Deliverable[] }
  | { ok: false; error: string };

/**
 * Resolve this instance's final deliverables from the pinned snapshot's
 * `deliverableQuantities`.
 *
 * Review fix (PR #48): the old version re-validated with its OWN loose shape
 * check (platform/format are strings, quantity is a number) and silently
 * FILTERED OUT anything that failed it — so an invalid platform/format
 * combination (e.g. tiktok + reel, not in PLATFORM_FORMAT_MATRIX) would
 * SURVIVE into FinalAgreement, and any genuinely malformed item would just
 * vanish from the final package with no record it was ever dropped. Now runs
 * the complete array through the SAME shared `deliverablesSchema` the intake
 * route already enforces (deliverablesValidator.ts — built for exactly this
 * second call site, per its own doc comment) and fails the WHOLE resolution
 * rather than silently keeping only the valid subset — a half-silently-
 * dropped deliverables package is worse than an explicit escalation. The
 * caller (negotiation.ts's accept case) routes a failure to MANUAL_REVIEW
 * before any accept email is drafted or sent.
 *
 * A missing/empty baseline still resolves to `{ ok: true, deliverables: [] }`
 * — a legacy campaign with no structured deliverables recorded yet is a
 * normal, valid state (the free-text `deliverables` notes field still
 * carries whatever scope was agreed, per PLU-169 decision #9); that is NOT
 * the same failure mode as "an array that contains a bad item."
 */
export function resolveFinalDeliverables(args: {
  baseline: unknown; // termsSnapshot.detailsSnapshot["deliverableQuantities"]
}): ResolveFinalDeliverablesResult {
  if (!Array.isArray(args.baseline) || args.baseline.length === 0) {
    return { ok: true, deliverables: [] };
  }
  const normalized = args.baseline.map(normalizeLegacyId);
  const result = validateDeliverables(normalized);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, deliverables: result.deliverables };
}

// PLU-169 (1f) — Greptile review (PR #46) fix: a launched CampaignTermsSnapshot
// is IMMUTABLE (written once by launchCampaign(), never updated after — see
// its own doc comment in schema.ts), so the one-time id backfill script
// (decision #4), which only writes to the MUTABLE CampaignDetails row, can
// never reach an already-launched campaign's frozen snapshot. Mint a fresh id
// here, BEFORE validateDeliverables runs (deliverablesSchema requires
// `id: string().min(1)`, and a launched snapshot predating the backfill would
// otherwise fail validation forever on every one of its items). This id is
// NOT written back to the immutable snapshot and is only guaranteed stable
// for the lifetime of this one FinalAgreement row — acceptable for Phase 1,
// since nothing references a deliverable id yet (negotiation-delta support,
// decision #5, is a separate future ticket that will need its own answer for
// referencing an id inside an immutable snapshot before it can rely on
// reproducibility here). Non-object items pass through untouched so the
// shared validator — not this function — produces the real error for them.
function normalizeLegacyId(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  const r = v as Record<string, unknown>;
  if (typeof r["id"] === "string" && r["id"].length > 0) return r;
  return { ...r, id: createId() };
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
