// PLU-139 §1/§1a/§5: the renderer's input contract. Everything here is
// sourced from already-frozen data (CampaignTermsSnapshot) plus one
// deliberately-live read (BrandIdentity, §5) — never from mutable
// CampaignDetails, NegotiationPolicy, or WorkflowVersion.nodeGraph. A
// launched campaign is already known-valid by the time it reaches this file,
// so buildCampaignBriefInput() projects, it does not validate.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import { CampaignSnapshotMissingError, resolveCampaignLaunchContext } from "./campaigns.js";
import { getCampaignTermsSnapshotById } from "./campaignSnapshots.js";
import {
  brandIdentities,
  campaignAuditEvents,
  campaignBriefs,
  campaigns,
  creatorRequirements,
  type CampaignBrief,
  type CampaignDetails,
  type CampaignType,
  type GiftDisposition,
  type JsonValue,
  type PriceStrategy,
} from "./schema.js";

// Bumped whenever renderCampaignBriefHtml()'s output shape changes in a way
// worth distinguishing on an already-rendered CampaignBrief row. Owned here
// (the input-contract module) rather than in templates/campaignBrief/, so
// buildCampaignBriefInput() can stamp it without that module importing this
// one back — templates/campaignBrief/ imports CampaignBriefInput FROM this
// file, never the reverse.
export const CAMPAIGN_BRIEF_TEMPLATE_VERSION = "v1";

// The exact CampaignTermsSnapshot.detailsSnapshot shape — a JSON copy of
// every CampaignDetails column except the ones launchCampaign() strips
// before writing it (id/campaignId/confirmedFromExtractionId/confirmedAt/
// createdAt/updatedAt; see db/campaigns.ts's launchCampaign()). Declared
// here as a real type (rather than the `Record<string, unknown>` cast used
// by test files) since this module is the first real production consumer.
export type CampaignDetailsSnapshot = Omit<
  CampaignDetails,
  "id" | "campaignId" | "confirmedFromExtractionId" | "confirmedAt" | "createdAt" | "updatedAt"
>;

export interface BrandIdentityProjection {
  logoRef: string | null;
  primaryColor: string;
  secondaryColor: string;
  typography: string;
  // True when no BrandIdentity row exists, or every presentational field on
  // it is null — the neutral Pluvus default was used, not the brand's own.
  isDefault: boolean;
}

// §1's "compensation projection" — the ticket's single "compensation,
// commission, reward, and payment terms" bucket, shaped per campaignType so
// the template layer (§2) never re-derives "does this campaign have a fee."
// productOrOffer is deliberately NOT duplicated in here — it's already a
// top-level CampaignBriefInput field (§4's own "Product or offer" section);
// the template pulls it from there for the GIFT_ONLY case, where the
// product IS the compensation.
export type CompensationProjection =
  | { kind: "GIFT_ONLY"; giftDisposition: GiftDisposition | null }
  | {
      kind: "AFFILIATE";
      commissionRate: number | null;
      commissionDurationDays: number | null;
      commissionConditions: string | null;
      includesGifting: boolean;
      giftDisposition: GiftDisposition | null;
    }
  | {
      kind: "PAID";
      priceStrategy: PriceStrategy | null;
      startingFeeCents: number | null;
      includesGifting: boolean;
      giftDisposition: GiftDisposition | null;
    }
  | {
      kind: "HYBRID";
      priceStrategy: PriceStrategy | null;
      startingFeeCents: number | null;
      commissionRate: number | null;
      commissionDurationDays: number | null;
      commissionConditions: string | null;
      includesGifting: boolean;
      giftDisposition: GiftDisposition | null;
    };

// §1's CreatorRequirement stub: present only when approvedForBrief is true
// (default false on every row today — nothing sets it yet). The fields
// themselves are carried verbatim, unchanged from CreatorRequirement.
export interface CreatorRequirementsProjection {
  platforms: JsonValue | null;
  niches: JsonValue | null;
  geography: JsonValue | null;
  languages: JsonValue | null;
  minFollowers: number | null;
  audienceNotes: string | null;
  contentStyle: string | null;
  brandSafety: string | null;
}

export interface CampaignBriefInput {
  campaignId: string;
  campaignTermsSnapshotId: string;
  campaignName: string;
  brand: string;
  brandIdentity: BrandIdentityProjection;
  objective: string | null;
  productOrOffer: string | null;
  keyMessages: string | null;
  deliverables: string | null;
  timeline: string | null;
  compensation: CompensationProjection;
  publicPaymentTerms: string | null;
  attributionWindow: string | null;
  contentRequirements: string | null;
  usageRights: string | null;
  exclusivity: string | null;
  prohibitedClaims: string | null;
  creatorRequirements: CreatorRequirementsProjection | null;
  templateVersion: string;
}

function projectCompensation(details: CampaignDetailsSnapshot): CompensationProjection {
  const campaignType: CampaignType = details.campaignType;
  switch (campaignType) {
    case "GIFT_ONLY":
      return { kind: "GIFT_ONLY", giftDisposition: details.giftDisposition };
    case "AFFILIATE":
      return {
        kind: "AFFILIATE",
        commissionRate: details.publicCommissionRate,
        commissionDurationDays: details.commissionDurationDays,
        commissionConditions: details.commissionConditions,
        includesGifting: details.includesGifting,
        giftDisposition: details.giftDisposition,
      };
    case "PAID":
      return {
        kind: "PAID",
        priceStrategy: details.priceStrategy,
        startingFeeCents: details.publicStartingFeeCents,
        includesGifting: details.includesGifting,
        giftDisposition: details.giftDisposition,
      };
    case "HYBRID":
      return {
        kind: "HYBRID",
        priceStrategy: details.priceStrategy,
        startingFeeCents: details.publicStartingFeeCents,
        commissionRate: details.publicCommissionRate,
        commissionDurationDays: details.commissionDurationDays,
        commissionConditions: details.commissionConditions,
        includesGifting: details.includesGifting,
        giftDisposition: details.giftDisposition,
      };
  }
}

/**
 * §8/§9 (PLU-141): "missing material snapshot data fails explicitly and
 * identifies the missing category" — the public-field half of
 * `validateCompensationReadiness()` (db/campaigns.ts), re-scoped to what the
 * RENDERER specifically needs. Deliberately narrower than that function:
 * this file never reads NegotiationPolicy (excluded by construction, §1), so
 * it cannot and does not re-check negotiation-authority fields
 * (floorCents/commissionFloorRate/etc.) — those are launchCampaign()'s job,
 * not the brief's. This checks only "is there enough PUBLIC data, per
 * campaignType, to render a real compensation section" — the same four
 * branches (needsFee/needsCommission/needsGift), same field names, checked
 * independently here rather than importing the launch-time function,
 * because a launched campaign's snapshot is SUPPOSED to already guarantee
 * this (validateCompensationReadiness() gates launchCampaign() itself) —
 * this is the defensive, should-be-unreachable check for that invariant,
 * not the primary enforcement of it.
 */
export function validateCampaignBriefCompleteness(details: CampaignDetailsSnapshot): string[] {
  const missing: string[] = [];
  const needsFee = details.campaignType === "PAID" || details.campaignType === "HYBRID";
  const needsCommission = details.campaignType === "AFFILIATE" || details.campaignType === "HYBRID";
  const needsGift = details.campaignType === "GIFT_ONLY" || details.includesGifting;

  if (needsFee) {
    if (!details.priceStrategy) missing.push("priceStrategy");
    if (details.priceStrategy === "PROPOSE_STARTING_FEE" && details.publicStartingFeeCents == null) {
      missing.push("publicStartingFeeCents (required when priceStrategy is PROPOSE_STARTING_FEE)");
    }
  }
  if (needsCommission) {
    if (details.publicCommissionRate == null) missing.push("publicCommissionRate");
  }
  if (needsGift) {
    if (!details.productOrOffer) missing.push("productOrOffer");
    if (!details.giftDisposition) missing.push("giftDisposition");
  }
  return missing;
}

// §5: neutral Pluvus-branded fallback — used whenever a campaign has no
// BrandIdentity row, or every presentational field on it is null. Fixed
// constant, baked into the template CSS the same way; not read from any
// table.
const NEUTRAL_BRAND_DEFAULT: Omit<BrandIdentityProjection, "isDefault"> = {
  logoRef: null,
  primaryColor: "#20303F",
  secondaryColor: "#3E5872",
  typography: "system-ui, sans-serif",
};

/**
 * §5: reads BrandIdentity FRESH at the moment of render — never from a
 * snapshot, since brand presentation is deliberately not locked at launch
 * (a brand can update its logo at any time). The "point-in-time capture"
 * requirement this might look like it violates is about the RENDERED
 * CampaignBrief row (its brandIdentitySnapshot column), not about what a new
 * render reads going in — see §5 in the plan doc for the full reasoning.
 */
export async function resolveBrandPresentation(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<BrandIdentityProjection> {
  const [row] = await client
    .select()
    .from(brandIdentities)
    .where(eq(brandIdentities.campaignId, campaignId))
    .limit(1);

  if (!row || (row.logoRef == null && row.primaryColor == null && row.secondaryColor == null && row.typography == null)) {
    return { ...NEUTRAL_BRAND_DEFAULT, isDefault: true };
  }

  return {
    logoRef: row.logoRef,
    primaryColor: row.primaryColor ?? NEUTRAL_BRAND_DEFAULT.primaryColor,
    secondaryColor: row.secondaryColor ?? NEUTRAL_BRAND_DEFAULT.secondaryColor,
    typography: row.typography ?? NEUTRAL_BRAND_DEFAULT.typography,
    isDefault: false,
  };
}

/**
 * §1: the renderer's one and only input builder. Sourced entirely from the
 * campaign's frozen CampaignTermsSnapshot (via the PLU-137
 * resolveCampaignLaunchContext()/getCampaignTermsSnapshotById() loaders,
 * reused rather than reinvented) plus Campaign.name/brand (execution
 * identity, never part of the material-terms snapshot) and a live
 * BrandIdentity read (§5). Throws CampaignNotFoundError/
 * CampaignNotActiveError/CampaignSnapshotMissingError (from db/campaigns.ts)
 * on an unlaunched or data-integrity-broken campaign — the same errors
 * every other snapshot-reading call site in this codebase already throws.
 */
export async function buildCampaignBriefInput(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignBriefInput> {
  const { campaignTermsSnapshotId } = await resolveCampaignLaunchContext(campaignId, client);
  const snapshot = await getCampaignTermsSnapshotById(campaignTermsSnapshotId, client);
  if (!snapshot) {
    // resolveCampaignLaunchContext() just read this exact row to produce the
    // id above; the row's onDelete: "restrict" FK makes it impossible for a
    // concurrent delete to remove it out from under us. Defensive only.
    throw new CampaignSnapshotMissingError(campaignId);
  }

  const [campaign, brandIdentity, [requirementRow]] = await Promise.all([
    client.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1).then((r) => r[0]),
    resolveBrandPresentation(campaignId, client),
    client
      .select()
      .from(creatorRequirements)
      .where(eq(creatorRequirements.campaignId, campaignId))
      .limit(1),
  ]);
  if (!campaign) {
    // resolveCampaignLaunchContext() above already proved this campaign
    // exists (it read the row to check .status === "ACTIVE"). Defensive
    // only, for the same reason as the snapshot check above.
    throw new CampaignSnapshotMissingError(campaignId);
  }

  const details = snapshot.detailsSnapshot as CampaignDetailsSnapshot;

  // §8/§9: fail loud rather than render an incomplete document. Checked
  // before any projection work below — see validateCampaignBriefCompleteness()'s
  // own doc comment for why this should be unreachable in practice and is
  // checked anyway.
  const missingFields = validateCampaignBriefCompleteness(details);
  if (missingFields.length > 0) {
    throw new CampaignBriefDataIncompleteError(campaignId, missingFields.join(", "));
  }

  const creatorRequirementsProjection: CreatorRequirementsProjection | null =
    requirementRow?.approvedForBrief
      ? {
          platforms: requirementRow.platforms,
          niches: requirementRow.niches,
          geography: requirementRow.geography,
          languages: requirementRow.languages,
          minFollowers: requirementRow.minFollowers,
          audienceNotes: requirementRow.audienceNotes,
          contentStyle: requirementRow.contentStyle,
          brandSafety: requirementRow.brandSafety,
        }
      : null;

  return {
    campaignId,
    campaignTermsSnapshotId: snapshot.id,
    campaignName: campaign.name,
    brand: campaign.brand,
    brandIdentity,
    objective: details.objective,
    productOrOffer: details.productOrOffer,
    keyMessages: details.keyMessages,
    deliverables: details.deliverables,
    timeline: details.timeline,
    compensation: projectCompensation(details),
    publicPaymentTerms: details.publicPaymentTerms,
    attributionWindow: details.attributionWindow,
    contentRequirements: details.contentRequirements,
    usageRights: details.usageRights,
    exclusivity: details.exclusivity,
    prohibitedClaims: details.prohibitedClaims,
    creatorRequirements: creatorRequirementsProjection,
    templateVersion: CAMPAIGN_BRIEF_TEMPLATE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// §6a: request identity / idempotency
// ---------------------------------------------------------------------------

export class CampaignBriefRenderRequestConflictError extends Error {
  constructor(renderRequestId: string) {
    super(`renderRequestId ${renderRequestId} is already in use by a different campaign's CampaignBrief`);
    this.name = "CampaignBriefRenderRequestConflictError";
  }
}

/**
 * §6a: the idempotency boundary. A `renderRequestId` seen before returns the
 * SAME row (`isNew: false`, no new work) — this is what makes a retried
 * `POST` (a lost response, a double-click) a safe no-op. A `renderRequestId`
 * never seen before always creates a NEW row, even when the campaign's
 * `campaignTermsSnapshotId` is identical to every prior render — snapshot
 * identity was never the dedup key (see §6a in the plan doc for the S2→B2,
 * S2→B3 reasoning). Throws the same CampaignNotFoundError/
 * CampaignNotActiveError/CampaignSnapshotMissingError as every other
 * snapshot-reading call site when the campaign isn't launched.
 */
export async function createOrGetCampaignBriefRenderRequest(
  campaignId: string,
  renderRequestId: string,
  client: Db | DbTx = db,
): Promise<{ campaignBrief: CampaignBrief; isNew: boolean }> {
  return await client.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(campaignBriefs)
      .where(eq(campaignBriefs.renderRequestId, renderRequestId))
      .limit(1);
    if (existing) {
      if (existing.campaignId !== campaignId) {
        throw new CampaignBriefRenderRequestConflictError(renderRequestId);
      }
      return { campaignBrief: existing, isNew: false };
    }

    // Proves the campaign is ACTIVE and resolves its one frozen snapshot id
    // — reused, not reinvented; the same guard every other snapshot-reading
    // call site in this codebase already throws.
    const { campaignTermsSnapshotId } = await resolveCampaignLaunchContext(campaignId, tx);

    try {
      const [inserted] = await tx
        .insert(campaignBriefs)
        .values({
          campaignId,
          campaignTermsSnapshotId,
          renderRequestId,
          status: "GENERATING",
          // Placeholder — NOT the point-in-time BrandIdentity capture; the
          // real one is written by finalizeCampaignBriefRender() once Phase
          // 1 has actually read BrandIdentity (§5). The column is NOT NULL,
          // so SOME value is required at insert; a value captured here
          // instead would describe BrandIdentity at ENQUEUE time, which
          // could drift from what the render actually used in the (short)
          // gap before the job runs — this placeholder is never treated as
          // final and is always overwritten before the row leaves GENERATING.
          brandIdentitySnapshot: {},
          templateVersion: CAMPAIGN_BRIEF_TEMPLATE_VERSION,
        })
        .returning();
      if (!inserted) {
        throw new Error(`CampaignBrief insert for renderRequestId ${renderRequestId} returned no row`);
      }
      return { campaignBrief: inserted, isNew: true };
    } catch (err) {
      // Race backstop: two concurrent requests carrying the SAME
      // renderRequestId (a genuine double-submit) can both miss the SELECT
      // above under concurrent transactions, then collide on the
      // renderRequestId UNIQUE constraint. The loser re-reads and returns
      // the winner's row rather than erroring — exactly the idempotent
      // contract §6a promises, regardless of which request "won."
      if (isUniqueViolation(err)) {
        const [row] = await tx
          .select()
          .from(campaignBriefs)
          .where(eq(campaignBriefs.renderRequestId, renderRequestId))
          .limit(1);
        if (row) return { campaignBrief: row, isNew: false };
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// §6: Phase 2 — the short, locked finalize transaction
// ---------------------------------------------------------------------------

export class CampaignBriefNotFoundError extends Error {
  constructor(id: string) {
    super(`CampaignBrief ${id} not found`);
    this.name = "CampaignBriefNotFoundError";
  }
}

/**
 * §8: "a material field the snapshot should guarantee is missing." Should
 * be unreachable in practice — a launched campaign's CampaignTermsSnapshot
 * is written once by launchCampaign() and never touched again, so this
 * exists as a fail-loud assertion, not a validator anything is expected to
 * exercise. Thrown inside the render job, classified to the `DATA_INCOMPLETE`
 * FAILED-row category, never propagates as an HTTP error.
 */
export class CampaignBriefDataIncompleteError extends Error {
  constructor(campaignId: string, reason: string) {
    super(`CampaignBrief render for campaign ${campaignId} is missing required data: ${reason}`);
    this.name = "CampaignBriefDataIncompleteError";
  }
}

export interface FinalizeCampaignBriefRenderInput {
  campaignBriefId: string;
  campaignId: string;
  renderedAssetRef: string;
  brandIdentitySnapshot: BrandIdentityProjection;
  templateVersion: string;
}

/**
 * §6's Phase 2, run at the end of the render job once Phase 1's unlocked
 * work (build input, render HTML, convert to PDF, save bytes) has already
 * succeeded. Six steps:
 *   1. Lock the Campaign row (same `FOR UPDATE` pattern as launchCampaign())
 *      — a concurrent job's Phase 2 for the same campaign blocks here.
 *   2. Re-read the current (READY, supersededAt IS NULL) row INSIDE the
 *      lock — never carried over from Phase 1.
 *   3. If step 2 found a row, mark ITS supersededAt FIRST — never delete
 *      it, never touch its renderedAssetRef. Ordered BEFORE step 4 on
 *      purpose (reordered from an earlier draft that flipped this job's
 *      row to READY first): flipping first would mean both rows briefly
 *      satisfy the partial unique index (`status='READY' AND
 *      supersededAt IS NULL`) at once on a same-campaign re-render,
 *      tripping `CampaignBrief_campaignId_current_key` inside this same
 *      transaction — caught by this file's own test suite.
 *   4. Flip this job's own GENERATING row to READY.
 *   5. Write the BRIEF_RENDERED audit event.
 *   6. Commit (implicit at the end of the transaction callback) — the next
 *      waiting job, if any, proceeds and correctly supersedes THIS row.
 */
export async function finalizeCampaignBriefRender(
  input: FinalizeCampaignBriefRenderInput,
  client: Db | DbTx = db,
): Promise<CampaignBrief> {
  return await client.transaction(async (tx) => {
    await tx.execute(sql`SELECT "id" FROM "Campaign" WHERE "id" = ${input.campaignId} FOR UPDATE`);

    const [current] = await tx
      .select()
      .from(campaignBriefs)
      .where(
        and(
          eq(campaignBriefs.campaignId, input.campaignId),
          eq(campaignBriefs.status, "READY"),
          isNull(campaignBriefs.supersededAt),
        ),
      )
      .limit(1);

    // Supersede the OLD current row BEFORE flipping this job's row to READY
    // (reordered from the plan's literal step 3-then-4 — a real bug this
    // test suite caught: with a same-campaign re-render, flipping the NEW
    // row to READY first meant both rows briefly satisfied the partial
    // unique index — status='READY' AND supersededAt IS NULL — at once,
    // tripping CampaignBrief_campaignId_current_key inside this same
    // transaction. Superseding first means at most one row ever matches
    // that predicate at any point.)
    if (current && current.id !== input.campaignBriefId) {
      await tx
        .update(campaignBriefs)
        .set({ supersededAt: new Date() })
        .where(eq(campaignBriefs.id, current.id));
    }

    const [updated] = await tx
      .update(campaignBriefs)
      .set({
        status: "READY",
        renderedAssetRef: input.renderedAssetRef,
        generatedAt: new Date(),
        brandIdentitySnapshot: input.brandIdentitySnapshot as unknown as JsonValue,
        templateVersion: input.templateVersion,
        errorCategory: null,
      })
      .where(eq(campaignBriefs.id, input.campaignBriefId))
      .returning();
    if (!updated) {
      throw new CampaignBriefNotFoundError(input.campaignBriefId);
    }

    await tx.insert(campaignAuditEvents).values({
      campaignId: input.campaignId,
      eventType: "BRIEF_RENDERED",
      payload: { campaignBriefId: updated.id },
    });

    return updated;
  });
}

/**
 * §8/§9: the FAILED path — set on any exception in Phase 1/2 (or by §6b's
 * crash-recovery sweep, which uses category "STALE" directly rather than
 * calling this). No lock needed: this only ever touches the row THIS job
 * owns, identified by its fixed id (never a fresh row per attempt — see the
 * plan doc's "why jobId is keyed on campaignBriefId" note), so it cannot
 * collide with another job's Phase 2.
 *
 * Review fix (Calvin): predicate-guarded on `status = 'GENERATING'` — same
 * shape as markCampaignBriefStaleIfGenerating(). Before this guard, calling
 * this on a row Phase 2 had ALREADY finalized to READY (e.g. from a bug in
 * some future step added after Phase 2, the way the §7 token-mint step
 * originally was) would silently flip a successfully-finalized brief back
 * to FAILED — leaving no current READY row for retrieval even though a
 * real PDF had already been rendered and stored. Now a no-op once the row
 * has left GENERATING, structurally, not just by caller discipline.
 */
export async function markCampaignBriefFailed(
  campaignBriefId: string,
  errorCategory: "DATA_INCOMPLETE" | "RENDER_FAILED",
  client: Db | DbTx = db,
): Promise<void> {
  await client
    .update(campaignBriefs)
    .set({ status: "FAILED", errorCategory })
    .where(and(eq(campaignBriefs.id, campaignBriefId), eq(campaignBriefs.status, "GENERATING")));
}

// ---------------------------------------------------------------------------
// §7: read paths the routes need
// ---------------------------------------------------------------------------

/**
 * §7's "current (most recent, any status)" row — for GET /campaigns/:id/brief
 * (status/metadata) ONLY. Deliberately NOT used for /brief/pdf (see
 * getCurrentReadyCampaignBrief() below): if a re-render is in flight or just
 * failed, the "most recent attempt" is GENERATING/FAILED even though a
 * perfectly good, un-superseded READY document still exists — the whole
 * point of never overwriting/deleting a prior render is defeated if
 * retrieval blocks on the newest attempt instead of serving the last
 * known-good one. This function answers "what's happening right now,"
 * for a UI to show "rendering…"/"failed"/"ready" — a different question
 * from "what PDF should I actually serve."
 */
export async function getLatestCampaignBriefForCampaign(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignBrief | null> {
  const [row] = await client
    .select()
    .from(campaignBriefs)
    .where(eq(campaignBriefs.campaignId, campaignId))
    .orderBy(desc(campaignBriefs.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The row PDF retrieval should actually serve: the one CURRENT row by the
 * partial unique index's own definition (`status='READY' AND supersededAt
 * IS NULL`) — at most one can ever exist per campaign, enforced by
 * `CampaignBrief_campaignId_current_key` itself, not just by this query's
 * own filter. A re-render in flight (GENERATING) or a re-render that just
 * failed does not change what this returns — the previously-READY,
 * not-yet-superseded row stays current until a NEW render actually
 * finishes and finalizeCampaignBriefRender() supersedes it. Used by
 * `GET /campaigns/:id/brief/pdf`; `GET /campaigns/:id/brief` (status)
 * intentionally uses getLatestCampaignBriefForCampaign() instead — see
 * that function's own doc comment for why they must stay two different
 * queries, not one.
 */
export async function getCurrentReadyCampaignBrief(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignBrief | null> {
  const [row] = await client
    .select()
    .from(campaignBriefs)
    .where(
      and(
        eq(campaignBriefs.campaignId, campaignId),
        eq(campaignBriefs.status, "READY"),
        isNull(campaignBriefs.supersededAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** §7's GET /campaigns/:id/briefs — full history, newest first, every status. */
export async function listCampaignBriefsForCampaign(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignBrief[]> {
  return client
    .select()
    .from(campaignBriefs)
    .where(eq(campaignBriefs.campaignId, campaignId))
    .orderBy(desc(campaignBriefs.createdAt));
}

export async function getCampaignBriefById(
  id: string,
  client: Db | DbTx = db,
): Promise<CampaignBrief | null> {
  const [row] = await client.select().from(campaignBriefs).where(eq(campaignBriefs.id, id)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// §7: creator-facing magic-link token — hashed-token posture (BUG-S1),
// mirroring PaymentInfo.token. Only the SHA-256 hash is ever persisted; the
// raw token exists only at mint time and is never re-readable afterward.
// ---------------------------------------------------------------------------

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Mints a fresh creator-access token for a READY CampaignBrief row. Returns
 * the RAW token exactly once — the caller is responsible for delivering it
 * (nothing in this PR does; see §7/open-question #3, "route only, no
 * executor wiring"). Called from the render worker right after
 * finalizeCampaignBriefRender() succeeds, as its own step — not folded into
 * that transaction, so Phase 2's six-step contract stays exactly as
 * documented.
 */
export async function mintCampaignBriefCreatorToken(
  campaignBriefId: string,
  client: Db | DbTx = db,
): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  await client
    .update(campaignBriefs)
    .set({ creatorTokenHash: hashToken(rawToken) })
    .where(eq(campaignBriefs.id, campaignBriefId));
  return rawToken;
}

/** Resolves a presented raw token back to its CampaignBrief row, or null. */
export async function resolveCampaignBriefByCreatorToken(
  rawToken: string,
  client: Db | DbTx = db,
): Promise<CampaignBrief | null> {
  const [row] = await client
    .select()
    .from(campaignBriefs)
    .where(eq(campaignBriefs.creatorTokenHash, hashToken(rawToken)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// §6b: crash-recovery sweep support
// ---------------------------------------------------------------------------

/**
 * GENERATING rows older than `olderThan` — candidates for §6b's sweep. A
 * row this old has almost certainly lost its worker (process crash, OOM'd
 * Chromium) rather than being legitimately mid-render. Oldest-first, same
 * convention as `listStaleProcessingApprovals`.
 */
export async function listStaleGeneratingCampaignBriefs(
  args: { olderThan: Date; limit?: number },
  client: Db | DbTx = db,
): Promise<CampaignBrief[]> {
  const q = client
    .select()
    .from(campaignBriefs)
    .where(and(eq(campaignBriefs.status, "GENERATING"), lt(campaignBriefs.updatedAt, args.olderThan)))
    .orderBy(asc(campaignBriefs.updatedAt));
  return args.limit ? q.limit(args.limit) : q;
}

/**
 * §6b: marks a stuck row FAILED with category STALE — predicate-guarded on
 * GENERATING, returns null when nothing matched (a racing worker already
 * finished it, win or lose, between the sweep's SELECT and this UPDATE).
 * Deliberately marks FAILED rather than re-enqueueing a retry — unlike
 * `reconcileStuckInstances()`'s auto-retry, a row this stale already
 * exhausted its own BullMQ `attempts` or lost its job entirely; blindly
 * re-enqueueing risks an infinite crash loop if whatever killed the worker
 * (e.g. a systemic Chromium/OOM issue) is still true. An operator (or a
 * fresh `POST /campaigns/:id/brief` with a new renderRequestId) drives the
 * next attempt instead.
 */
export async function markCampaignBriefStaleIfGenerating(
  id: string,
  client: Db | DbTx = db,
): Promise<CampaignBrief | null> {
  const rows = await client
    .update(campaignBriefs)
    .set({ status: "FAILED", errorCategory: "STALE" })
    .where(and(eq(campaignBriefs.id, id), eq(campaignBriefs.status, "GENERATING")))
    .returning();
  return rows[0] ?? null;
}
