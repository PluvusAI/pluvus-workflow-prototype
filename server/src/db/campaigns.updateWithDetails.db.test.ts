/**
 * PLU-172 — DB-backed tests for updateCampaignWithDetails() (review fix —
 * "a request that changes campaign fields and public terms can return a
 * validation error after updateCampaign() has already committed the
 * campaign patch").
 *
 * Before this fix, `PATCH /campaigns/:id` called updateCampaign() (Campaign
 * table) and upsertCampaignDetailsValidated() (CampaignDetails, validated
 * against the stored NegotiationPolicy) as two separate statements: a name
 * change bundled with a public-fee raise above an already-approved private
 * ceiling committed the name change, THEN rejected the fee change, leaving
 * a partial update with no way for the client to tell from the 400 response
 * that part of its request had already taken effect.
 *
 * updateCampaignWithDetails() wraps both writes in one transaction, so a
 * validation failure on the CampaignDetails half rolls back the Campaign
 * half too — verified here directly against the real schema (PGlite).
 *
 * Run: npx tsx --test src/db/campaigns.updateWithDetails.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { updateCampaignWithDetails, findCampaignById } from "./campaigns.js";
import { upsertCampaignDetails, CampaignDetailsValidationError } from "./campaignDetails.js";
import { upsertNegotiationPolicy } from "./negotiationPolicy.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  console.log("\ncampaigns.updateWithDetails.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  async function newCampaign(name: string): Promise<string> {
    const [campaign] = await pgdb.insert(schema.campaigns).values({ name, brand: "Acme" }).returning();
    return campaign!.id;
  }

  await test(
    "BUG (fixed) — reported scenario: a name change bundled with an over-limit fee raise rolls back BOTH, not just the fee",
    async () => {
      const campaignId = await newCampaign("Original Name");
      await upsertCampaignDetails(
        campaignId,
        { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 },
        pgdb,
      );
      await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 50000 }, pgdb);

      const existing = (await findCampaignById(campaignId, pgdb))!;
      await assert.rejects(
        () =>
          updateCampaignWithDetails(
            campaignId,
            { name: "Renamed" },
            { publicStartingFeeCents: 60000 },
            existing,
            pgdb,
          ),
        (err: unknown) => {
          assert.ok(err instanceof CampaignDetailsValidationError);
          assert.equal(err.code, "FEE_LIMIT_BELOW_PUBLIC_OFFER");
          return true;
        },
      );

      const [campaignRow] = await pgdb.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      assert.equal(campaignRow!.name, "Original Name", "the name change must be rolled back alongside the rejected fee change");

      const [detailsRow] = await pgdb
        .select()
        .from(schema.campaignDetails)
        .where(eq(schema.campaignDetails.campaignId, campaignId));
      assert.equal(detailsRow!.publicStartingFeeCents, 50000, "the fee change must not persist either");
    },
  );

  await test("a fully valid bundled update (name + a consistent fee raise) commits both together", async () => {
    const campaignId = await newCampaign("Original Name 2");
    await upsertCampaignDetails(
      campaignId,
      { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 },
      pgdb,
    );
    await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 70000 }, pgdb);

    const existing = (await findCampaignById(campaignId, pgdb))!;
    const { campaign, details } = await updateCampaignWithDetails(
      campaignId,
      { name: "Renamed 2" },
      { publicStartingFeeCents: 60000 },
      existing,
      pgdb,
    );
    assert.equal(campaign.name, "Renamed 2");
    assert.equal(details!.publicStartingFeeCents, 60000);
  });

  await test("a campaign-only patch (no details touched) is unaffected — no transaction needed, no regression", async () => {
    const campaignId = await newCampaign("Original Name 3");
    const existing = (await findCampaignById(campaignId, pgdb))!;
    const { campaign, details } = await updateCampaignWithDetails(campaignId, { name: "Renamed 3" }, {}, existing, pgdb);
    assert.equal(campaign.name, "Renamed 3");
    assert.equal(details, null);
  });

  await test("a details-only patch (no campaign fields touched) still validates against the policy", async () => {
    const campaignId = await newCampaign("Original Name 4");
    await upsertCampaignDetails(
      campaignId,
      { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 },
      pgdb,
    );
    await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 50000 }, pgdb);

    const existing = (await findCampaignById(campaignId, pgdb))!;
    await assert.rejects(
      () => updateCampaignWithDetails(campaignId, {}, { publicStartingFeeCents: 60000 }, existing, pgdb),
      (err: unknown) => {
        assert.ok(err instanceof CampaignDetailsValidationError);
        return true;
      },
    );
    const [campaignRow] = await pgdb.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    assert.equal(campaignRow!.name, "Original Name 4", "unchanged — this request never touched the campaign row");
  });

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaigns.updateWithDetails.db test failed:", err);
  process.exit(1);
});
