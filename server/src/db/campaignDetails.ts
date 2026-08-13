import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  campaignDetails,
  campaigns,
  type CampaignDetails,
  type CampaignDetailsInsert,
  type CompensationStructure,
} from "./schema.js";

// ---------------------------------------------------------------------------
// CampaignDetails access module (PLU-139)
// ---------------------------------------------------------------------------
// The structured PUBLIC creator-facing terms for a campaign. Mirrors the
// conversationObligations.ts shape: every read/write is `client: Db | DbTx = db`
// injectable, and upsert is insert-or-touch on the unique campaignId with an
// isUniqueViolation fallback for the concurrent-double-insert race.
//
// This module ALSO owns the two pieces the sibling detail modules reuse:
//   - assertCampaignIsDraft — the shared lifecycle guard (single impl, exported).
//   - clearStaleCompFields  — the pure "structure change clears hidden fields" rule.

/**
 * Thrown when a material edit is attempted on a non-DRAFT campaign. Typed so the
 * route can map it to 409 without string-matching. `status` carries the current
 * campaign status for the error body.
 */
export class CampaignNotDraftError extends Error {
  readonly campaignId: string;
  readonly status: string;
  constructor(campaignId: string, status: string) {
    super(`Campaign ${campaignId} is ${status}, not DRAFT — material edits are locked`);
    this.name = "CampaignNotDraftError";
    this.campaignId = campaignId;
    this.status = status;
  }
}

/**
 * The shared lifecycle guard — the single source of truth reused by all three
 * detail modules (do NOT triplicate it). Throws CampaignNotDraftError unless the
 * campaign is DRAFT. Also throws if the campaign does not exist (a missing parent
 * can never be "editable"). Runs inside the caller's transaction when given one.
 */
export async function assertCampaignIsDraft(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<void> {
  const rows = await client
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new CampaignNotDraftError(campaignId, "MISSING");
  if (row.status !== "DRAFT") throw new CampaignNotDraftError(campaignId, row.status);
}

/**
 * The compensation-structure fields each structure DOES NOT use. When the
 * structure changes, columns for the axes it no longer has are nulled in the same
 * write so a hidden stale value can never leak (the "conditional fields exclude
 * stale hidden values" AC, enforced at the source-of-truth layer).
 *
 *   PAID      — has a fee; NO commission.
 *   GIFTING   — gift-only; NO fee, NO commission, NO price strategy.
 *   AFFILIATE — commission; NO fee, NO price strategy.
 *   HYBRID    — fee AND commission (clears nothing).
 *
 * Fee-linked fields: priceStrategy, proposedFeeCents, feeCurrency.
 * Commission-linked: commissionRate/Mode/DurationKind/DurationValue,
 *                    attributionWindowDays.
 */
const FEE_FIELDS = [
  "priceStrategy",
  "proposedFeeCents",
  "feeCurrency",
] as const satisfies readonly (keyof CampaignDetailsInsert)[];

const COMMISSION_FIELDS = [
  "commissionRate",
  "commissionMode",
  "commissionDurationKind",
  "commissionDurationValue",
  "attributionWindowDays",
] as const satisfies readonly (keyof CampaignDetailsInsert)[];

function structureClears(
  structure: CompensationStructure,
): readonly (keyof CampaignDetailsInsert)[] {
  switch (structure) {
    case "PAID":
      return COMMISSION_FIELDS;
    case "AFFILIATE":
      return FEE_FIELDS;
    case "GIFTING":
      return [...FEE_FIELDS, ...COMMISSION_FIELDS];
    case "HYBRID":
      return [];
  }
}

/**
 * Pure: given the NEW structure and a patch, return the patch with the fields
 * that structure cannot use forced to null. Callers merge this before writing, so
 * switching PAID→AFFILIATE (etc.) never keeps a stale fee/commission value. A
 * patch that omits `compensationStructure` (a non-structure edit) is returned
 * unchanged. Explicitly null-sets rather than deletes so the columns are WRITTEN
 * null in the update (an omitted key would leave the old value on an upsert).
 */
export function clearStaleCompFields(
  structure: CompensationStructure | undefined | null,
  patch: Partial<CampaignDetailsInsert>,
): Partial<CampaignDetailsInsert> {
  if (!structure) return patch;
  const cleared: Partial<CampaignDetailsInsert> = { ...patch };
  for (const field of structureClears(structure)) {
    (cleared as Record<string, unknown>)[field] = null;
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCampaignDetails(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignDetails | null> {
  const rows = await client
    .select()
    .from(campaignDetails)
    .where(eq(campaignDetails.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Upsert (insert-or-update on the unique campaignId)
// ---------------------------------------------------------------------------

/**
 * Insert the details row for a campaign, or patch the existing one. When the
 * patch carries a `compensationStructure`, stale fee/commission fields for that
 * structure are nulled in the same write (clearStaleCompFields). The initial
 * insert requires `compensationStructure` (the one non-null column); a patch of
 * an existing row may omit it.
 *
 * Concurrent-double-insert safe: the unique campaignId is the backstop — a racing
 * insert hits the constraint, we catch isUniqueViolation and fall through to the
 * update path.
 */
export async function upsertCampaignDetails(
  campaignId: string,
  patch: Partial<CampaignDetailsInsert>,
  client: Db | DbTx = db,
): Promise<CampaignDetails> {
  const existing = await getCampaignDetails(campaignId, client);
  const structure = patch.compensationStructure ?? existing?.compensationStructure;
  const effective = clearStaleCompFields(patch.compensationStructure, patch);

  if (existing) {
    const rows = await client
      .update(campaignDetails)
      .set({ ...effective, updatedAt: new Date() })
      .where(eq(campaignDetails.campaignId, campaignId))
      .returning();
    return rows[0] ?? existing;
  }

  if (!structure) {
    throw new Error(
      "upsertCampaignDetails: compensationStructure is required to create a details row",
    );
  }

  try {
    const rows = await client
      .insert(campaignDetails)
      .values({ ...effective, campaignId, compensationStructure: structure })
      .returning();
    return rows[0]!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent writer created it first — apply our patch to the winner's row.
    const rows = await client
      .update(campaignDetails)
      .set({ ...effective, updatedAt: new Date() })
      .where(eq(campaignDetails.campaignId, campaignId))
      .returning();
    if (rows[0]) return rows[0];
    const raced = await getCampaignDetails(campaignId, client);
    if (raced) return raced;
    throw err;
  }
}
