import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { withDraftLock, getCampaignDetails } from "./campaignDetails.js";
import {
  campaignAuditEvents,
  negotiationPolicies,
  type NegotiationPolicy,
  type NegotiationPolicyInsert,
} from "./schema.js";
import {
  validateNegotiationPolicyPatch,
  needsNegotiationPolicyCrossFieldCheck,
  type NegotiationPolicyPatchInput,
  type NegotiationPolicyValidationCode,
} from "../domain/negotiationPolicyValidation.js";

export async function getNegotiationPolicy(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<NegotiationPolicy | null> {
  const rows = await client
    .select()
    .from(negotiationPolicies)
    .where(eq(negotiationPolicies.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

// PLU-172 (review fix — "policy validation is not atomic with its write"):
// thrown by upsertNegotiationPolicyValidated when the freshly-locked,
// freshly-read effective state fails cross-field validation. Carries the
// same stable `code` domain/negotiationPolicyValidation.ts produces, so the
// route can translate it into the identical 400 response shape it already
// returns for a synchronously-caught validation failure.
export class NegotiationPolicyValidationError extends Error {
  readonly code: NegotiationPolicyValidationCode;
  constructor(code: NegotiationPolicyValidationCode, message: string) {
    super(message);
    this.name = "NegotiationPolicyValidationError";
    this.code = code;
  }
}

/** The actual insert/update + audit-event write. No locking of its own —
 *  callers (both exported upsert functions below) already hold the
 *  Campaign-row lock via withDraftLock before calling this. Factored out so
 *  the validated and unvalidated entry points share one write path instead
 *  of the validated one calling the unvalidated one (which would re-lock
 *  via a redundant nested withDraftLock/assertCampaignIsDraft — harmless
 *  under Drizzle's savepoint nesting, but wasteful and confusing). */
async function writeNegotiationPolicy(
  campaignId: string,
  data: Omit<Partial<NegotiationPolicyInsert>, "id" | "campaignId">,
  tx: Db | DbTx,
): Promise<NegotiationPolicy> {
  const changedFields = Object.keys(data).sort();

  // Review fix: `data` can legitimately be empty (a PATCH body with no
  // recognized fields, or an already-normalized no-op). Drizzle's
  // `.onConflictDoUpdate({ set: data })` throws "No values to set" when
  // `data` is empty — a real, previously-untested crash path (any client
  // sending an empty-body PATCH to this route hit a raw 500, not a clean
  // no-op). Route empty data through `onConflictDoNothing` instead, which
  // needs no `set` clause; on a genuine conflict (the common case — a
  // policy row already exists) it returns nothing, so the existing row is
  // re-selected explicitly rather than assumed.
  if (changedFields.length === 0) {
    const inserted = await tx
      .insert(negotiationPolicies)
      .values({ campaignId })
      .onConflictDoNothing({ target: negotiationPolicies.campaignId })
      .returning();
    // Nothing changed — nothing to audit.
    return (
      inserted[0] ??
      (await tx.select().from(negotiationPolicies).where(eq(negotiationPolicies.campaignId, campaignId)))[0]!
    );
  }

  const rows = await tx
    .insert(negotiationPolicies)
    .values({ campaignId, ...data })
    .onConflictDoUpdate({
      target: negotiationPolicies.campaignId,
      set: data,
    })
    .returning();

  // PLU-172 (Calvin review): a private-policy edit is audited under the
  // EXISTING POLICY_CHANGED event type (no new enum value needed) — the
  // payload records WHICH fields changed, NEVER their values. This is a
  // privacy boundary, not an oversight: NegotiationPolicy is the one table
  // a creator-facing surface must never read from, and an audit log is
  // exactly the kind of "ordinary log" the ticket's own privacy
  // requirement calls out (docs/plu-172-...-plan.md §10).
  await tx.insert(campaignAuditEvents).values({
    campaignId,
    eventType: "POLICY_CHANGED",
    payload: { changedFields },
  });

  return rows[0]!;
}

function buildValidationContext(
  details: Awaited<ReturnType<typeof getCampaignDetails>>,
  existingPolicy: NegotiationPolicy | null,
): Parameters<typeof validateNegotiationPolicyPatch>[1] {
  return {
    publicPriceStrategy: details?.priceStrategy ?? null,
    publicStartingFeeCents: details?.publicStartingFeeCents ?? null,
    publicCommissionMode: details?.commissionMode ?? null,
    publicCommissionRate: details?.publicCommissionRate ?? null,
    existingFeeMode: existingPolicy?.feeMode ?? null,
    existingCeilingCents: existingPolicy?.ceilingCents ?? null,
    existingCommissionNegotiationMode: existingPolicy?.commissionNegotiationMode ?? null,
    existingCommissionCeilingRate: existingPolicy?.commissionCeilingRate ?? null,
    existingCommissionCeilingAmountCents: existingPolicy?.commissionCeilingAmountCents ?? null,
    existingCommissionDurationMode: existingPolicy?.commissionDurationMode ?? null,
    existingPostingNegotiationMode: existingPolicy?.postingNegotiationMode ?? null,
    existingGiftSubstitutionMode: existingPolicy?.giftSubstitutionMode ?? null,
    existingGiftCashReplacementMode: existingPolicy?.giftCashReplacementMode ?? null,
    existingDeliverableNegotiationMode: existingPolicy?.deliverableNegotiationMode ?? null,
  };
}

/**
 * Insert-or-update the one NegotiationPolicy row a campaign owns. Unlike
 * CampaignDetails, not every campaign has one yet — until PLU-136's gap fix
 * this had zero callers anywhere (no route ever wrote to it, which meant
 * validateCompensationReadiness's "explicitly marked non-negotiable" branch
 * was permanently unreachable dead code).
 *
 * Throws CampaignLockedError once the campaign has launched (status ACTIVE):
 * an in-flight negotiation must never see its bounds change mid-conversation
 * (Calvin review, 2026-08-08) — the frozen copy lives in
 * NegotiationPolicySnapshot from that point on.
 *
 * NOTE: this function does NOT run domain/negotiationPolicyValidation.ts's
 * cross-field checks — it's the plain, unvalidated upsert used by callers
 * that already know their data is valid (tests, internal seeding) or that
 * intentionally bypass the Page-8 cross-field rules. `PATCH
 * /campaigns/:id/negotiation-policy` (routes/campaigns.ts) uses
 * `upsertNegotiationPolicyValidated` below instead — see that function's
 * doc comment for why the validation can't safely happen outside the write
 * transaction.
 */
export async function upsertNegotiationPolicy(
  campaignId: string,
  data: Omit<Partial<NegotiationPolicyInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<NegotiationPolicy> {
  return withDraftLock(campaignId, client, (tx) => writeNegotiationPolicy(campaignId, data, tx));
}

/**
 * PLU-172 (review fix — "policy validation is not atomic with its write").
 *
 * The route used to read CampaignDetails/NegotiationPolicy, validate the
 * patch against that snapshot, and only THEN call upsertNegotiationPolicy
 * — two separate steps with no lock held across them. Two concurrent
 * PATCHes to the SAME campaign could each validate against a stale view of
 * the OTHER's not-yet-committed change: e.g. campaign has a $1000 public
 * starting fee; request A sends `{ feeMode: "ALLOW_WITHIN_LIMIT" }`
 * (reads ceilingCents as whatever it currently is — say unset — passes),
 * request B concurrently sends `{ ceilingCents: 500 }` (reads feeMode as
 * whatever it currently is — say KEEP_PUBLIC_OFFER, so the "must not be
 * below the public fee" check never even runs — passes). Both commit. The
 * resulting row has feeMode=ALLOW_WITHIN_LIMIT + ceilingCents=500 against a
 * $1000 public fee — an invalid combination neither validation call could
 * see, and one that can be copied into the immutable launch snapshot.
 *
 * Fixed by moving the read + validate INSIDE the same withDraftLock
 * transaction that performs the write. assertCampaignIsDraft's `SELECT ...
 * FOR UPDATE` on the Campaign row already serializes every concurrent
 * upsertNegotiationPolicy/upsertCampaignDetails call for the SAME
 * campaignId (they block on that row lock) — so re-reading
 * NegotiationPolicy/CampaignDetails with the SAME transaction client AFTER
 * acquiring that lock is guaranteed to see the latest COMMITTED state of
 * any previously-serialized concurrent write, which is exactly the state
 * that will actually be true once THIS write commits. Whichever of two
 * concurrent requests loses the lock race simply re-validates against what
 * the winner just committed, so an invalid combination can never persist
 * regardless of interleaving.
 *
 * Throws NegotiationPolicyValidationError (never returns a "soft" failure)
 * so the route's existing try/catch — which already handles
 * CampaignLockedError from the SAME call — can translate both failure
 * modes the identical way.
 */
export async function upsertNegotiationPolicyValidated(
  campaignId: string,
  data: Omit<Partial<NegotiationPolicyInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<NegotiationPolicy> {
  return withDraftLock(campaignId, client, async (tx) => {
    if (needsNegotiationPolicyCrossFieldCheck(data as NegotiationPolicyPatchInput)) {
      const [details, existingPolicy] = await Promise.all([
        getCampaignDetails(campaignId, tx),
        getNegotiationPolicy(campaignId, tx),
      ]);
      const validation = validateNegotiationPolicyPatch(
        data as NegotiationPolicyPatchInput,
        buildValidationContext(details, existingPolicy),
      );
      if (!validation.ok) {
        throw new NegotiationPolicyValidationError(validation.code, validation.error);
      }
    }
    return writeNegotiationPolicy(campaignId, data, tx);
  });
}
