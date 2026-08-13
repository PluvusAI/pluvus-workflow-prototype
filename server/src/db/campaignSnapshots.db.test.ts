/**
 * PLU-137 (1c) §6 — DB-backed tests (real PGlite, all Prisma migrations applied).
 *
 * Two things the pure tests can't prove (kept lean — one per distinct behavior):
 *   1. Pinning (§1b): an ExecutionInstance persists BOTH snapshot ids on enroll.
 *   2. Load + integrity (§2, §3d): loadPinnedSnapshots gates the PRIVATE policy on the
 *      purpose (E4), loads a GIFT policy despite null fee fields (E12), and reports an
 *      integrityFailure — never throws — for a missing pin; and the end-to-end build
 *      surfaces that same flag (+ a value-leak-free record) through buildConversationContext.
 *
 * Run:  node --import tsx --test src/db/campaignSnapshots.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { launchCampaign, resolveCampaignLaunchContext } from "./campaigns.js";
import { loadPinnedSnapshots } from "../engine/executors/negotiation.js";
import { buildConversationContext, buildContextRecord } from "../engine/conversationContext.js";
import type { ResolvedBrief } from "../engine/executors/briefKnowledge.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

// A no-network brief resolver so buildConversationContext makes zero HTTP calls.
const STUB_BRIEF: ResolvedBrief = { flatText: "", status: "ok" };
const stubResolveBrief = (async () => STUB_BRIEF) as never;

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

let sfx = 0;
async function seedLaunchedCampaign(pgdb: Db): Promise<{ campaignId: string; termsId: string; policyId: string }> {
  sfx++;
  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `Snap Test ${sfx}`, brand: "Acme" })
    .returning();
  await pgdb.insert(schema.campaignDetails).values({
    campaignId: campaign!.id,
    objective: "Drive signups",
    usageRights: "90-day paid social",
    // PLU-136 1b.b — launch now gates on a CONFIRMED compensation review + a
    // PAID priceStrategy (REQUEST_RATE_CARD needs no public proposed amount).
    campaignType: "PAID",
    priceStrategy: "REQUEST_RATE_CARD",
    compensationReviewStatus: "CONFIRMED",
  });
  await pgdb.insert(schema.negotiationPolicies).values({
    campaignId: campaign!.id,
    floorCents: 20000,
    ceilingCents: 50000,
    preferredFeeCents: 44444,
    maxRounds: 3,
  });
  const terms = await launchCampaign(campaign!.id, pgdb);
  const [policy] = await pgdb
    .select()
    .from(schema.negotiationPolicySnapshots)
    .where(eq(schema.negotiationPolicySnapshots.campaignId, campaign!.id));
  return { campaignId: campaign!.id, termsId: terms.id, policyId: policy!.id };
}

// Create a launched workflow version + a creator + an ExecutionInstance pinned to the
// given ids. Mirrors what workflows.ts enroll does (createInstance), but against pgdb.
async function enrollInstance(
  pgdb: Db,
  campaignId: string | null,
  pins: { campaignTermsSnapshotId?: string | null; negotiationPolicySnapshotId?: string | null },
): Promise<schema.ExecutionInstance> {
  const [wf] = await pgdb
    .insert(schema.workflows)
    .values({ name: `wf ${sfx}`, ...(campaignId ? { campaignId } : {}) })
    .returning();
  const [wv] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: wf!.id, version: 1, nodeGraph: [] })
    .returning();
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: `Maya ${sfx}`, email: `maya${sfx}@example.com` })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({
      workflowVersionId: wv!.id,
      creatorId: creator!.id,
      ...pins,
    })
    .returning();
  return instance!;
}

async function main(): Promise<void> {
  console.log("\ncampaignSnapshots.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // -------- Pinning (§1b) --------

  await test("enrolling under an ACTIVE launched campaign persists BOTH snapshot ids", async () => {
    const { campaignId, termsId, policyId } = await seedLaunchedCampaign(pgdb);
    const ctx = await resolveCampaignLaunchContext(campaignId, pgdb);
    const instance = await enrollInstance(pgdb, campaignId, {
      campaignTermsSnapshotId: ctx.campaignTermsSnapshotId,
      negotiationPolicySnapshotId: ctx.negotiationPolicySnapshotId,
    });
    assert.equal(instance.campaignTermsSnapshotId, termsId);
    assert.equal(instance.negotiationPolicySnapshotId, policyId);
  });

  // -------- loadPinnedSnapshots load + integrity (§2, §3d) --------

  await test("loadPinnedSnapshots SKIPS the private policy for an unauthorized (draft) purpose", async () => {
    const { campaignId, termsId, policyId } = await seedLaunchedCampaign(pgdb);
    const instance = await enrollInstance(pgdb, campaignId, {
      campaignTermsSnapshotId: termsId,
      negotiationPolicySnapshotId: policyId,
    });
    const res = await loadPinnedSnapshots(instance, "EMAIL_DRAFT", pgdb, campaignId);
    assert.equal(res.terms?.id, termsId, "public terms still load");
    assert.equal(res.policy, undefined, "private policy is NOT loaded for a draft purpose");
    assert.equal(res.integrityFailure, undefined);
  });

  await test("a GIFT campaign (no fee fields) still loads its policy — no fee gates the load (E12)", async () => {
    sfx++;
    const [campaign] = await pgdb
      .insert(schema.campaigns)
      .values({ name: `Gift ${sfx}`, brand: "Acme" })
      .returning();
    // PLU-136 1b.b — campaignType moved to campaignDetails; GIFT renamed
    // GIFT_ONLY; launch now requires gift terms + a CONFIRMED review for it.
    await pgdb.insert(schema.campaignDetails).values({
      campaignId: campaign!.id,
      objective: "Send product",
      campaignType: "GIFT_ONLY",
      productOrOffer: "A free pair of running shoes",
      giftDisposition: "KEEP",
      compensationReviewStatus: "CONFIRMED",
    });
    await pgdb.insert(schema.negotiationPolicies).values({
      campaignId: campaign!.id,
      floorCents: null,
      ceilingCents: null,
      preferredFeeCents: null,
      // Private gift authority — what satisfies GIFT_ONLY launch readiness.
      giftSubstitutionAllowed: true,
      // A non-fee value the loader assertion below verifies still loads.
      commissionCeilingRate: 0.2,
      maxRounds: 1,
    });
    const terms = await launchCampaign(campaign!.id, pgdb);
    const [policy] = await pgdb
      .select()
      .from(schema.negotiationPolicySnapshots)
      .where(eq(schema.negotiationPolicySnapshots.campaignId, campaign!.id));
    const instance = await enrollInstance(pgdb, campaign!.id, {
      campaignTermsSnapshotId: terms.id,
      negotiationPolicySnapshotId: policy!.id,
    });
    const res = await loadPinnedSnapshots(instance, "NEGOTIATION_DECISION", pgdb, campaign!.id);
    assert.ok(res.policy, "GIFT policy loads despite null fee fields");
    assert.equal(res.policy?.floorCents, null);
    assert.equal(res.policy?.commissionCeilingRate, 0.2);
  });

  await test("a MISSING terms snapshot (id set, row deleted) RETURNS an integrityFailure, does not throw", async () => {
    const { campaignId, termsId, policyId } = await seedLaunchedCampaign(pgdb);
    const instance = await enrollInstance(pgdb, campaignId, {
      campaignTermsSnapshotId: termsId,
      negotiationPolicySnapshotId: policyId,
    });
    // Simulate the row vanishing from under a valid pin. loadPinnedSnapshots reads by
    // id; feed a NON-EXISTENT id to model the missing-row case (an FK-live delete is
    // blocked by restrict — the failure mode is a stale/absent id, which is what we test).
    const res = await loadPinnedSnapshots(
      { campaignTermsSnapshotId: "vanished-terms", negotiationPolicySnapshotId: policyId },
      "NEGOTIATION_DECISION",
      pgdb,
      campaignId,
    );
    assert.equal(res.integrityFailure?.reason, "terms_snapshot_missing");
    assert.equal(res.terms, undefined);
  });

  // -------- End-to-end build → cc.integrityFailure (the flag §3d returns MANUAL_REVIEW on) --------
  // The ONE end-to-end proof: a real cross-campaign pin flows loader → assemble →
  // AssembledContext.integrityFailure (set, NOT thrown) → sanitized record. The
  // valid-pin load + value-leak-prevention are asserted in the same run below.

  const nodeGraph = [{ id: "n", type: "NEGOTIATION", order: 1, config: { minBudget: 200, maxBudget: 500 } }];

  const buildCC = (instance: schema.ExecutionInstance, campaign: schema.Campaign) =>
    buildConversationContext(
      {
        instanceId: instance.id,
        purpose: "NEGOTIATION_DECISION",
        nodeGraph: nodeGraph as never,
        node: nodeGraph[0] as never,
        campaign,
        instance,
        creator: { id: instance.creatorId } as never,
        mergedConfig: { minBudget: 200, maxBudget: 500 },
        client: pgdb,
      },
      {
        resolveBrief: stubResolveBrief,
        loadSnapshots: (inst, purpose, client) => loadPinnedSnapshots(inst, purpose, client, campaign.id),
      },
    );

  await test("valid pin: record carries the snapshot ids and NO private policy value (E11)", async () => {
    const { campaignId, termsId, policyId } = await seedLaunchedCampaign(pgdb);
    const instance = await enrollInstance(pgdb, campaignId, {
      campaignTermsSnapshotId: termsId,
      negotiationPolicySnapshotId: policyId,
    });
    const [campaign] = await pgdb.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
    const cc = await buildCC(instance, campaign!);
    assert.equal(cc.termsSnapshot?.id, termsId);
    assert.equal(cc.policySnapshot?.id, policyId);
    const rec = buildContextRecord(cc);
    assert.equal(rec.termsSnapshotId, termsId);
    assert.equal(rec.policySnapshotId, policyId);
    assert.equal(rec.legacyFallbackUsed, false);
    // The private preferredFeeCents value (44444) must NOT appear anywhere in the record.
    assert.ok(!JSON.stringify(rec).includes("44444"), "no private policy value in the sanitized record");
  });

  await test("buildConversationContext SETS cc.integrityFailure (never throws) for a CROSS-CAMPAIGN pin", async () => {
    const a = await seedLaunchedCampaign(pgdb);
    const b = await seedLaunchedCampaign(pgdb);
    // Instance is in campaign A but pinned to campaign B's terms snapshot.
    const instance = await enrollInstance(pgdb, a.campaignId, {
      campaignTermsSnapshotId: b.termsId,
      negotiationPolicySnapshotId: a.policyId,
    });
    const [campaign] = await pgdb.select().from(schema.campaigns).where(eq(schema.campaigns.id, a.campaignId));
    const cc = await buildCC(instance, campaign!);
    // The flag the executor's §3d branch returns MANUAL_REVIEW on — set, NOT thrown.
    assert.equal(cc.integrityFailure?.reason, "terms_snapshot_cross_campaign");
    assert.equal(cc.legacyFallbackUsed, false, "a broken pin is NOT a silent legacy fallback");
    // And the reason rides the sanitized observability record (§4a / E11).
    assert.equal(buildContextRecord(cc).integrityFailureReason, "terms_snapshot_cross_campaign");
  });

  console.log(`\n${n} passed\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
