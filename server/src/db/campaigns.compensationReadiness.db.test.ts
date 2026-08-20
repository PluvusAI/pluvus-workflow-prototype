/**
 * DB-backed tests for the PLU-136 compensation data contract:
 * validateCompensationReadiness() and the two new launchCampaign() gates it
 * feeds (CompensationReviewPendingError, CompensationIncompleteError).
 * Split out from campaigns.launch.db.test.ts (which owns launch/concurrency/
 * duplication mechanics) because this is a combinatorics-heavy matrix in its
 * own right — one file per concern, matching this repo's existing pattern.
 *
 * Runs against a real embedded Postgres (PGlite) with every migration
 * applied for real, including the compensation-contract delta.
 *
 * Run:  npx tsx --test src/db/campaigns.compensationReadiness.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  launchCampaign,
  duplicateCampaign,
  CompensationReviewPendingError,
  CompensationIncompleteError,
} from "./campaigns.js";
import { upsertNegotiationPolicy } from "./negotiationPolicy.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Review fix: launch now requires a non-empty, structurally valid
// deliverableQuantities array for every campaignType (this file's own tests
// are all about COMPENSATION completeness, not deliverables, so every
// otherwise-complete fixture needs one to keep launching — see the dedicated
// "deliverables gate" tests below for what happens when it's missing/empty).
const DEFAULT_DELIVERABLES = [{ id: "del_default", platform: "instagram", format: "reel", quantity: 1 }];

/**
 * Seeds a Campaign + CampaignDetails (defaulting compensationReviewStatus to
 * CONFIRMED, since most of this file is about field-completeness, not the
 * review gate itself — see the dedicated NEEDS_REVIEW test) + optionally a
 * NegotiationPolicy row (pass `policy: null` to omit it entirely).
 */
async function seedCampaign(
  pgdb: Db,
  suffix: string,
  details: Partial<schema.CampaignDetailsInsert>,
  policy: Partial<schema.NegotiationPolicyInsert> | null,
): Promise<string> {
  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `Comp Test ${suffix}`, brand: "Acme" })
    .returning();
  await pgdb.insert(schema.campaignDetails).values({
    campaignId: campaign!.id,
    compensationReviewStatus: "CONFIRMED",
    deliverableQuantities: DEFAULT_DELIVERABLES,
    ...details,
  });
  if (policy !== null) {
    await pgdb.insert(schema.negotiationPolicies).values({ campaignId: campaign!.id, ...policy });
  }
  return campaign!.id;
}

async function seedPartnership(
  pgdb: Db,
  opts: { agreedFeeCents?: number | null; commissionRate?: number | null; suffix: string },
): Promise<string> {
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Comp Test Creator", email: `comp-${opts.suffix}@test.local` })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: `Comp WF ${opts.suffix}` })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: version!.id, creatorId: creator!.id })
    .returning();
  await pgdb.insert(schema.partnerships).values({
    instanceId: instance!.id,
    creatorId: creator!.id,
    referralCode: `code-${opts.suffix}`,
    agreedFeeCents: opts.agreedFeeCents ?? null,
    commissionRate: opts.commissionRate ?? null,
  });
  return instance!.id;
}

async function main(): Promise<void> {
  console.log("\ncampaigns.compensationReadiness.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  await test("PAID only, REQUEST_RATE_CARD, complete private fee authority — launches", async () => {
    const id = await seedCampaign(
      pgdb,
      "paid",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD" },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("PAID + Gifting requires gift fields in addition to fee fields", async () => {
    const id = await seedCampaign(
      pgdb,
      "paid-gift",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD", includesGifting: true },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    await assert.rejects(
      () => launchCampaign(id, pgdb),
      (err: unknown) =>
        err instanceof CompensationIncompleteError &&
        err.missing.some((m) => m.includes("productOrOffer")),
      "missing gift details should block launch even though fee terms are complete",
    );

    await pgdb
      .update(schema.campaignDetails)
      .set({ productOrOffer: "A branded tote bag", giftDisposition: "KEEP" })
      .where(eq(schema.campaignDetails.campaignId, id));
    await pgdb
      .update(schema.negotiationPolicies)
      .set({ giftSubstitutionAllowed: true })
      .where(eq(schema.negotiationPolicies.campaignId, id));
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("AFFILIATE only — no fee fields required, commission-only launches (PLU-129's 0/0 precedent)", async () => {
    const id = await seedCampaign(
      pgdb,
      "affiliate",
      { campaignType: "AFFILIATE", publicCommissionRate: 15 },
      { commissionFloorRate: 10, commissionCeilingRate: 20 },
    );
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
    const details = snapshot.detailsSnapshot as Record<string, unknown>;
    assert.equal(details["publicStartingFeeCents"], null, "no fee ever required for AFFILIATE");
  });

  await test("AFFILIATE + Gifting requires gift fields in addition to commission fields", async () => {
    const id = await seedCampaign(
      pgdb,
      "affiliate-gift",
      { campaignType: "AFFILIATE", publicCommissionRate: 15, includesGifting: true },
      { commissionFloorRate: 10, commissionCeilingRate: 20 },
    );
    await assert.rejects(() => launchCampaign(id, pgdb), CompensationIncompleteError);

    await pgdb
      .update(schema.campaignDetails)
      .set({ productOrOffer: "Free product sample", giftDisposition: "KEEP" })
      .where(eq(schema.campaignDetails.campaignId, id));
    await pgdb
      .update(schema.negotiationPolicies)
      .set({ giftValueFlexibilityCents: 2000 })
      .where(eq(schema.negotiationPolicies.campaignId, id));
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("HYBRID requires both fee and commission components", async () => {
    const id = await seedCampaign(
      pgdb,
      "hybrid",
      { campaignType: "HYBRID", priceStrategy: "REQUEST_RATE_CARD" },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    // Fee authority present, commission authority missing — still incomplete.
    await assert.rejects(
      () => launchCampaign(id, pgdb),
      (err: unknown) =>
        err instanceof CompensationIncompleteError &&
        err.missing.some((m) => m.includes("publicCommissionRate")),
    );

    await pgdb
      .update(schema.campaignDetails)
      .set({ publicCommissionRate: 8 })
      .where(eq(schema.campaignDetails.campaignId, id));
    await pgdb
      .update(schema.negotiationPolicies)
      .set({ commissionFloorRate: 5, commissionCeilingRate: 10 })
      .where(eq(schema.negotiationPolicies.campaignId, id));
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("HYBRID + Gifting requires fee, commission, AND gift components", async () => {
    const id = await seedCampaign(
      pgdb,
      "hybrid-gift",
      {
        campaignType: "HYBRID",
        priceStrategy: "REQUEST_RATE_CARD",
        publicCommissionRate: 8,
        includesGifting: true,
      },
      { floorCents: 10000, ceilingCents: 30000, commissionFloorRate: 5, commissionCeilingRate: 10 },
    );
    await assert.rejects(() => launchCampaign(id, pgdb), CompensationIncompleteError);

    await pgdb
      .update(schema.campaignDetails)
      .set({ productOrOffer: "Bonus merch kit", giftDisposition: "KEEP" })
      .where(eq(schema.campaignDetails.campaignId, id));
    await pgdb
      .update(schema.negotiationPolicies)
      .set({ giftSubstitutionAllowed: false })
      .where(eq(schema.negotiationPolicies.campaignId, id));
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("GIFT_ONLY requires gift terms, no fee or commission component", async () => {
    const id = await seedCampaign(
      pgdb,
      "gift-only",
      { campaignType: "GIFT_ONLY", productOrOffer: "Running shoes", giftDisposition: "KEEP" },
      { giftSubstitutionAllowed: true },
    );
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
    const details = snapshot.detailsSnapshot as Record<string, unknown>;
    assert.equal(details["publicStartingFeeCents"], null);
    assert.equal(details["publicCommissionRate"], null);
  });

  await test("Invalid GIFT_ONLY without valid gift details is rejected", async () => {
    const id = await seedCampaign(
      pgdb,
      "gift-only-invalid",
      { campaignType: "GIFT_ONLY" },
      { giftSubstitutionAllowed: true },
    );
    await assert.rejects(
      () => launchCampaign(id, pgdb),
      (err: unknown) =>
        err instanceof CompensationIncompleteError &&
        err.missing.some((m) => m.includes("productOrOffer")) &&
        err.missing.some((m) => m.includes("giftDisposition")),
    );
  });

  await test(
    "GIFT_ONLY with giftDisposition=RETURN is rejected — the product is the entire compensation, so it must be KEEP",
    async () => {
      const id = await seedCampaign(
        pgdb,
        "gift-only-return",
        { campaignType: "GIFT_ONLY", productOrOffer: "A loaner camera", giftDisposition: "RETURN" },
        { giftSubstitutionAllowed: true },
      );
      await assert.rejects(
        () => launchCampaign(id, pgdb),
        (err: unknown) =>
          err instanceof CompensationIncompleteError &&
          err.missing.some((m) => m.includes("must be KEEP")),
        "a gift-only campaign claiming the creator's whole payment is a product they have to give back must not launch",
      );

      // Same campaign, disposition corrected to KEEP — launches fine.
      await pgdb
        .update(schema.campaignDetails)
        .set({ giftDisposition: "KEEP" })
        .where(eq(schema.campaignDetails.campaignId, id));
      const snapshot = await launchCampaign(id, pgdb);
      assert.equal(snapshot.campaignId, id);
    },
  );

  await test(
    "PAID + Gifting with giftDisposition=LOAN is allowed — the fee is real payment, the gift is a bonus on top",
    async () => {
      const id = await seedCampaign(
        pgdb,
        "paid-gift-loan",
        {
          campaignType: "PAID",
          priceStrategy: "REQUEST_RATE_CARD",
          includesGifting: true,
          productOrOffer: "A camera for the shoot",
          giftDisposition: "LOAN",
        },
        { floorCents: 10000, ceilingCents: 30000, giftSubstitutionAllowed: false },
      );
      // GIFT_ONLY's KEEP-only rule must NOT apply here — a real fee is paid
      // separately, so a loaned bonus product is a legitimate combination.
      const snapshot = await launchCampaign(id, pgdb);
      assert.equal(snapshot.campaignId, id);
    },
  );

  await test("REQUEST_RATE_CARD PAID campaign does not require a public proposed amount", async () => {
    const id = await seedCampaign(
      pgdb,
      "rate-card",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD" },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const snapshot = await launchCampaign(id, pgdb);
    const details = snapshot.detailsSnapshot as Record<string, unknown>;
    assert.equal(details["publicStartingFeeCents"], null);
  });

  await test("PROPOSE_STARTING_FEE PAID campaign requires publicStartingFeeCents", async () => {
    const id = await seedCampaign(
      pgdb,
      "proposed-fee",
      { campaignType: "PAID", priceStrategy: "PROPOSE_STARTING_FEE" },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    await assert.rejects(
      () => launchCampaign(id, pgdb),
      (err: unknown) =>
        err instanceof CompensationIncompleteError &&
        err.missing.some((m) => m.includes("publicStartingFeeCents")),
    );

    await pgdb
      .update(schema.campaignDetails)
      .set({ publicStartingFeeCents: 25000 })
      .where(eq(schema.campaignDetails.campaignId, id));
    const snapshot = await launchCampaign(id, pgdb);
    const details = snapshot.detailsSnapshot as Record<string, unknown>;
    assert.equal(details["publicStartingFeeCents"], 25000);
  });

  await test(
    "public commission reaches CampaignTermsSnapshot; private flexibility stays only in NegotiationPolicySnapshot",
    async () => {
      const id = await seedCampaign(
        pgdb,
        "public-private-split",
        { campaignType: "AFFILIATE", publicCommissionRate: 12.5 },
        { commissionFloorRate: 8, commissionCeilingRate: 15, preferredCommissionRate: 10 },
      );
      const snapshot = await launchCampaign(id, pgdb);
      const publicSnapshot = snapshot.detailsSnapshot as Record<string, unknown>;
      assert.equal(publicSnapshot["publicCommissionRate"], 12.5, "public rate is in the public snapshot");
      assert.ok(
        !("commissionFloorRate" in publicSnapshot) && !("commissionCeilingRate" in publicSnapshot),
        "private flexibility bounds must NEVER appear in the public CampaignTermsSnapshot",
      );

      const [policySnapshot] = await pgdb
        .select()
        .from(schema.negotiationPolicySnapshots)
        .where(eq(schema.negotiationPolicySnapshots.campaignId, id));
      assert.equal(policySnapshot!.commissionFloorRate, 8);
      assert.equal(policySnapshot!.commissionCeilingRate, 15);
      assert.equal(policySnapshot!.preferredCommissionRate, 10);
    },
  );

  await test(
    "creator-specific final terms (Partnership) never overwrite campaign-wide terms (CampaignTermsSnapshot)",
    async () => {
      const id = await seedCampaign(
        pgdb,
        "no-overwrite",
        { campaignType: "PAID", priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 20000 },
        { floorCents: 10000, ceilingCents: 30000 },
      );
      const snapshot = await launchCampaign(id, pgdb);

      // A creator negotiates a DIFFERENT final fee — recorded on Partnership,
      // a wholly separate table with no write path back to CampaignDetails/
      // CampaignTermsSnapshot.
      await seedPartnership(pgdb, { agreedFeeCents: 45000, suffix: id });

      const [snapshotAfter] = await pgdb
        .select()
        .from(schema.campaignTermsSnapshots)
        .where(eq(schema.campaignTermsSnapshots.id, snapshot.id));
      const detailsAfter = snapshotAfter!.detailsSnapshot as Record<string, unknown>;
      assert.equal(
        detailsAfter["publicStartingFeeCents"],
        20000,
        "the campaign-wide public offer is untouched by a creator's individually-negotiated final fee",
      );
    },
  );

  await test(
    "a product supplied only for content creation (shipsPhysicalProduct, no includesGifting) is not treated as gifting compensation",
    async () => {
      const id = await seedCampaign(
        pgdb,
        "sample-not-gift",
        {
          campaignType: "PAID",
          priceStrategy: "REQUEST_RATE_CARD",
          shipsPhysicalProduct: true,
          // includesGifting deliberately omitted (false by default) — a
          // sample shipped so the creator CAN make content is not the same
          // as the product being part of the compensation offer.
        },
        { floorCents: 10000, ceilingCents: 30000 },
      );
      // No productOrOffer/giftDisposition/gift authority set anywhere, and
      // this still launches — proves shipsPhysicalProduct alone never
      // triggers the gift-completeness requirements.
      const snapshot = await launchCampaign(id, pgdb);
      assert.equal(snapshot.campaignId, id);
    },
  );

  await test(
    "duplicateCampaign resets compensationReviewStatus to NEEDS_REVIEW even when the source was CONFIRMED, and copies every compensation field",
    async () => {
      const id = await seedCampaign(
        pgdb,
        "dup-source",
        {
          campaignType: "HYBRID",
          priceStrategy: "PROPOSE_STARTING_FEE",
          publicStartingFeeCents: 30000,
          publicCommissionRate: 7,
          includesGifting: true,
          productOrOffer: "Skincare set",
          giftDisposition: "KEEP",
        },
        {
          floorCents: 15000,
          ceilingCents: 40000,
          commissionFloorRate: 5,
          commissionCeilingRate: 9,
          giftSubstitutionAllowed: false,
        },
      );
      await launchCampaign(id, pgdb); // source is CONFIRMED and ACTIVE

      const duplicate = await duplicateCampaign(id, pgdb);
      const [dupDetails] = await pgdb
        .select()
        .from(schema.campaignDetails)
        .where(eq(schema.campaignDetails.campaignId, duplicate.id));
      assert.equal(dupDetails!.campaignType, "HYBRID");
      assert.equal(dupDetails!.publicStartingFeeCents, 30000);
      assert.equal(dupDetails!.publicCommissionRate, 7);
      assert.equal(dupDetails!.includesGifting, true);
      assert.equal(
        dupDetails!.compensationReviewStatus,
        "NEEDS_REVIEW",
        "a duplicate is a new draft with its own terms to re-verify, never an inherited confirmation",
      );
    },
  );

  await test(
    "a campaign left at the default NEEDS_REVIEW cannot launch even with otherwise-complete fields (compatibility/manual-review gate)",
    async () => {
      const [campaign] = await pgdb
        .insert(schema.campaigns)
        .values({ name: "Needs Review", brand: "Acme" })
        .returning();
      // Deliberately NOT setting compensationReviewStatus — the column
      // default (NEEDS_REVIEW) applies, simulating a pre-existing campaign
      // backfilled by the compensation-contract migration.
      await pgdb.insert(schema.campaignDetails).values({
        campaignId: campaign!.id,
        campaignType: "PAID",
        priceStrategy: "REQUEST_RATE_CARD",
        deliverableQuantities: DEFAULT_DELIVERABLES,
      });
      await pgdb.insert(schema.negotiationPolicies).values({
        campaignId: campaign!.id,
        floorCents: 10000,
        ceilingCents: 30000,
      });

      await assert.rejects(
        () => launchCampaign(campaign!.id, pgdb),
        CompensationReviewPendingError,
        "fields being complete does not bypass the unverified-classification gate",
      );

      await pgdb
        .update(schema.campaignDetails)
        .set({ compensationReviewStatus: "CONFIRMED" })
        .where(eq(schema.campaignDetails.campaignId, campaign!.id));
      const snapshot = await launchCampaign(campaign!.id, pgdb);
      assert.equal(snapshot.campaignId, campaign!.id);
    },
  );

  await test(
    "the nonNegotiableTerms marker actually works end-to-end via upsertNegotiationPolicy — a fixed, non-negotiable fee no longer requires faking floor=ceiling",
    async () => {
      const [campaign] = await pgdb
        .insert(schema.campaigns)
        .values({ name: "Fixed, Non-Negotiable", brand: "Acme" })
        .returning();
      await pgdb.insert(schema.campaignDetails).values({
        campaignId: campaign!.id,
        campaignType: "PAID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        publicStartingFeeCents: 50000,
        compensationReviewStatus: "CONFIRMED",
        deliverableQuantities: DEFAULT_DELIVERABLES,
      });

      // No floorCents/ceilingCents at all — only the marker. Written through
      // the real upsertNegotiationPolicy(), the same function the
      // PATCH /campaigns/:id/negotiation-policy route calls, proving the
      // route's write path (not just a hand-inserted test row) satisfies the
      // readiness check.
      await upsertNegotiationPolicy(campaign!.id, { nonNegotiableTerms: ["fee"] }, pgdb);

      const snapshot = await launchCampaign(campaign!.id, pgdb);
      assert.equal(snapshot.campaignId, campaign!.id);

      const [policySnapshot] = await pgdb
        .select()
        .from(schema.negotiationPolicySnapshots)
        .where(eq(schema.negotiationPolicySnapshots.campaignId, campaign!.id));
      assert.deepEqual(
        policySnapshot!.nonNegotiableTerms,
        ["fee"],
        "the non-negotiable marker itself is frozen into the snapshot, same as every other policy field",
      );
    },
  );

  console.log("\ndeliverables gate — review fix: launch requires a non-empty, valid deliverables list\n");

  await test("a campaign with NO deliverableQuantities at all cannot launch", async () => {
    const id = await seedCampaign(
      pgdb,
      "no-deliverables",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD", deliverableQuantities: null },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    await assert.rejects(
      () => launchCampaign(id, pgdb),
      (err: unknown) =>
        err instanceof CompensationIncompleteError &&
        err.missing.some((m) => m.includes("deliverableQuantities")),
      "otherwise-complete compensation fields must not be enough — deliverables are required too",
    );
  });

  await test("a campaign with an EMPTY deliverableQuantities array cannot launch", async () => {
    const id = await seedCampaign(
      pgdb,
      "empty-deliverables",
      { campaignType: "AFFILIATE", publicCommissionRate: 15, deliverableQuantities: [] },
      { commissionFloorRate: 10, commissionCeilingRate: 20 },
    );
    await assert.rejects(
      () => launchCampaign(id, pgdb),
      (err: unknown) =>
        err instanceof CompensationIncompleteError &&
        err.missing.some((m) => m.includes("non-empty")),
    );
  });

  // Review fix (round 2): an invalid platform/format combination (not in
  // PLATFORM_FORMAT_MATRIX) is a recognized LEGACY shape, not necessarily a
  // genuinely malformed one — normalizeLegacyDeliverables migrates it into
  // the flexible platform:"other"/format:"other" slot (with a synthesized
  // customLabel) rather than blocking launch, so an old campaign with this
  // kind of historical data isn't stuck unable to ever launch.
  await test("an invalid platform/format combination in deliverableQuantities is migrated and DOES launch", async () => {
    const id = await seedCampaign(
      pgdb,
      "invalid-deliverables",
      {
        campaignType: "GIFT_ONLY",
        productOrOffer: "Running shoes",
        giftDisposition: "KEEP",
        // tiktok only pairs with "video" (PLATFORM_FORMAT_MATRIX).
        deliverableQuantities: [{ id: "del_bad", platform: "tiktok", format: "reel", quantity: 1 }],
      },
      { giftSubstitutionAllowed: true },
    );
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("a legacy deliverable row missing `id` is normalized and does NOT block launch", async () => {
    const id = await seedCampaign(
      pgdb,
      "legacy-deliverables",
      {
        campaignType: "PAID",
        priceStrategy: "REQUEST_RATE_CARD",
        // No id — simulates a draft campaign created before the id
        // requirement shipped. Must not be rejected purely for that.
        deliverableQuantities: [{ platform: "instagram", format: "reel", quantity: 2 }],
      },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  await test("a fully valid deliverableQuantities array launches cleanly (baseline for the gate above)", async () => {
    const id = await seedCampaign(
      pgdb,
      "valid-deliverables",
      {
        campaignType: "PAID",
        priceStrategy: "REQUEST_RATE_CARD",
        deliverableQuantities: [
          { id: "del_a", platform: "instagram", format: "reel", quantity: 2 },
          { id: "del_b", platform: "instagram", format: "story", quantity: 1 },
        ],
      },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const snapshot = await launchCampaign(id, pgdb);
    assert.equal(snapshot.campaignId, id);
  });

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaigns.compensationReadiness.db test failed:", err);
  process.exit(1);
});
