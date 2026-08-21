/**
 * PLU-172 — DB-backed tests for upsertCampaignDetailsValidated()'s
 * cross-field check against the stored NegotiationPolicy (review fix —
 * "This draft-locked write updates CampaignDetails without validating the
 * existing negotiation policy against the prospective public terms").
 *
 * This is the symmetric counterpart to negotiationPolicy.db.test.ts's
 * atomicity tests: THAT file proves a NegotiationPolicy patch lowering a
 * limit below an unchanged public offer is rejected; THIS file proves a
 * CampaignDetails patch raising the public offer above an unchanged limit
 * is rejected too — both directions of the same invariant, both going
 * through the same shared checkFeeCommissionConsistency comparison
 * (domain/negotiationPolicyValidation.ts).
 *
 * Run: npx tsx --test src/db/campaignDetails.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  upsertCampaignDetails,
  upsertCampaignDetailsValidated,
  CampaignDetailsValidationError,
} from "./campaignDetails.js";
import { upsertNegotiationPolicy } from "./negotiationPolicy.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  console.log("\ncampaignDetails.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  async function newCampaign(name: string): Promise<string> {
    const [campaign] = await pgdb.insert(schema.campaigns).values({ name, brand: "Acme" }).returning();
    return campaign!.id;
  }

  await test(
    "BUG (fixed) — reported scenario: raising the public fee above an already-approved private ceiling is rejected",
    async () => {
      const campaignId = await newCampaign("Details Validation 1");
      await upsertCampaignDetails(
        campaignId,
        { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 },
        pgdb,
      );
      await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 50000 }, pgdb);

      await assert.rejects(
        () => upsertCampaignDetailsValidated(campaignId, { publicStartingFeeCents: 60000 }, pgdb),
        (err: unknown) => {
          assert.ok(err instanceof CampaignDetailsValidationError);
          assert.equal(err.code, "FEE_LIMIT_BELOW_PUBLIC_OFFER");
          return true;
        },
      );

      const [row] = await pgdb
        .select()
        .from(schema.campaignDetails)
        .where(eq(schema.campaignDetails.campaignId, campaignId));
      assert.equal(row!.publicStartingFeeCents, 50000, "a rejected validated write must not persist ANY part of its patch");
    },
  );

  await test(
    "commission side: raising the public commission rate above an already-approved private ceiling is rejected",
    async () => {
      const campaignId = await newCampaign("Details Validation 2");
      await upsertCampaignDetails(campaignId, { commissionMode: "percent", publicCommissionRate: 0.1 }, pgdb);
      await upsertNegotiationPolicy(
        campaignId,
        { commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 0.1 },
        pgdb,
      );

      await assert.rejects(
        () => upsertCampaignDetailsValidated(campaignId, { publicCommissionRate: 0.2 }, pgdb),
        (err: unknown) => {
          assert.ok(err instanceof CampaignDetailsValidationError);
          assert.equal(err.code, "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION");
          return true;
        },
      );
    },
  );

  await test(
    "unit change: raising the public flat commission amount above an already-approved private ceiling is rejected",
    async () => {
      const campaignId = await newCampaign("Details Validation 3");
      await upsertCampaignDetails(campaignId, { commissionMode: "flat", publicCommissionRate: 500 }, pgdb);
      // Private policy authorizes ALLOW_WITHIN_LIMIT with an amount ceiling
      // set against the CURRENT flat public commission (500) — consistent
      // today.
      await upsertNegotiationPolicy(
        campaignId,
        { commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingAmountCents: 500 },
        pgdb,
      );

      // Now the public commission itself is raised past that stored flat
      // ceiling — same "unit changes" hazard the review calls out, just on
      // the amount side rather than the mode/percent side.
      await assert.rejects(
        () => upsertCampaignDetailsValidated(campaignId, { publicCommissionRate: 700 }, pgdb),
        (err: unknown) => {
          assert.ok(err instanceof CampaignDetailsValidationError);
          assert.equal(err.code, "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION");
          return true;
        },
      );
    },
  );

  await test("a fully valid raise (ceiling raised first, then the public fee) succeeds", async () => {
    const campaignId = await newCampaign("Details Validation 4");
    await upsertCampaignDetails(
      campaignId,
      { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 },
      pgdb,
    );
    await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 50000 }, pgdb);

    await upsertNegotiationPolicy(campaignId, { ceilingCents: 60000 }, pgdb);
    const details = await upsertCampaignDetailsValidated(campaignId, { publicStartingFeeCents: 60000 }, pgdb);
    assert.equal(details.publicStartingFeeCents, 60000);
  });

  await test(
    "an unrelated CampaignDetails field edit is never blocked by pre-existing invalid fee data it doesn't touch",
    async () => {
      const campaignId = await newCampaign("Details Validation 5");
      // Hand-seed an already-invalid combination directly (bypassing
      // validation via the plain unvalidated upsert) — simulates data that
      // predates this ticket's checks, or a policy set before the details
      // were finalized.
      await upsertCampaignDetails(
        campaignId,
        { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 },
        pgdb,
      );
      await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 1 }, pgdb);

      const details = await upsertCampaignDetailsValidated(campaignId, { keyMessages: "unrelated edit" }, pgdb);
      assert.equal(
        details.keyMessages,
        "unrelated edit",
        "an edit unrelated to fee/commission must succeed even if stored fee data is already invalid",
      );
    },
  );

  await test(
    "a fee-only edit is not blocked by pre-existing invalid COMMISSION data it doesn't touch (and vice versa)",
    async () => {
      const campaignId = await newCampaign("Details Validation 6");
      await upsertCampaignDetails(
        campaignId,
        {
          priceStrategy: "PROPOSE_STARTING_FEE",
          publicStartingFeeCents: 1000,
          commissionMode: "percent",
          publicCommissionRate: 0.5,
        },
        pgdb,
      );
      // Commission side is already invalid (ceiling below public rate);
      // fee side has no policy limit at all (mode not ALLOW_WITHIN_LIMIT).
      await upsertNegotiationPolicy(
        campaignId,
        { commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 0.1 },
        pgdb,
      );

      const details = await upsertCampaignDetailsValidated(campaignId, { publicStartingFeeCents: 2000 }, pgdb);
      assert.equal(
        details.publicStartingFeeCents,
        2000,
        "a fee-only edit must succeed even though stored commission data is already invalid",
      );
    },
  );

  await test("CampaignLockedError still fires for a validated write once the campaign is ACTIVE", async () => {
    const campaignId = await newCampaign("Details Validation 7");
    await upsertCampaignDetails(
      campaignId,
      { priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 1000 },
      pgdb,
    );
    await pgdb.update(schema.campaigns).set({ status: "ACTIVE" }).where(eq(schema.campaigns.id, campaignId));

    await assert.rejects(
      () => upsertCampaignDetailsValidated(campaignId, { publicStartingFeeCents: 2000 }, pgdb),
      (err: unknown) => {
        assert.equal((err as Error).name, "CampaignLockedError");
        return true;
      },
    );
  });

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaignDetails.db test failed:", err);
  process.exit(1);
});
