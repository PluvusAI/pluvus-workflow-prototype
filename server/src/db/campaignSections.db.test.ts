/**
 * PLU-139 (2a) — DB-backed tests for the BrandIdentity + CreatorRequirement
 * access modules against a REAL Postgres (PGlite, embedded) with every migration
 * applied verbatim, so the tables/enums/unique indexes are byte-identical to a
 * real deploy. The schema itself is PLU-135's; this covers the 2a wiring:
 * get / upsert-on-unique-campaignId, jsonb string[] lists, and the draft-only
 * lock (CampaignLockedError once the campaign is ACTIVE) reused from campaignDetails.
 *
 * Run:  node --import tsx --test src/db/campaignSections.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  CampaignLockedError,
  upsertCampaignDetails,
  getCampaignDetails,
} from "./campaignDetails.js";
import {
  getBrandIdentity,
  getBrandIdentitiesByCampaignIds,
  upsertBrandIdentity,
} from "./brandIdentity.js";
import {
  getCreatorRequirement,
  getCreatorRequirementsByCampaignIds,
  upsertCreatorRequirement,
} from "./creatorRequirement.js";
import {
  insertBriefExtraction,
  getLatestBriefExtraction,
} from "./campaignBriefExtraction.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

let seedN = 0;
/** Seed a campaign at the given status; returns its id. */
async function seedCampaign(
  pgdb: Db,
  status: "DRAFT" | "ACTIVE" = "DRAFT",
): Promise<string> {
  const [c] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `C ${seedN}`, brand: `B ${seedN++}`, status })
    .returning();
  return c!.id;
}

async function main(): Promise<void> {
  console.log("\ncampaignSections.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── BrandIdentity ────────────────────────────────────────────────────────────
  await test("brandIdentity upsert inserts then updates the SAME row (1:1)", async () => {
    const id = await seedCampaign(pgdb);
    const b = await upsertBrandIdentity(
      id,
      { logoRef: "logo-123", primaryColor: "#123456" },
      pgdb,
    );
    assert.equal(b.logoRef, "logo-123");
    assert.equal(b.primaryColor, "#123456");
    // Second upsert patches, doesn't duplicate (onConflictDoUpdate on campaignId).
    const b2 = await upsertBrandIdentity(id, { typography: "Inter" }, pgdb);
    assert.equal(b2.id, b.id, "same row");
    assert.equal(b2.typography, "Inter");
    // onConflict set only carries the patch, so an un-patched column is untouched.
    assert.equal(b2.logoRef, "logo-123", "prior value preserved");
    const round = await getBrandIdentity(id, pgdb);
    assert.equal(round?.id, b.id);
  });

  await test("getBrandIdentitiesByCampaignIds batches (no N+1)", async () => {
    const a = await seedCampaign(pgdb);
    const b = await seedCampaign(pgdb);
    await upsertBrandIdentity(a, { primaryColor: "#aaa" }, pgdb);
    await upsertBrandIdentity(b, { primaryColor: "#bbb" }, pgdb);
    const map = await getBrandIdentitiesByCampaignIds([a, b, "missing"], pgdb);
    assert.equal(map.get(a)?.primaryColor, "#aaa");
    assert.equal(map.get(b)?.primaryColor, "#bbb");
    assert.equal(map.has("missing"), false);
  });

  // ── CreatorRequirement (informational; jsonb string[] lists) ──────────────────
  await test("creatorRequirement upsert + get with jsonb string[] lists", async () => {
    const id = await seedCampaign(pgdb);
    const r = await upsertCreatorRequirement(
      id,
      {
        platforms: ["youtube", "instagram"],
        geography: ["US", "CA"],
        minFollowers: 10000,
      },
      pgdb,
    );
    assert.deepEqual(r.platforms, ["youtube", "instagram"]);
    assert.deepEqual(r.geography, ["US", "CA"]);
    assert.equal(r.minFollowers, 10000);
    const round = await getCreatorRequirement(id, pgdb);
    assert.deepEqual(round?.platforms, ["youtube", "instagram"]);
    assert.deepEqual(round?.geography, ["US", "CA"]);
  });

  await test("getCreatorRequirementsByCampaignIds batches", async () => {
    const a = await seedCampaign(pgdb);
    await upsertCreatorRequirement(a, { minFollowers: 25000 }, pgdb);
    const map = await getCreatorRequirementsByCampaignIds([a], pgdb);
    assert.equal(map.get(a)?.minFollowers, 25000);
  });

  // ── Draft-only lock (reused guard) ────────────────────────────────────────────
  await test("upsertBrandIdentity throws CampaignLockedError once ACTIVE", async () => {
    const id = await seedCampaign(pgdb, "ACTIVE");
    await assert.rejects(
      () => upsertBrandIdentity(id, { logoRef: "x" }, pgdb),
      CampaignLockedError,
    );
    assert.equal(await getBrandIdentity(id, pgdb), null, "no row written");
  });

  await test("upsertCreatorRequirement throws CampaignLockedError once ACTIVE", async () => {
    const id = await seedCampaign(pgdb, "ACTIVE");
    await assert.rejects(
      () => upsertCreatorRequirement(id, { platforms: ["x"] }, pgdb),
      CampaignLockedError,
    );
    assert.equal(await getCreatorRequirement(id, pgdb), null, "no row written");
  });

  await test("both upserts SUCCEED on a DRAFT campaign", async () => {
    const id = await seedCampaign(pgdb, "DRAFT");
    await upsertBrandIdentity(id, { logoRef: "ok" }, pgdb);
    await upsertCreatorRequirement(id, { minFollowers: 5000 }, pgdb);
    assert.equal((await getBrandIdentity(id, pgdb))?.logoRef, "ok");
    assert.equal((await getCreatorRequirement(id, pgdb))?.minFollowers, 5000);
  });

  // ── previously-unreachable CampaignDetails columns now editable (PLU-139 2a) ──
  // publicPaymentTerms / attributionWindow / keyMessages existed as columns but no
  // PATCH wrote them, so the sectioned intake could never edit them. Prove they
  // round-trip through the upsert the route now delegates to.
  await test("upsertCampaignDetails persists the previously-unreachable content columns", async () => {
    const id = await seedCampaign(pgdb);
    await upsertCampaignDetails(
      id,
      {
        publicPaymentTerms: "50% upfront / 50% after",
        attributionWindow: "30 days",
        keyMessages: "Lightest shoe under $120",
        contentRequirements: "Add captions; product in first 3s",
      },
      pgdb,
    );
    const d = await getCampaignDetails(id, pgdb);
    assert.equal(d?.publicPaymentTerms, "50% upfront / 50% after");
    assert.equal(d?.attributionWindow, "30 days");
    assert.equal(d?.keyMessages, "Lightest shoe under $120");
    assert.equal(d?.contentRequirements, "Add captions; product in first 3s");
  });

  // ── the ~18 worksheet Stage-1 columns (PLU-139) round-trip incl. jsonb list ──
  await test("upsertCampaignDetails persists the worksheet Stage-1 columns", async () => {
    const id = await seedCampaign(pgdb);
    await upsertCampaignDetails(
      id,
      {
        productName: "Cloudstride 2",
        productType: "Running shoes",
        creatorAccessNeeded: true,
        uniqueSellingPoints: "Lightest in class",
        whyTrust: "10 years in market",
        howToUse: "Lace up and run",
        brandAssets: "https://drive.example/assets",
        brandMaterialsRef: "upload-ref-1",
        deliverableQuantities: [
          { platform: "instagram", format: "reel", quantity: 3 },
          { platform: "youtube", format: "integration", quantity: 1 },
        ] as unknown as (typeof schema.campaignDetails.$inferInsert)["deliverableQuantities"],
        deliverablePricing: {
          "instagram:reel": 50000,
          "youtube:integration": 120000,
        } as unknown as (typeof schema.campaignDetails.$inferInsert)["deliverablePricing"],
        followerRanges: {
          instagram: { min: 1500, max: null },
          youtube: { min: 400, max: 400000 },
        } as unknown as (typeof schema.campaignDetails.$inferInsert)["followerRanges"],
        commissionMode: "percent",
        briefDeliveryMethod: "pluvus_builder",
        briefHighlight: "Feature the product in the first 3s",
        creativeConcept: "Warm, handheld, day-in-the-life",
        referenceVideos: "https://tiktok.com/@a/1\nhttps://tiktok.com/@b/2",
        scriptSubmission: "require",
        adAuthorization: "30 days",
        linkInBioDuration: "30 days",
        postRetention: "90 days",
        instagramCollab: true,
        requireApproval: true,
        variableCommission: "20% then 10%",
        giftDeliveryMethod: "promo_code",
        promoCode: "CREATOR30",
        requiresShippingInfo: true,
        affiliateTrackingUrl: "https://example.com/shop",
        trackingLinkMode: "pluvus",
        trackingDestinationUrl: "https://example.com/landing",
        trackingParameter: "_from",
      },
      pgdb,
    );
    const d = await getCampaignDetails(id, pgdb);
    assert.equal(d?.productName, "Cloudstride 2");
    assert.equal(d?.productType, "Running shoes");
    assert.equal(d?.briefHighlight, "Feature the product in the first 3s");
    assert.equal(d?.creativeConcept, "Warm, handheld, day-in-the-life");
    assert.equal(d?.scriptSubmission, "require");
    assert.equal(d?.adAuthorization, "30 days");
    assert.equal(d?.commissionMode, "percent");
    assert.deepEqual(d?.deliverablePricing, {
      "instagram:reel": 50000,
      "youtube:integration": 120000,
    });
    assert.deepEqual(d?.followerRanges, {
      instagram: { min: 1500, max: null },
      youtube: { min: 400, max: 400000 },
    });
    assert.equal(d?.creatorAccessNeeded, true);
    assert.equal(d?.instagramCollab, true);
    assert.equal(d?.requireApproval, true);
    assert.equal(d?.giftDeliveryMethod, "promo_code");
    assert.equal(d?.promoCode, "CREATOR30");
    assert.equal(d?.trackingParameter, "_from");
    // jsonb list round-trips structurally.
    const dq = d?.deliverableQuantities as Array<{ platform: string; quantity: number }> | null;
    assert.equal(Array.isArray(dq), true);
    assert.equal(dq?.[0]?.platform, "instagram");
    assert.equal(dq?.[0]?.quantity, 3);
    assert.equal(dq?.length, 2);
  });

  // ── draft-lock atomicity (Greptile P1) ───────────────────────────────────────
  // The upsert reads status with SELECT ... FOR UPDATE inside its own tx, so a
  // status flip committed BEFORE the upsert runs is observed → CampaignLockedError.
  // (A true concurrent interleave can't be forced on PGlite's single connection;
  // this proves the guard re-reads the row under lock rather than trusting a
  // stale read, which is the property that closes the race with launchCampaign.)
  await test("upsert re-reads status under lock: a just-committed ACTIVE is seen", async () => {
    const id = await seedCampaign(pgdb, "DRAFT");
    await upsertBrandIdentity(id, { logoRef: "before" }, pgdb); // fine while DRAFT
    // Commit the launch flip, THEN upsert — the FOR UPDATE read must see ACTIVE.
    await pgdb
      .update(schema.campaigns)
      .set({ status: "ACTIVE" })
      .where(eq(schema.campaigns.id, id));
    await assert.rejects(
      () => upsertBrandIdentity(id, { logoRef: "after" }, pgdb),
      CampaignLockedError,
    );
    // The blocked write did not land.
    assert.equal((await getBrandIdentity(id, pgdb))?.logoRef, "before");
  });

  await test("withDraftLock composes inside a caller transaction (nested savepoint)", async () => {
    const id = await seedCampaign(pgdb, "DRAFT");
    await pgdb.transaction(async (tx) => {
      await upsertCreatorRequirement(id, { minFollowers: 42 }, tx as unknown as Db);
    });
    assert.equal((await getCreatorRequirement(id, pgdb))?.minFollowers, 42);
  });

  // ── cascade: deleting the campaign clears both rows ───────────────────────────
  await test("ON DELETE CASCADE removes both section rows with the campaign", async () => {
    const id = await seedCampaign(pgdb);
    await upsertBrandIdentity(id, { logoRef: "y" }, pgdb);
    await upsertCreatorRequirement(id, { platforms: ["y"] }, pgdb);
    await pgdb.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
    assert.equal(await getBrandIdentity(id, pgdb), null);
    assert.equal(await getCreatorRequirement(id, pgdb), null);
  });

  // ── CampaignBriefExtraction (append-only import evidence, PLU-139) ────────────
  await test("brief extraction: insert is append-only and getLatest returns newest", async () => {
    const id = await seedCampaign(pgdb);
    assert.equal(await getLatestBriefExtraction(id, pgdb), null, "none before upload");
    const first = await insertBriefExtraction(
      id,
      {
        flatText: "first brief text",
        sections: { usageRights: { text: "90 days paid" } },
        sourceFileReference: "ref-1",
        parserVersion: "brief-parser-v1.1",
      },
      pgdb,
    );
    const second = await insertBriefExtraction(
      id,
      {
        flatText: "second brief text",
        sections: { paymentTerms: { text: "net 30" } },
        sourceFileReference: "ref-2",
        parserVersion: "brief-parser-v1.1",
      },
      pgdb,
    );
    assert.notEqual(first.id, second.id, "each upload is a NEW row (append-only)");
    const latest = await getLatestBriefExtraction(id, pgdb);
    assert.equal(latest?.id, second.id, "latest is the most recent insert");
    assert.equal(latest?.sourceFileReference, "ref-2");
  });

  await test("brief extraction is draft-locked: rejected once campaign is ACTIVE", async () => {
    const id = await seedCampaign(pgdb, "DRAFT");
    await insertBriefExtraction(
      id,
      { flatText: "t", sections: {}, sourceFileReference: "r", parserVersion: "v" },
      pgdb,
    );
    await pgdb
      .update(schema.campaigns)
      .set({ status: "ACTIVE" })
      .where(eq(schema.campaigns.id, id));
    await assert.rejects(
      () =>
        insertBriefExtraction(
          id,
          { flatText: "t2", sections: {}, sourceFileReference: "r2", parserVersion: "v" },
          pgdb,
        ),
      CampaignLockedError,
    );
  });

  console.log(`\n✓ campaignSections.db: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
