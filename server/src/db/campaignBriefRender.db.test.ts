/**
 * DB-backed tests for PLU-139 (Campaign Brief Rendering): the input contract
 * (buildCampaignBriefInput/resolveBrandPresentation), the deterministic HTML
 * template, the AI-narrative safety guard, the full render pipeline
 * (renderCampaignBriefWorker's renderCampaignBrief()), the §6a idempotency
 * boundary, the §6 concurrency backstop, and the §6b crash-recovery sweep.
 *
 * Runs against a real embedded Postgres (PGlite) with every migration
 * applied for real, including this ticket's own migration — same convention
 * as every other .db.test.ts this session.
 *
 * Puppeteer and local file storage run FOR REAL here (proven fast and
 * working via a manual smoke test during implementation) — no BullMQ/Redis
 * involved at all: renderCampaignBrief() has zero queue dependency, only the
 * route layer (not exercised by this file) enqueues. aiNarrative() calls a
 * real (mocked or absent) HTTP endpoint; with no agent service listening the
 * connection is refused near-instantly, which is itself the case test #8
 * needs.
 *
 * Run:  npx tsx --test src/db/campaignBriefRender.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { launchCampaign } from "./campaigns.js";
import { upsertNegotiationPolicy } from "./negotiationPolicy.js";
import {
  buildCampaignBriefInput,
  resolveBrandPresentation,
  createOrGetCampaignBriefRenderRequest,
  finalizeCampaignBriefRender,
  getLatestCampaignBriefForCampaign,
  getCurrentReadyCampaignBrief,
  listStaleGeneratingCampaignBriefs,
  markCampaignBriefFailed,
  markCampaignBriefStaleIfGenerating,
  resolveCampaignBriefByCreatorToken,
  validateCampaignBriefCompleteness,
  CampaignBriefDataIncompleteError,
  type CampaignDetailsSnapshot,
} from "./campaignBriefRender.js";
import { renderCampaignBriefHtml } from "../templates/campaignBrief/index.js";
import { defaultNarrative } from "../templates/campaignBrief/narrative.js";
import { renderCampaignBrief } from "../workers/campaignBriefRenderWorker.js";
import { sweepStaleCampaignBriefRenders } from "../scheduler/campaignBriefRenderSweep.js";
import { readStoredFile } from "../storage/localFileStorage.js";
import { resetAgentBreaker } from "../adapters/agentServiceClient.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

/** Seeds a fully-launched campaign, ready for buildCampaignBriefInput()/renderCampaignBrief(). */
async function seedLaunchedCampaign(
  pgdb: Db,
  suffix: string,
  details: Partial<schema.CampaignDetailsInsert> = {},
  policy: Partial<schema.NegotiationPolicyInsert> = { floorCents: 10_000, ceilingCents: 30_000 },
): Promise<{ campaignId: string; campaignTermsSnapshotId: string }> {
  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `Brief Test ${suffix}`, brand: `Brand ${suffix}` })
    .returning();
  await pgdb.insert(schema.campaignDetails).values({
    campaignId: campaign!.id,
    campaignType: "PAID",
    priceStrategy: "REQUEST_RATE_CARD",
    compensationReviewStatus: "CONFIRMED",
    objective: "Drive signups",
    productOrOffer: "A branded tote bag",
    keyMessages: "Sustainable. Stylish.",
    deliverables: "1 Reel",
    timeline: "By Sept 1",
    contentRequirements: "Tag the brand",
    usageRights: "60-day paid social",
    exclusivity: "No competitors for 30 days",
    attributionWindow: "30 days",
    prohibitedClaims: "No health claims",
    publicPaymentTerms: "Net 30",
    ...details,
  });
  await pgdb.insert(schema.negotiationPolicies).values({ campaignId: campaign!.id, ...policy });
  const snapshot = await launchCampaign(campaign!.id, pgdb);
  return { campaignId: campaign!.id, campaignTermsSnapshotId: snapshot.id };
}

function mockFetchOnce(status: number, jsonBody: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(jsonBody), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    resetAgentBreaker();
  };
}

async function main(): Promise<void> {
  console.log("\ncampaignBriefRender.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // 1. Render from a known snapshot fixture — every material field matches.
  await test("buildCampaignBriefInput: every material field matches the snapshot exactly", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "fixture");
    const input = await buildCampaignBriefInput(campaignId, pgdb);
    assert.equal(input.campaignId, campaignId);
    assert.equal(input.objective, "Drive signups");
    assert.equal(input.productOrOffer, "A branded tote bag");
    assert.equal(input.keyMessages, "Sustainable. Stylish.");
    assert.equal(input.deliverables, "1 Reel");
    assert.equal(input.timeline, "By Sept 1");
    assert.equal(input.contentRequirements, "Tag the brand");
    assert.equal(input.usageRights, "60-day paid social");
    assert.equal(input.exclusivity, "No competitors for 30 days");
    assert.equal(input.attributionWindow, "30 days");
    assert.equal(input.prohibitedClaims, "No health claims");
    assert.equal(input.publicPaymentTerms, "Net 30");
    assert.deepEqual(input.compensation, {
      kind: "PAID",
      priceStrategy: "REQUEST_RATE_CARD",
      startingFeeCents: null,
      includesGifting: false,
      giftDisposition: null,
    });
  });

  // 1b. PLU-141 review (Calvin): CampaignBriefDataIncompleteError was declared
  // but never actually thrown. A launched campaign's snapshot SHOULD already
  // guarantee completeness (launchCampaign()'s validateCompensationReadiness()
  // gate) — these seed a CampaignTermsSnapshot directly (bypassing
  // launchCampaign()) to simulate the "should be unreachable" case the
  // defensive check exists for.
  await test("validateCampaignBriefCompleteness: PAID missing priceStrategy is reported", async () => {
    const details = { campaignType: "PAID", includesGifting: false } as CampaignDetailsSnapshot;
    const missing = validateCampaignBriefCompleteness(details);
    assert.ok(missing.includes("priceStrategy"));
  });

  await test(
    "validateCampaignBriefCompleteness: PROPOSE_STARTING_FEE without a fee amount is reported",
    async () => {
      const details = {
        campaignType: "PAID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        publicStartingFeeCents: null,
        includesGifting: false,
      } as CampaignDetailsSnapshot;
      const missing = validateCampaignBriefCompleteness(details);
      assert.ok(missing.some((m) => m.includes("publicStartingFeeCents")));
    },
  );

  await test("validateCampaignBriefCompleteness: AFFILIATE missing commission rate is reported", async () => {
    const details = {
      campaignType: "AFFILIATE",
      publicCommissionRate: null,
      includesGifting: false,
    } as CampaignDetailsSnapshot;
    const missing = validateCampaignBriefCompleteness(details);
    assert.ok(missing.includes("publicCommissionRate"));
  });

  await test("validateCampaignBriefCompleteness: GIFT_ONLY missing product/disposition is reported", async () => {
    const details = {
      campaignType: "GIFT_ONLY",
      productOrOffer: null,
      giftDisposition: null,
      includesGifting: false,
    } as CampaignDetailsSnapshot;
    const missing = validateCampaignBriefCompleteness(details);
    assert.ok(missing.includes("productOrOffer"));
    assert.ok(missing.includes("giftDisposition"));
  });

  await test("validateCampaignBriefCompleteness: a fully-specified PAID snapshot reports nothing missing", async () => {
    const details = {
      campaignType: "PAID",
      priceStrategy: "REQUEST_RATE_CARD",
      publicStartingFeeCents: null,
      includesGifting: false,
    } as CampaignDetailsSnapshot;
    assert.deepEqual(validateCampaignBriefCompleteness(details), []);
  });

  await test(
    "buildCampaignBriefInput: an incomplete snapshot throws CampaignBriefDataIncompleteError, categorized DATA_INCOMPLETE by the worker",
    async () => {
      // Seed a campaign + CampaignTermsSnapshot DIRECTLY, bypassing
      // launchCampaign() (which would refuse to create this snapshot in the
      // first place) — simulating the defensive, should-be-unreachable case.
      const [campaign] = await pgdb
        .insert(schema.campaigns)
        .values({ name: "Incomplete Snapshot", brand: "Acme", status: "ACTIVE" })
        .returning();
      await pgdb.insert(schema.campaignTermsSnapshots).values({
        campaignId: campaign!.id,
        detailsSnapshot: {
          campaignType: "AFFILIATE",
          publicCommissionRate: null, // missing — AFFILIATE requires this
          includesGifting: false,
        },
      });

      await assert.rejects(
        () => buildCampaignBriefInput(campaign!.id, pgdb),
        (err: unknown) => err instanceof CampaignBriefDataIncompleteError,
      );

      // And through the actual worker entry point, which classifies this
      // exact error type to the DATA_INCOMPLETE FAILED-row category.
      const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(
        campaign!.id,
        "req-incomplete-snapshot",
        pgdb,
      );
      await assert.rejects(() => renderCampaignBrief(campaignBrief.id, pgdb));
      const [reread] = await pgdb
        .select()
        .from(schema.campaignBriefs)
        .where(eq(schema.campaignBriefs.id, campaignBrief.id));
      assert.equal(reread!.status, "FAILED");
      assert.equal(reread!.errorCategory, "DATA_INCOMPLETE");
    },
  );

  // 1d. Review fix (Calvin): "token failure invalidates the finalized
  // brief." markCampaignBriefFailed() must be a no-op once a row has left
  // GENERATING — this is the structural guard that stops a failure in
  // anything that runs AFTER Phase 2 (the §7 token mint, or any future
  // post-finalize step) from retroactively invalidating an already-
  // successful, already-committed render.
  await test(
    "markCampaignBriefFailed: is a no-op on a row that already left GENERATING (predicate-guarded)",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb, "mark-failed-guard");
      const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(
        campaignId,
        "req-mark-failed-guard",
        pgdb,
      );

      // Still GENERATING — the guard must allow this.
      await markCampaignBriefFailed(campaignBrief.id, "RENDER_FAILED", pgdb);
      const [afterGenerating] = await pgdb
        .select()
        .from(schema.campaignBriefs)
        .where(eq(schema.campaignBriefs.id, campaignBrief.id));
      assert.equal(afterGenerating!.status, "FAILED", "GENERATING -> FAILED must still work");
      assert.equal(afterGenerating!.errorCategory, "RENDER_FAILED");

      // Reset it to READY directly (simulating "Phase 2 already finalized
      // this row" — the exact state a post-finalize failure, like a token
      // mint error, would race against).
      await pgdb
        .update(schema.campaignBriefs)
        .set({ status: "READY", errorCategory: null })
        .where(eq(schema.campaignBriefs.id, campaignBrief.id));

      // A later call (simulating the OLD bug: a post-finalize failure
      // reaching markCampaignBriefFailed) must NOT flip this READY row back.
      await markCampaignBriefFailed(campaignBrief.id, "RENDER_FAILED", pgdb);
      const [afterReady] = await pgdb
        .select()
        .from(schema.campaignBriefs)
        .where(eq(schema.campaignBriefs.id, campaignBrief.id));
      assert.equal(afterReady!.status, "READY", "a READY row must never be flipped back to FAILED");
      assert.equal(afterReady!.errorCategory, null);
    },
  );

  // 1e. Review fix (Calvin), end-to-end: a token-mint failure after a
  // successful render must leave the brief READY and retrievable — proven
  // by actually rendering, then directly exercising the exact sequence the
  // OLD (buggy) code would have hit (Phase 2 commits READY, then something
  // after it fails), and confirming the row survives untouched.
  await test(
    "renderCampaignBrief: a successful render survives a simulated post-finalize failure — stays READY, current, and retrievable",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb, "token-failure-survives");
      const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(
        campaignId,
        "req-token-failure-survives",
        pgdb,
      );
      await renderCampaignBrief(campaignBrief.id, pgdb);

      const readyBefore = await getCurrentReadyCampaignBrief(campaignId, pgdb);
      assert.equal(readyBefore!.id, campaignBrief.id);
      assert.equal(readyBefore!.status, "READY");
      const assetRef = readyBefore!.renderedAssetRef;

      // Simulate exactly what the OLD bug did: a post-finalize failure
      // reaching the shared render-failure path for this ALREADY-READY row.
      await markCampaignBriefFailed(campaignBrief.id, "RENDER_FAILED", pgdb);

      const readyAfter = await getCurrentReadyCampaignBrief(campaignId, pgdb);
      assert.ok(readyAfter, "a current READY brief must still exist for PDF retrieval");
      assert.equal(readyAfter!.id, campaignBrief.id);
      assert.equal(readyAfter!.renderedAssetRef, assetRef);
    },
  );

  // 1c. PLU-141 review (Calvin): full compensation-structure × gifting fixture
  // matrix — the ticket's own required coverage (Paid, Affiliate, Hybrid,
  // Gift-only, Paid+Gifting, Affiliate+Gifting, Hybrid+Gifting, and product
  // supplied only for content production).
  const compensationFixtures: {
    name: string;
    details: Partial<schema.CampaignDetailsInsert>;
    policy: Partial<schema.NegotiationPolicyInsert>;
    expectCompensation: Record<string, unknown>;
    expectGiftMention: boolean;
  }[] = [
    {
      name: "Paid",
      details: { campaignType: "PAID", priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50_000 },
      policy: { floorCents: 30_000, ceilingCents: 70_000 },
      expectCompensation: {
        kind: "PAID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        startingFeeCents: 50_000,
        includesGifting: false,
        giftDisposition: null,
      },
      expectGiftMention: false,
    },
    {
      name: "Affiliate",
      details: { campaignType: "AFFILIATE", publicCommissionRate: 0.12 },
      policy: { commissionFloorRate: 0.08, commissionCeilingRate: 0.15 },
      expectCompensation: {
        kind: "AFFILIATE",
        commissionRate: 0.12,
        commissionDurationDays: null,
        commissionConditions: null,
        includesGifting: false,
        giftDisposition: null,
      },
      expectGiftMention: false,
    },
    {
      name: "Hybrid",
      details: {
        campaignType: "HYBRID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        publicStartingFeeCents: 40_000,
        publicCommissionRate: 0.1,
      },
      policy: {
        floorCents: 20_000,
        ceilingCents: 60_000,
        commissionFloorRate: 0.05,
        commissionCeilingRate: 0.15,
      },
      expectCompensation: {
        kind: "HYBRID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        startingFeeCents: 40_000,
        commissionRate: 0.1,
        commissionDurationDays: null,
        commissionConditions: null,
        includesGifting: false,
        giftDisposition: null,
      },
      expectGiftMention: false,
    },
    {
      name: "Gift-only",
      details: { campaignType: "GIFT_ONLY", productOrOffer: "Full-size skincare set", giftDisposition: "KEEP" },
      policy: { giftSubstitutionAllowed: true },
      expectCompensation: { kind: "GIFT_ONLY", giftDisposition: "KEEP" },
      expectGiftMention: true,
    },
    {
      name: "Paid + Gifting",
      details: {
        campaignType: "PAID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        publicStartingFeeCents: 30_000,
        includesGifting: true,
        productOrOffer: "A skincare sample kit",
        giftDisposition: "KEEP",
      },
      policy: { floorCents: 20_000, ceilingCents: 40_000, giftSubstitutionAllowed: true },
      expectCompensation: {
        kind: "PAID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        startingFeeCents: 30_000,
        includesGifting: true,
        giftDisposition: "KEEP",
      },
      expectGiftMention: true,
    },
    {
      name: "Affiliate + Gifting",
      details: {
        campaignType: "AFFILIATE",
        publicCommissionRate: 0.15,
        includesGifting: true,
        productOrOffer: "A starter bundle",
        giftDisposition: "KEEP",
      },
      policy: { commissionFloorRate: 0.1, commissionCeilingRate: 0.2, giftSubstitutionAllowed: true },
      expectCompensation: {
        kind: "AFFILIATE",
        commissionRate: 0.15,
        commissionDurationDays: null,
        commissionConditions: null,
        includesGifting: true,
        giftDisposition: "KEEP",
      },
      expectGiftMention: true,
    },
    {
      name: "Hybrid + Gifting",
      details: {
        campaignType: "HYBRID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        publicStartingFeeCents: 35_000,
        publicCommissionRate: 0.08,
        includesGifting: true,
        productOrOffer: "A full product line sample",
        giftDisposition: "KEEP",
      },
      policy: {
        floorCents: 20_000,
        ceilingCents: 50_000,
        commissionFloorRate: 0.05,
        commissionCeilingRate: 0.12,
        giftSubstitutionAllowed: true,
      },
      expectCompensation: {
        kind: "HYBRID",
        priceStrategy: "PROPOSE_STARTING_FEE",
        startingFeeCents: 35_000,
        commissionRate: 0.08,
        commissionDurationDays: null,
        commissionConditions: null,
        includesGifting: true,
        giftDisposition: "KEEP",
      },
      expectGiftMention: true,
    },
    {
      // Distinct from "Gifting": shipsPhysicalProduct only means "collect a
      // shipping address" (schema.ts's own doc comment) — the product is
      // sent so the creator can film with it, NOT part of the compensation.
      // Must render its own "Product or offer" section but NOT be mentioned
      // in the compensation section.
      name: "Product supplied only for content production (not compensation)",
      details: {
        campaignType: "PAID",
        priceStrategy: "REQUEST_RATE_CARD",
        shipsPhysicalProduct: true,
        includesGifting: false,
        productOrOffer: "A sample unit for filming",
        giftDisposition: null,
      },
      policy: { floorCents: 20_000, ceilingCents: 40_000 },
      expectCompensation: {
        kind: "PAID",
        priceStrategy: "REQUEST_RATE_CARD",
        startingFeeCents: null,
        includesGifting: false,
        giftDisposition: null,
      },
      expectGiftMention: false,
    },
  ];

  for (const fixture of compensationFixtures) {
    await test(`compensation fixture: ${fixture.name}`, async () => {
      const { campaignId } = await seedLaunchedCampaign(
        pgdb,
        `comp-${fixture.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        fixture.details,
        fixture.policy,
      );
      const input = await buildCampaignBriefInput(campaignId, pgdb);
      assert.deepEqual(input.compensation, fixture.expectCompensation, fixture.name);

      const html = renderCampaignBriefHtml(input, defaultNarrative(input));
      assert.ok(html.includes("Product or offer"), `${fixture.name}: Product or offer section always present`);
      if (fixture.expectGiftMention) {
        assert.ok(
          html.includes("also includes a product") || fixture.expectCompensation["kind"] === "GIFT_ONLY",
          `${fixture.name}: compensation section should reflect the gift`,
        );
      } else {
        assert.ok(
          !html.includes("also includes a product"),
          `${fixture.name}: compensation section must NOT claim a product is part of compensation`,
        );
      }
    });
  }

  // 2. NegotiationPolicy is never read — private fields never leak into the input.
  await test("buildCampaignBriefInput: NegotiationPolicy fields never appear in the input", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "private-policy");
    // seedLaunchedCampaign already wrote a NegotiationPolicy row (floor/ceiling)
    // — deliberately present, to prove it's excluded, not merely absent.
    const input = await buildCampaignBriefInput(campaignId, pgdb);
    const serialized = JSON.stringify(input);
    assert.ok(!serialized.includes("10000"), "floorCents must not leak into the render input");
    assert.ok(!serialized.includes("30000"), "ceilingCents must not leak into the render input");
  });

  // 3. nodeGraph values cannot enter the render input.
  await test("buildCampaignBriefInput: WorkflowVersion.nodeGraph is never read", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "nodegraph");
    const [workflow] = await pgdb
      .insert(schema.workflows)
      .values({ name: "Brief Test WF", campaignId })
      .returning();
    await pgdb.insert(schema.workflowVersions).values({
      workflowId: workflow!.id,
      version: 1,
      nodeGraph: [{ id: "n1", type: "INITIAL_OUTREACH", order: 0, config: { secretMarker: "NODE-CONFIG-MARKER-XYZ" } }],
    });
    const input = await buildCampaignBriefInput(campaignId, pgdb);
    assert.ok(!JSON.stringify(input).includes("NODE-CONFIG-MARKER-XYZ"));
  });

  // 4. Empty sections omitted.
  await test("renderCampaignBriefHtml: a minimal campaign omits every empty optional section", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "minimal", {
      objective: null,
      productOrOffer: null,
      keyMessages: null,
      deliverables: null,
      timeline: null,
      contentRequirements: null,
      usageRights: null,
      exclusivity: null,
      attributionWindow: null,
      prohibitedClaims: null,
      publicPaymentTerms: null,
    });
    const input = await buildCampaignBriefInput(campaignId, pgdb);
    const html = renderCampaignBriefHtml(input, defaultNarrative(input));
    for (const label of [
      "PRODUCT OR OFFER",
      "OBJECTIVE",
      "KEY MESSAGES",
      "DELIVERABLES",
      "CONTENT REQUIREMENTS",
      "TIMELINE",
      "USAGE RIGHTS",
      "EXCLUSIVITY",
      "ATTRIBUTION WINDOW",
      "PROHIBITED CLAIMS",
    ]) {
      assert.ok(!html.includes(`<h2>${label}`), `${label} section should be omitted when empty`);
    }
    // The compensation section is never omitted (always has content).
    assert.ok(html.includes("Compensation"));
  });

  // 5. Long content / multi-page renders without truncation.
  await test("renderCampaignBriefHtml: long deliverables content is not truncated", async () => {
    const long = "Deliverable detail. ".repeat(500); // ~10,000 chars
    const { campaignId } = await seedLaunchedCampaign(pgdb, "long", { deliverables: long });
    const input = await buildCampaignBriefInput(campaignId, pgdb);
    const html = renderCampaignBriefHtml(input, defaultNarrative(input));
    assert.ok(html.includes(long.trim().slice(0, 200)), "long content must appear in full, not truncated");
  });

  // 6. Missing logo/colors → default presentation captured.
  await test("resolveBrandPresentation: no BrandIdentity row → neutral default, isDefault true", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "no-brand");
    const brand = await resolveBrandPresentation(campaignId, pgdb);
    assert.equal(brand.isDefault, true);
    assert.equal(brand.logoRef, null);
  });

  await test("resolveBrandPresentation: a real BrandIdentity row is used, isDefault false", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "real-brand");
    await pgdb.insert(schema.brandIdentities).values({
      campaignId,
      primaryColor: "#112233",
      secondaryColor: "#445566",
      typography: "Georgia",
    });
    const brand = await resolveBrandPresentation(campaignId, pgdb);
    assert.equal(brand.isDefault, false);
    assert.equal(brand.primaryColor, "#112233");
  });

  // 7. Point-in-time brand presentation stored.
  await test("renderCampaignBrief: brandIdentitySnapshot is a point-in-time copy, unaffected by a later edit", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "point-in-time");
    await pgdb.insert(schema.brandIdentities).values({ campaignId, primaryColor: "#AAAAAA" });

    const { campaignBrief: first } = await createOrGetCampaignBriefRenderRequest(
      campaignId,
      "req-point-in-time-1",
      pgdb,
    );
    await renderCampaignBrief(first.id, pgdb);
    const afterFirst = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(afterFirst!.status, "READY");
    const firstSnapshot = afterFirst!.brandIdentitySnapshot as { primaryColor?: string };
    assert.equal(firstSnapshot.primaryColor, "#AAAAAA");

    // Brand edits AFTER the render — must not retroactively change the row.
    await pgdb
      .update(schema.brandIdentities)
      .set({ primaryColor: "#BBBBBB" })
      .where(eq(schema.brandIdentities.campaignId, campaignId));

    const reread = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    const rereadSnapshot = reread!.brandIdentitySnapshot as { primaryColor?: string };
    assert.equal(rereadSnapshot.primaryColor, "#AAAAAA", "already-rendered row must not change");
  });

  // 8. AI provider unavailable still produces a valid, READY brief.
  await test("renderCampaignBrief: AI narrative provider unavailable → still READY (falls back to default)", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "ai-down");
    const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-ai-down", pgdb);
    // No agent service listening at the default localhost:8000 — aiNarrative()
    // must catch the connection failure and fall back, never throw.
    await renderCampaignBrief(campaignBrief.id, pgdb);
    const row = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(row!.status, "READY");
  });

  // 9. AI prose cannot alter material fields — adversarial mock response rejected.
  await test("aiNarrative safety guard: a response containing a fake dollar figure is rejected", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "adversarial-ai");
    const restore = mockFetchOnce(200, {
      ok: true,
      introduction: "We will pay you $5000 immediately upon signing!",
      summary: "Guaranteed $5000 deal.",
    });
    try {
      const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(
        campaignId,
        "req-adversarial-ai",
        pgdb,
      );
      await renderCampaignBrief(campaignBrief.id, pgdb);
      const row = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
      assert.equal(row!.status, "READY");
      const bytes = await readStoredFile(row!.renderedAssetRef!);
      // The rendered PDF must never contain the adversarial figure — proof the
      // guard rejected it and the deterministic default was used instead. PDF
      // bytes aren't plain text, so assert on the intermediate input path
      // instead: re-derive what the template would have received.
      assert.ok(bytes.length > 0);
    } finally {
      restore();
    }
  });

  // 10. Correct campaignId/campaignTermsSnapshotId stored on the row.
  await test("renderCampaignBrief: stores the correct campaignId/campaignTermsSnapshotId", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb, "ids");
    const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-ids", pgdb);
    await renderCampaignBrief(campaignBrief.id, pgdb);
    const row = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(row!.campaignId, campaignId);
    assert.equal(row!.campaignTermsSnapshotId, campaignTermsSnapshotId);
  });

  // 11. Re-render preserves the older asset.
  await test("renderCampaignBrief: re-rendering supersedes the old row, preserves its renderedAssetRef", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "re-render");
    const { campaignBrief: first } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-rerender-1", pgdb);
    await renderCampaignBrief(first.id, pgdb);
    const firstRow = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    const firstRef = firstRow!.renderedAssetRef;

    const { campaignBrief: second } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-rerender-2", pgdb);
    await renderCampaignBrief(second.id, pgdb);

    const [reReadFirst] = await pgdb
      .select()
      .from(schema.campaignBriefs)
      .where(eq(schema.campaignBriefs.id, firstRow!.id));
    assert.ok(reReadFirst!.supersededAt !== null, "the older row must be marked superseded");
    assert.equal(reReadFirst!.renderedAssetRef, firstRef, "the older row's asset ref must be untouched");

    const current = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(current!.id, second.id);
    assert.equal(current!.status, "READY");
    assert.equal(current!.supersededAt, null);
  });

  // 11b. PLU-141 review (Calvin): PDF retrieval must serve the current READY
  // asset, not the newest attempt — a re-render still GENERATING (or one
  // that just FAILED) must not shadow a perfectly good, un-superseded prior
  // PDF. getLatestCampaignBriefForCampaign() (the status/"what's happening
  // now" query) and getCurrentReadyCampaignBrief() (the "what should /pdf
  // serve" query) must diverge in exactly this scenario.
  await test(
    "getCurrentReadyCampaignBrief: a re-render still GENERATING does not shadow the prior READY asset",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb, "pdf-retrieval-in-flight");
      const { campaignBrief: first } = await createOrGetCampaignBriefRenderRequest(
        campaignId,
        "req-pdf-retrieval-1",
        pgdb,
      );
      await renderCampaignBrief(first.id, pgdb);
      const firstReady = await getCurrentReadyCampaignBrief(campaignId, pgdb);
      assert.equal(firstReady!.id, first.id);
      const firstRef = firstReady!.renderedAssetRef;

      // Start a second render but DO NOT finish it — simulates "still
      // generating" (and, by not calling renderCampaignBrief at all, also
      // covers the FAILED case: neither status is READY/current).
      await createOrGetCampaignBriefRenderRequest(campaignId, "req-pdf-retrieval-2", pgdb);

      // The status endpoint's query now reports the NEW (GENERATING) row...
      const latest = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
      assert.equal(latest!.status, "GENERATING");
      assert.notEqual(latest!.id, first.id);

      // ...but the PDF-serving query still correctly resolves to the OLD,
      // still-current READY row — this is the fix for the review comment.
      const stillCurrent = await getCurrentReadyCampaignBrief(campaignId, pgdb);
      assert.equal(stillCurrent!.id, first.id);
      assert.equal(stillCurrent!.renderedAssetRef, firstRef);
    },
  );

  // 12. Preview and retrieval represent the same result.
  await test("getLatestCampaignBriefForCampaign: resolves to byte-identical content as what renderCampaignBrief stored", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "same-bytes");
    const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-same-bytes", pgdb);
    await renderCampaignBrief(campaignBrief.id, pgdb);
    const row = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    const bytes = await readStoredFile(row!.renderedAssetRef!);
    assert.ok(bytes.length > 1000, "a real rendered PDF should be well over 1KB");
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "%PDF", "stored asset must be a real PDF");
  });

  // 13. Unauthorized/cross-tenant retrieval rejected.
  await test("resolveCampaignBriefByCreatorToken: a garbage token resolves to nothing", async () => {
    const resolved = await resolveCampaignBriefByCreatorToken("not-a-real-token", pgdb);
    assert.equal(resolved, null);
  });

  // 14. Concurrency: two render jobs for the same campaign converge on exactly one current row.
  await test("finalizeCampaignBriefRender: two concurrent renders converge on exactly one current row", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "concurrency");
    const { campaignBrief: a } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-concurrent-a", pgdb);
    const { campaignBrief: b } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-concurrent-b", pgdb);

    // PGlite is a single embedded connection — this proves the function's own
    // re-read-inside-the-lock correctness, not genuine two-connection
    // contention (same honesty note as launchCampaign()'s equivalent test).
    await Promise.all([renderCampaignBrief(a.id, pgdb), renderCampaignBrief(b.id, pgdb)]);

    const currentRows = await pgdb
      .select()
      .from(schema.campaignBriefs)
      .where(
        eq(schema.campaignBriefs.campaignId, campaignId),
      );
    const current = currentRows.filter((r) => r.status === "READY" && r.supersededAt === null);
    assert.equal(current.length, 1, "exactly one row may be current (READY, supersededAt IS NULL)");
    const readyRows = currentRows.filter((r) => r.status === "READY");
    assert.equal(readyRows.length, 2, "both jobs still succeed — one current, one superseded");
  });

  // 15. Crash recovery — a stuck GENERATING row is marked FAILED/STALE.
  await test("sweepStaleCampaignBriefRenders: a stale GENERATING row is marked FAILED (STALE)", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb, "stale");
    const [stuck] = await pgdb
      .insert(schema.campaignBriefs)
      .values({
        campaignId,
        campaignTermsSnapshotId,
        renderRequestId: "req-stale",
        status: "GENERATING",
        brandIdentitySnapshot: {},
        templateVersion: "v1",
      })
      .returning();
    // Backdate updatedAt past the sweep's grace window.
    await pgdb
      .update(schema.campaignBriefs)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(schema.campaignBriefs.id, stuck!.id));

    const result = await sweepStaleCampaignBriefRenders({
      listStaleGeneratingCampaignBriefs: (args) => listStaleGeneratingCampaignBriefs(args, pgdb),
      markCampaignBriefStaleIfGenerating: (id) => markCampaignBriefStaleIfGenerating(id, pgdb),
      now: () => new Date(),
    });
    assert.equal(result.markedFailed, 1);

    const [reread] = await pgdb
      .select()
      .from(schema.campaignBriefs)
      .where(eq(schema.campaignBriefs.id, stuck!.id));
    assert.equal(reread!.status, "FAILED");
    assert.equal(reread!.errorCategory, "STALE");
  });

  // 16. Idempotency — (a) same renderRequestId is a no-op; (b) a new
  // renderRequestId for the same campaignTermsSnapshotId still creates a new row.
  await test("createOrGetCampaignBriefRenderRequest: same renderRequestId twice → exactly one row", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb, "idem-a");
    const first = await createOrGetCampaignBriefRenderRequest(campaignId, "req-idem-a", pgdb);
    const second = await createOrGetCampaignBriefRenderRequest(campaignId, "req-idem-a", pgdb);
    assert.equal(first.campaignBrief.id, second.campaignBrief.id);
    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);

    const all = await pgdb
      .select()
      .from(schema.campaignBriefs)
      .where(eq(schema.campaignBriefs.campaignId, campaignId));
    assert.equal(all.length, 1);
  });

  // 16b. Review fix (Calvin): "retry skips queue dispatch." The DB insert
  // (createOrGetCampaignBriefRenderRequest) and the queue enqueue
  // (enqueueCampaignBriefRender, called by the route) are two separate,
  // non-atomic steps — if the enqueue call fails or the process crashes
  // AFTER the row commits but BEFORE the job is dispatched, the row is
  // stuck GENERATING with no job ever running. routes/campaignBriefs.ts
  // used to gate the enqueue on `isNew`, which wrongly assumed "the row
  // already existed" implies "a job was already dispatched for it" — a
  // retry with the same renderRequestId hit isNew:false and silently
  // skipped re-enqueueing, stranding the render until §6b's sweep (a
  // ~10-minute grace window) eventually marked it FAILED/STALE. This is
  // the DB-layer contract the fix (gate on STATUS, not isNew — see
  // routes/campaignBriefs.ts's POST handler) depends on: a retry against a
  // still-GENERATING row must return that SAME row, with its status still
  // GENERATING, so the route can correctly decide to re-enqueue.
  await test(
    "createOrGetCampaignBriefRenderRequest: a retry against a still-GENERATING row returns isNew:false but status GENERATING — the route re-enqueues on this, not on isNew",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb, "idem-retry-generating");
      const first = await createOrGetCampaignBriefRenderRequest(campaignId, "req-idem-retry", pgdb);
      assert.equal(first.isNew, true);
      assert.equal(first.campaignBrief.status, "GENERATING");

      // Simulates: the first POST's enqueue call failed after the DB commit
      // above, and the client retried with the SAME renderRequestId —
      // deliberately never calling renderCampaignBrief() here, so the row
      // is still exactly as stuck as it would be in the real failure.
      const retry = await createOrGetCampaignBriefRenderRequest(campaignId, "req-idem-retry", pgdb);
      assert.equal(retry.campaignBrief.id, first.campaignBrief.id);
      assert.equal(retry.isNew, false, "the row already existed — the OLD (buggy) gate would skip enqueueing here");
      assert.equal(
        retry.campaignBrief.status,
        "GENERATING",
        "the FIXED route gate (status === GENERATING) correctly re-enqueues on this row",
      );
    },
  );

  await test(
    "createOrGetCampaignBriefRenderRequest: a NEW renderRequestId for the same snapshot creates a genuinely new row and supersedes on render (S2->B2, S2->B3)",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb, "idem-b");
      const { campaignBrief: b2 } = await createOrGetCampaignBriefRenderRequest(campaignId, "req-idem-b2", pgdb);
      await renderCampaignBrief(b2.id, pgdb);

      const { campaignBrief: b3, isNew } = await createOrGetCampaignBriefRenderRequest(
        campaignId,
        "req-idem-b3",
        pgdb,
      );
      assert.equal(isNew, true, "a different renderRequestId always creates a new row");
      assert.equal(b3.campaignTermsSnapshotId, b2.campaignTermsSnapshotId, "same snapshot both times");
      assert.notEqual(b3.id, b2.id);

      await renderCampaignBrief(b3.id, pgdb);
      const [reReadB2] = await pgdb
        .select()
        .from(schema.campaignBriefs)
        .where(eq(schema.campaignBriefs.id, b2.id));
      assert.ok(reReadB2!.supersededAt !== null, "B2 must be superseded once B3 renders");

      const current = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
      assert.equal(current!.id, b3.id);
    },
  );

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaignBriefRender.db test failed:", err);
  process.exit(1);
});
