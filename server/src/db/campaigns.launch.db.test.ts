/**
 * DB-backed tests for launchCampaign() (PLU-135 / 1a) — the Draft → Active
 * transition. Runs against a REAL Postgres (PGlite, embedded) with the REAL
 * schema (every migration applied verbatim, including the 1a campaign-schema
 * migration), so the new tables/constraints/FKs are byte-identical to what a
 * real deploy would have.
 *
 * Scope, deliberately minimal (code review, Ayush, 2026-08-09): this proves
 * the happy path the schema change actually shipped — launch once, launch
 * again is a no-op, and the post-launch lock fires. It is NOT the fuller
 * concurrency/duplication/idempotency-under-load suite (two racing launch
 * calls, campaign duplication, etc.) — that belongs to Issue 1b, which owns
 * the rest of the launch lifecycle. Before this file, launchCampaign() and
 * POST /campaigns/:id/launch had exactly one caller in the whole codebase
 * (the route itself) and zero test coverage.
 *
 * Run:  npx tsx --test src/db/campaigns.launch.db.test.ts   (or via npm test)
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { launchCampaign } from "./campaigns.js";
import { upsertCampaignDetails, CampaignLockedError } from "./campaignDetails.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

/**
 * Seed a DRAFT campaign with a CampaignDetails row (required — launchCampaign
 * treats an absent one as a data-integrity bug) and a NegotiationPolicy row
 * (required by the §2.3 launch guard). Returns the campaign id.
 */
async function seedLaunchableCampaign(pgdb: Db, suffix: string): Promise<string> {
  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `Launch Test ${suffix}`, brand: "Acme" })
    .returning();
  await pgdb.insert(schema.campaignDetails).values({
    campaignId: campaign!.id,
    objective: "Drive signups",
    deliverables: "1 IG Reel",
    usageRights: "90-day paid social",
  });
  await pgdb.insert(schema.negotiationPolicies).values({
    campaignId: campaign!.id,
    floorCents: 20000,
    ceilingCents: 50000,
    maxRounds: 3,
  });
  return campaign!.id;
}

async function main(): Promise<void> {
  console.log("\ncampaigns.launch.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  await test(
    "launchCampaign creates exactly one CampaignTermsSnapshot + one NegotiationPolicySnapshot, writes LAUNCHED + SNAPSHOT_CREATED audit events, and flips status to ACTIVE",
    async () => {
      const campaignId = await seedLaunchableCampaign(pgdb, "happy");

      const snapshot = await launchCampaign(campaignId, pgdb);
      assert.equal(snapshot.campaignId, campaignId);
      assert.equal(
        (snapshot.detailsSnapshot as Record<string, unknown>)["objective"],
        "Drive signups",
        "detailsSnapshot carries the confirmed CampaignDetails fields",
      );

      const termsSnapshots = await pgdb
        .select()
        .from(schema.campaignTermsSnapshots)
        .where(eq(schema.campaignTermsSnapshots.campaignId, campaignId));
      assert.equal(termsSnapshots.length, 1, "exactly one CampaignTermsSnapshot");
      assert.equal(termsSnapshots[0]!.id, snapshot.id);

      const policySnapshots = await pgdb
        .select()
        .from(schema.negotiationPolicySnapshots)
        .where(eq(schema.negotiationPolicySnapshots.campaignId, campaignId));
      assert.equal(policySnapshots.length, 1, "exactly one NegotiationPolicySnapshot");
      assert.equal(policySnapshots[0]!.floorCents, 20000);
      assert.equal(policySnapshots[0]!.ceilingCents, 50000);
      assert.equal(policySnapshots[0]!.maxRounds, 3);

      const [campaignRow] = await pgdb
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      assert.equal(campaignRow!.status, "ACTIVE");

      const auditEvents = await pgdb
        .select()
        .from(schema.campaignAuditEvents)
        .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
      const eventTypes = auditEvents.map((e) => e.eventType).sort();
      assert.deepEqual(eventTypes, ["LAUNCHED", "SNAPSHOT_CREATED"]);
    },
  );

  await test(
    "launching an already-ACTIVE campaign is idempotent — returns the existing snapshot, creates nothing new",
    async () => {
      const campaignId = await seedLaunchableCampaign(pgdb, "idempotent");
      const first = await launchCampaign(campaignId, pgdb);

      const second = await launchCampaign(campaignId, pgdb);
      assert.equal(second.id, first.id, "same snapshot returned, not a new one");

      const termsSnapshots = await pgdb
        .select()
        .from(schema.campaignTermsSnapshots)
        .where(eq(schema.campaignTermsSnapshots.campaignId, campaignId));
      assert.equal(termsSnapshots.length, 1, "still exactly one snapshot after a second launch");

      const policySnapshots = await pgdb
        .select()
        .from(schema.negotiationPolicySnapshots)
        .where(eq(schema.negotiationPolicySnapshots.campaignId, campaignId));
      assert.equal(policySnapshots.length, 1, "still exactly one policy snapshot");

      const auditEvents = await pgdb
        .select()
        .from(schema.campaignAuditEvents)
        .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
      assert.equal(auditEvents.length, 2, "no new audit rows from the second (no-op) launch");
    },
  );

  await test(
    "editing CampaignDetails on a launched (ACTIVE) campaign throws CampaignLockedError",
    async () => {
      const campaignId = await seedLaunchableCampaign(pgdb, "locked");
      await launchCampaign(campaignId, pgdb);

      await assert.rejects(
        () => upsertCampaignDetails(campaignId, { objective: "changed after launch" }, pgdb),
        CampaignLockedError,
      );

      // And the value on the (still-DRAFT-shaped) CampaignDetails row itself
      // was never touched by the rejected write.
      const [details] = await pgdb
        .select()
        .from(schema.campaignDetails)
        .where(eq(schema.campaignDetails.campaignId, campaignId));
      assert.equal(details!.objective, "Drive signups", "unchanged — the write never landed");
    },
  );

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaigns.launch.db test failed:", err);
  process.exit(1);
});
