import { eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  campaignDetails,
  campaigns,
  negotiationPolicies,
  type CampaignDetails,
  type CampaignDetailsInsert,
} from "./schema.js";
import {
  validateCampaignDetailsAgainstPolicy,
  needsCampaignDetailsCrossFieldCheck,
  type CampaignDetailsPatchInput,
  type NegotiationPolicyValidationCode,
} from "../domain/negotiationPolicyValidation.js";

/**
 * Thrown when a write is attempted against a draft-only table (CampaignDetails,
 * NegotiationPolicy) on a campaign whose status is ACTIVE. Per the 1a design
 * (Calvin review, 2026-08-08): once launched, these are locked read-only —
 * their values are already frozen into the campaign's snapshot, and a
 * material change means duplicating into a new campaign, never editing this
 * one. Routes should catch this and surface a 409, not a 500.
 */
export class CampaignLockedError extends Error {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} is launched (ACTIVE) — its draft fields are locked`);
    this.name = "CampaignLockedError";
  }
}

// PLU-172 (review fix — "This draft-locked write updates CampaignDetails
// without validating the existing negotiation policy against the
// prospective public terms"): thrown by upsertCampaignDetailsValidated when
// the freshly-locked, freshly-read public terms are inconsistent with the
// stored NegotiationPolicy's limits. Carries the SAME
// NegotiationPolicyValidationCode domain/negotiationPolicyValidation.ts
// produces for the opposite direction (a policy patch undercutting the
// public offer), so routes/campaigns.ts can translate both into the
// identical 400 response shape. A distinct class (not a reused import of
// NegotiationPolicyValidationError from db/negotiationPolicy.ts) because
// that module imports withDraftLock/getCampaignDetails FROM this one —
// importing back would create a circular module dependency.
export class CampaignDetailsValidationError extends Error {
  readonly code: NegotiationPolicyValidationCode;
  constructor(code: NegotiationPolicyValidationCode, message: string) {
    super(message);
    this.name = "CampaignDetailsValidationError";
    this.code = code;
  }
}

// Exported so the sibling draft-only tables (BrandIdentity, CreatorRequirement)
// reuse the ONE guard rather than re-implementing the status check (PLU-139 2a).
//
// MUST run inside a transaction that also performs the section write (see
// withDraftLock): the SELECT ... FOR UPDATE takes the SAME Campaign-row lock
// launchCampaign() takes, so a concurrent launch either (a) holds the lock and
// commits ACTIVE before we read — we then see ACTIVE and throw, or (b) blocks
// behind us until our write commits. Without the lock + shared transaction the
// status read and the write are two statements a launch can interleave between,
// letting a write land on an already-launched campaign.
export async function assertCampaignIsDraft(campaignId: string, tx: Db | DbTx): Promise<void> {
  const [campaign] = await tx
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .for("update")
    .limit(1);
  if (campaign?.status === "ACTIVE") {
    throw new CampaignLockedError(campaignId);
  }
}

/**
 * Run `write` atomically with the draft-status check, holding the Campaign-row
 * lock across both so a concurrent launchCampaign() cannot flip the campaign to
 * ACTIVE between them (see assertCampaignIsDraft). Opens a transaction; nested
 * on an existing tx (drizzle savepoint) so it composes inside a caller's tx.
 * The three draft-only upserts (CampaignDetails, BrandIdentity, CreatorRequirement)
 * all route through this so the lock lives in ONE place.
 */
export async function withDraftLock<T>(
  campaignId: string,
  client: Db | DbTx,
  write: (tx: Db | DbTx) => Promise<T>,
): Promise<T> {
  return client.transaction(async (tx) => {
    await assertCampaignIsDraft(campaignId, tx);
    return write(tx);
  });
}

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

/** Batch lookup for list views — avoids one query per campaign. */
export async function getCampaignDetailsByCampaignIds(
  campaignIds: string[],
  client: Db | DbTx = db,
): Promise<Map<string, CampaignDetails>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await client
    .select()
    .from(campaignDetails)
    .where(inArray(campaignDetails.campaignId, campaignIds));
  return new Map(rows.map((row) => [row.campaignId, row]));
}

/** The actual insert/update — no locking, no validation. Callers (both
 *  exported upsert functions below) already hold the Campaign-row lock via
 *  withDraftLock before calling this. Factored out so the validated and
 *  unvalidated entry points share one write path (same rationale as
 *  db/negotiationPolicy.ts's writeNegotiationPolicy). */
async function writeCampaignDetails(
  campaignId: string,
  data: Omit<Partial<CampaignDetailsInsert>, "id" | "campaignId">,
  tx: Db | DbTx,
): Promise<CampaignDetails> {
  const rows = await tx
    .insert(campaignDetails)
    .values({ campaignId, ...data })
    .onConflictDoUpdate({
      target: campaignDetails.campaignId,
      set: data,
    })
    .returning();
  return rows[0]!;
}

/**
 * Insert-or-update the one CampaignDetails row a campaign owns. Every campaign
 * gets one at creation (see routes/campaigns.ts), so this is normally an
 * update in practice — upsert semantics just make the function safe to call
 * unconditionally rather than requiring every caller to check existence first.
 *
 * Throws CampaignLockedError once the campaign has launched (status ACTIVE) —
 * see that class's doc comment.
 *
 * NOTE: this function does NOT validate the prospective public fee/
 * commission/unit against the stored NegotiationPolicy's private limits —
 * it's the plain, unvalidated upsert used by callers that already know
 * their data is consistent (tests, internal seeding) or intentionally
 * bypass the check. `PATCH /campaigns/:id` (routes/campaigns.ts) uses
 * `upsertCampaignDetailsValidated` below instead.
 */
export async function upsertCampaignDetails(
  campaignId: string,
  data: Omit<Partial<CampaignDetailsInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<CampaignDetails> {
  return withDraftLock(campaignId, client, (tx) => writeCampaignDetails(campaignId, data, tx));
}

/**
 * PLU-172 (review fix — "This draft-locked write updates CampaignDetails
 * without validating the existing negotiation policy against the
 * prospective public terms").
 *
 * A campaign with a 50,000-cent public fee and a matching
 * ALLOW_WITHIN_LIMIT/50,000-cent private ceiling accepted a details PATCH
 * raising the public fee to 60,000 cents — nothing compared the new public
 * fee against the already-stored private limit. Launch then froze the
 * still-50,000-cent private limit into the immutable NegotiationPolicySnapshot
 * alongside a 60,000-cent public fee: an invalid combination that can never
 * be corrected post-launch.
 *
 * Fixed the same way as the symmetric NegotiationPolicy-patch direction
 * (db/negotiationPolicy.ts's upsertNegotiationPolicyValidated): read +
 * validate INSIDE the same withDraftLock transaction that performs the
 * write, so assertCampaignIsDraft's `SELECT ... FOR UPDATE` on the Campaign
 * row serializes this against any concurrent upsertCampaignDetails/
 * upsertNegotiationPolicyValidated call for the same campaignId, and the
 * re-read after acquiring that lock always sees the latest committed state.
 *
 * Reads the NegotiationPolicy row via an inline raw select on the
 * `negotiationPolicies` table (imported from ./schema.js) rather than
 * calling db/negotiationPolicy.ts's getNegotiationPolicy — that module
 * already imports withDraftLock/getCampaignDetails FROM this file, so
 * importing back would create a circular module dependency.
 *
 * Throws CampaignDetailsValidationError (never a "soft" failure) so the
 * route's existing try/catch — which already handles CampaignLockedError
 * from the same call — can translate both failure modes the identical way.
 */
export async function upsertCampaignDetailsValidated(
  campaignId: string,
  data: Omit<Partial<CampaignDetailsInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<CampaignDetails> {
  return withDraftLock(campaignId, client, async (tx) => {
    if (needsCampaignDetailsCrossFieldCheck(data as CampaignDetailsPatchInput)) {
      const [existingDetails, policyRows] = await Promise.all([
        getCampaignDetails(campaignId, tx),
        tx.select().from(negotiationPolicies).where(eq(negotiationPolicies.campaignId, campaignId)).limit(1),
      ]);
      const existingPolicy = policyRows[0] ?? null;
      const validation = validateCampaignDetailsAgainstPolicy(data as CampaignDetailsPatchInput, {
        existingPriceStrategy: existingDetails?.priceStrategy ?? null,
        existingPublicStartingFeeCents: existingDetails?.publicStartingFeeCents ?? null,
        existingCommissionMode: existingDetails?.commissionMode ?? null,
        existingPublicCommissionRate: existingDetails?.publicCommissionRate ?? null,
        policyFeeMode: existingPolicy?.feeMode ?? null,
        policyCeilingCents: existingPolicy?.ceilingCents ?? null,
        policyCommissionNegotiationMode: existingPolicy?.commissionNegotiationMode ?? null,
        policyCommissionCeilingRate: existingPolicy?.commissionCeilingRate ?? null,
        policyCommissionCeilingAmountCents: existingPolicy?.commissionCeilingAmountCents ?? null,
      });
      if (!validation.ok) {
        throw new CampaignDetailsValidationError(validation.code, validation.error);
      }
    }
    return writeCampaignDetails(campaignId, data, tx);
  });
}
