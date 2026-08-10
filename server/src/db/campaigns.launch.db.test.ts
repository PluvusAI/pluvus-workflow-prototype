/**
 * DB-backed tests for launchCampaign() and the rest of the launch lifecycle
 * (PLU-135 / 1a, extended by PLU-136 / 1b). Runs against a REAL Postgres
 * (PGlite, embedded) with the REAL schema (every migration applied verbatim),
 * so the new tables/constraints/FKs are byte-identical to what a real deploy
 * would have.
 *
 * 1a scope (code review, Ayush, 2026-08-09): the happy path — launch once,
 * launch again is a no-op, the post-launch lock fires.
 *
 * 1b additions: concurrent launch convergence (step 2), campaignType never
 * gating the NegotiationPolicy guard (step 1's correction),
 * resolveCampaignLaunchContext()'s ACTIVE-only gate (step 3), and
 * duplicateCampaign()'s copy/exclude behavior (step 5).
 *
 * Note on the concurrency test: PGlite is a single embedded connection, so
 * `Promise.all` on it proves launchCampaign()'s convergence/idempotency logic
 * (the re-check-after-lock code path) but not genuine multi-connection lock
 * contention — proving that would need a two-real-connection harness against
 * dev Postgres, same caveat documented in engine/payouts.harness.ts.
 *
 * Run:  npx tsx --test src/db/campaigns.launch.db.test.ts   (or via npm test)
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
  resolveCampaignLaunchContext,
  NegotiationPolicyMissingError,
  CampaignNotActiveError,
} from "./campaigns.js";
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
    // PLU-136: campaignType defaults PAID (unset here — matches the
    // default). priceStrategy + compensationReviewStatus are required by
    // launchCampaign()'s compensation-readiness gate — REQUEST_RATE_CARD
    // avoids also needing publicStartingFeeCents.
    priceStrategy: "REQUEST_RATE_CARD",
    compensationReviewStatus: "CONFIRMED",
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

  await test(
    "two concurrent launchCampaign() calls converge on exactly one snapshot and one LAUNCHED event",
    async () => {
      const campaignId = await seedLaunchableCampaign(pgdb, "concurrent");

      const [a, b] = await Promise.all([
        launchCampaign(campaignId, pgdb),
        launchCampaign(campaignId, pgdb),
      ]);
      assert.equal(a.id, b.id, "both concurrent calls return the same snapshot");

      const termsSnapshots = await pgdb
        .select()
        .from(schema.campaignTermsSnapshots)
        .where(eq(schema.campaignTermsSnapshots.campaignId, campaignId));
      assert.equal(termsSnapshots.length, 1, "exactly one snapshot, not two");

      const auditEvents = await pgdb
        .select()
        .from(schema.campaignAuditEvents)
        .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
      const launchedCount = auditEvents.filter((e) => e.eventType === "LAUNCHED").length;
      assert.equal(launchedCount, 1, "exactly one LAUNCHED event despite two concurrent calls");
    },
  );

  await test(
    "NegotiationPolicy is still required to launch regardless of campaignType — campaignType never gates the guard",
    async () => {
      const [campaign] = await pgdb
        .insert(schema.campaigns)
        .values({ name: "Gift, no policy", brand: "Acme" })
        .returning();
      // PLU-136: campaignType now lives on CampaignDetails. GIFT_ONLY needs
      // productOrOffer/giftDisposition/compensationReviewStatus=CONFIRMED to
      // pass validateCompensationReadiness — set here so the ONLY thing
      // missing is the NegotiationPolicy row itself, keeping this test's
      // original point isolated (campaignType never gates the guard).
      await pgdb.insert(schema.campaignDetails).values({
        campaignId: campaign!.id,
        objective: "Send a free product for review",
        campaignType: "GIFT_ONLY",
        productOrOffer: "A pair of running shoes",
        giftDisposition: "KEEP",
        compensationReviewStatus: "CONFIRMED",
      });

      await assert.rejects(
        () => launchCampaign(campaign!.id, pgdb),
        NegotiationPolicyMissingError,
        "GIFT_ONLY alone does not exempt a campaign from the NegotiationPolicy guard",
      );

      // Same campaignType, now WITH a policy (including the gift-flexibility
      // authority GIFT_ONLY requires) — launches fine. Proves the guard
      // reacts to policy presence/completeness alone, never to campaignType.
      await pgdb.insert(schema.negotiationPolicies).values({
        campaignId: campaign!.id,
        giftSubstitutionAllowed: false,
      });
      const snapshot = await launchCampaign(campaign!.id, pgdb);
      assert.equal(snapshot.campaignId, campaign!.id);
    },
  );

  await test(
    "resolveCampaignLaunchContext rejects a DRAFT campaign and returns pinned snapshot ids for an ACTIVE one",
    async () => {
      const campaignId = await seedLaunchableCampaign(pgdb, "enroll");

      await assert.rejects(
        () => resolveCampaignLaunchContext(campaignId, pgdb),
        CampaignNotActiveError,
        "enrollment must be rejected before the campaign has launched",
      );

      const snapshot = await launchCampaign(campaignId, pgdb);
      const context = await resolveCampaignLaunchContext(campaignId, pgdb);
      assert.equal(context.campaignTermsSnapshotId, snapshot.id);

      const [policySnapshot] = await pgdb
        .select()
        .from(schema.negotiationPolicySnapshots)
        .where(eq(schema.negotiationPolicySnapshots.campaignId, campaignId));
      assert.equal(context.negotiationPolicySnapshotId, policySnapshot!.id);
    },
  );

  await test(
    "duplicateCampaign copies details/policy into a fresh DRAFT and copies no history",
    async () => {
      const campaignId = await seedLaunchableCampaign(pgdb, "dup-source");

      // A confirmed extraction — proves confirmedFromExtractionId resets on
      // the duplicate rather than carrying over a pointer the new draft
      // hasn't earned yet.
      const [extraction] = await pgdb
        .insert(schema.campaignBriefExtractions)
        .values({
          campaignId,
          flatText: "raw brief text",
          sections: {},
          sourceFileReference: "brief.pdf",
          parserVersion: "v1",
        })
        .returning();
      await pgdb
        .update(schema.campaignDetails)
        .set({ confirmedFromExtractionId: extraction!.id, confirmedAt: new Date() })
        .where(eq(schema.campaignDetails.campaignId, campaignId));

      // Source launches — has a snapshot and audit history the duplicate
      // must NOT inherit.
      await launchCampaign(campaignId, pgdb);

      const duplicate = await duplicateCampaign(campaignId, pgdb);
      assert.equal(duplicate.status, "DRAFT");
      assert.equal(duplicate.duplicatedFromCampaignId, campaignId);

      const [dupDetails] = await pgdb
        .select()
        .from(schema.campaignDetails)
        .where(eq(schema.campaignDetails.campaignId, duplicate.id));
      assert.equal(dupDetails!.objective, "Drive signups", "creator-facing fields copied");
      assert.equal(
        dupDetails!.confirmedFromExtractionId,
        null,
        "confirmation provenance resets — this draft hasn't been confirmed against anything yet",
      );

      const [dupPolicy] = await pgdb
        .select()
        .from(schema.negotiationPolicies)
        .where(eq(schema.negotiationPolicies.campaignId, duplicate.id));
      assert.equal(dupPolicy!.floorCents, 20000, "negotiation policy copied as a fresh draft starting point");

      const dupSnapshots = await pgdb
        .select()
        .from(schema.campaignTermsSnapshots)
        .where(eq(schema.campaignTermsSnapshots.campaignId, duplicate.id));
      assert.equal(dupSnapshots.length, 0, "no snapshot copied — the duplicate must launch on its own");

      const dupAuditEvents = await pgdb
        .select()
        .from(schema.campaignAuditEvents)
        .where(eq(schema.campaignAuditEvents.campaignId, duplicate.id));
      assert.equal(dupAuditEvents.length, 0, "no audit history copied onto the duplicate");

      const sourceAuditEvents = await pgdb
        .select()
        .from(schema.campaignAuditEvents)
        .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
      const duplicatedEvents = sourceAuditEvents.filter((e) => e.eventType === "DUPLICATED");
      assert.equal(duplicatedEvents.length, 1, "exactly one DUPLICATED event on the source");
      assert.equal(
        (duplicatedEvents[0]!.payload as Record<string, unknown>)["newCampaignId"],
        duplicate.id,
      );
    },
  );

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("campaigns.launch.db test failed:", err);
  process.exit(1);
});
