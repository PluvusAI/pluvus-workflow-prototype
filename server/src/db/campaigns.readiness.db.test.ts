/**
 * DB-backed tests for the PLU-140 (2b) readiness projection — computeReadiness()
 * and the GET /campaigns/:id/readiness shape it returns. Runs against a real
 * embedded Postgres (PGlite) with every migration applied, and reads details/
 * policy through the SAME db functions the route uses (getCampaignDetails /
 * getNegotiationPolicy).
 *
 * The whole point of this endpoint is that it can never say ready:true while
 * POST /launch would fail — so the key assertions are PARITY with the real
 * launchCampaign():
 *   ready === true   ⟺ launchCampaign succeeds
 *   ready === false  ⟺ launchCampaign throws a precondition error
 *
 * Run:  npx tsx --test src/db/campaigns.readiness.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { computeReadiness, launchCampaign } from "./campaigns.js";
import { getCampaignDetails } from "./campaignDetails.js";
import { getNegotiationPolicy } from "./negotiationPolicy.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Review fix: launch/readiness now requires a non-empty structured
// deliverables list regardless of campaignType — default one here so this
// file's fixtures (all about compensation-field completeness, not
// deliverables) keep matching launchCampaign()'s real behavior. A test that
// wants to exercise the deliverables gate itself overrides via `details`.
const DEFAULT_DELIVERABLES = [{ id: "del_default", platform: "instagram", format: "reel", quantity: 1 }];

async function seedCampaign(
  pgdb: Db,
  suffix: string,
  details: Partial<schema.CampaignDetailsInsert> | null,
  policy: Partial<schema.NegotiationPolicyInsert> | null,
): Promise<string> {
  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `Readiness Test ${suffix}`, brand: "Acme" })
    .returning();
  if (details !== null) {
    await pgdb.insert(schema.campaignDetails).values({
      campaignId: campaign!.id,
      compensationReviewStatus: "CONFIRMED",
      deliverableQuantities: DEFAULT_DELIVERABLES,
      ...details,
    });
  }
  if (policy !== null) {
    await pgdb.insert(schema.negotiationPolicies).values({ campaignId: campaign!.id, ...policy });
  }
  return campaign!.id;
}

/** Read details+policy exactly as the route does, then compute readiness. */
async function readiness(pgdb: Db, id: string) {
  const details = await getCampaignDetails(id, pgdb);
  const policy = await getNegotiationPolicy(id, pgdb);
  return computeReadiness(details, policy);
}

/** True iff the real launchCampaign() would succeed for this campaign. */
async function launchSucceeds(pgdb: Db, id: string): Promise<boolean> {
  try {
    await launchCampaign(id, pgdb);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("\ncampaigns.readiness.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  await test("shape: a complete PAID draft is ready with no blockers, all flags true", async () => {
    const id = await seedCampaign(
      pgdb,
      "complete-paid",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD" },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const r = await readiness(pgdb, id);
    assert.deepEqual(r, {
      ready: true,
      blockers: [],
      reviewConfirmed: true,
      hasPolicy: true,
      hasDetails: true,
    });
    // Parity: launch actually succeeds.
    assert.equal(await launchSucceeds(pgdb, id), true, "ready:true ⟺ launch succeeds");
  });

  await test("an incomplete PAID draft (no fee authority) is not ready, and the blocker names it", async () => {
    // PROPOSE_STARTING_FEE with no publicStartingFeeCents AND no fee bounds →
    // two blockers, ready:false. reviewConfirmed still true (it IS confirmed).
    const id = await seedCampaign(
      pgdb,
      "incomplete-paid",
      { campaignType: "PAID", priceStrategy: "PROPOSE_STARTING_FEE" },
      {}, // policy row exists but has no fee bounds / non-negotiable marker
    );
    const r = await readiness(pgdb, id);
    assert.equal(r.ready, false);
    assert.equal(r.hasDetails, true);
    assert.equal(r.hasPolicy, true);
    assert.equal(r.reviewConfirmed, true);
    assert.ok(
      r.blockers.some((b) => b.includes("publicStartingFeeCents")),
      "missing starting fee is surfaced",
    );
    assert.ok(r.blockers.some((b) => b.includes("fee bounds")), "missing fee authority is surfaced");
    // Parity: launch fails.
    assert.equal(await launchSucceeds(pgdb, id), false, "ready:false ⟺ launch fails");
  });

  await test("missing NegotiationPolicy → not ready, hasPolicy:false, policy blocker", async () => {
    const id = await seedCampaign(
      pgdb,
      "no-policy",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD" },
      null, // no policy row
    );
    const r = await readiness(pgdb, id);
    assert.equal(r.ready, false);
    assert.equal(r.hasPolicy, false);
    assert.equal(r.hasDetails, true);
    assert.ok(r.blockers.some((b) => b.includes("NegotiationPolicy is missing")));
    assert.equal(await launchSucceeds(pgdb, id), false);
  });

  await test("missing CampaignDetails → not ready, hasDetails:false, details blocker", async () => {
    const id = await seedCampaign(pgdb, "no-details", null, { floorCents: 1, ceilingCents: 2 });
    const r = await readiness(pgdb, id);
    assert.equal(r.ready, false);
    assert.equal(r.hasDetails, false);
    assert.ok(r.blockers.some((b) => b.includes("CampaignDetails row is missing")));
    assert.equal(await launchSucceeds(pgdb, id), false);
  });

  await test("NEEDS_REVIEW campaign with otherwise-complete fields → not ready (409 gate), review blocker", async () => {
    const id = await seedCampaign(
      pgdb,
      "needs-review",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD", compensationReviewStatus: "NEEDS_REVIEW" },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const r = await readiness(pgdb, id);
    assert.equal(r.ready, false);
    assert.equal(r.reviewConfirmed, false);
    assert.ok(r.blockers.some((b) => b.includes("review is not confirmed")));
    assert.equal(await launchSucceeds(pgdb, id), false);

    // Confirm it → now ready, and launch succeeds. Same fields, only the flag flips.
    await pgdb
      .update(schema.campaignDetails)
      .set({ compensationReviewStatus: "CONFIRMED" })
      .where(eq(schema.campaignDetails.campaignId, id));
    const r2 = await readiness(pgdb, id);
    assert.equal(r2.ready, true);
    assert.deepEqual(r2.blockers, []);
    assert.equal(await launchSucceeds(pgdb, id), true);
  });

  await test("AFFILIATE readiness is NOT blocked by absent fee bounds (structure-specific)", async () => {
    // A commission-only campaign with commission authority and NO fee bounds is
    // ready — the readiness check must not demand a fee it doesn't use.
    const id = await seedCampaign(
      pgdb,
      "affiliate",
      { campaignType: "AFFILIATE", publicCommissionRate: 15 },
      { commissionFloorRate: 10, commissionCeilingRate: 20 },
    );
    const r = await readiness(pgdb, id);
    assert.equal(r.ready, true, "no fee bounds required for AFFILIATE");
    assert.ok(
      !r.blockers.some((b) => b.toLowerCase().includes("fee")),
      "no fee blocker for a commission-only campaign",
    );
    assert.equal(await launchSucceeds(pgdb, id), true);
  });

  await test("empty deliverableQuantities → not ready, deliverables blocker, parity with launch", async () => {
    const id = await seedCampaign(
      pgdb,
      "empty-deliverables",
      { campaignType: "PAID", priceStrategy: "REQUEST_RATE_CARD", deliverableQuantities: [] },
      { floorCents: 10000, ceilingCents: 30000 },
    );
    const r = await readiness(pgdb, id);
    assert.equal(r.ready, false);
    assert.ok(r.blockers.some((b) => b.includes("deliverableQuantities")));
    assert.equal(await launchSucceeds(pgdb, id), false, "ready:false ⟺ launch fails");
  });

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaigns.readiness.db test failed:", err);
  process.exit(1);
});
