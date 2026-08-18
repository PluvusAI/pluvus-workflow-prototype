/**
 * PLU-142 [3b] — DB-backed tests for campaignBriefValidation.ts: the single
 * authoritative CURRENT / REGENERATING / BLOCKED decision in front of
 * CampaignBrief retrieval, both campaign-scoped and instance-scoped.
 *
 * Runs against a real embedded Postgres (PGlite) with every migration
 * applied for real — same convention as every other .db.test.ts.
 *
 * Unlike campaignBriefRender.db.test.ts, this file DOES exercise
 * enqueueCampaignBriefRender() for real (resolveAgainstExpectedSnapshot's
 * own regeneration trigger calls it directly, not through a route this file
 * could stub) — a real BullMQ Queue.add() against the local dev Redis
 * (docker compose, redis://localhost:6379 by default). Each test that
 * triggers regeneration best-effort removes its own job afterward
 * (cleanupQueuedJob) so repeat local test runs don't accumulate dead-
 * lettered jobs in the shared dev Redis, and main() calls closeQueues() at
 * the end so the process can exit cleanly. This is genuinely best-effort,
 * not guaranteed: if a real campaign-brief-render worker happens to be
 * running locally (e.g. `npm run dev -w server`), it will race this cleanup
 * — it grabs the job, fails 3x against the real DB (the campaignBriefId only
 * exists in this run's ephemeral PGlite), and BullMQ's removeOnFail keeps
 * that failed entry regardless of this file's own remove() call. Harmless
 * either way (no data written anywhere outside this file's own PGlite
 * instance) — worst case is a handful of stray failed-job entries in local
 * dev Redis, self-expiring per removeOnFail's age policy.
 *
 * Run:  npx tsx --test src/db/campaignBriefValidation.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { launchCampaign } from "./campaigns.js";
import { getLatestCampaignBriefForCampaign } from "./campaignBriefRender.js";
import {
  resolveCurrentCampaignBriefForCampaign,
  resolveCurrentCampaignBriefForInstance,
} from "./campaignBriefValidation.js";
import { getCampaignBriefRenderQueue, closeQueues } from "../workers/queues.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

let sfx = 0;

/** Seeds a fully-launched campaign, ready for the validation service. */
async function seedLaunchedCampaign(
  pgdb: Db,
  details: Partial<schema.CampaignDetailsInsert> = {},
): Promise<{ campaignId: string; campaignTermsSnapshotId: string }> {
  sfx++;
  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: `Validation Test ${sfx}`, brand: "Acme" })
    .returning();
  await pgdb.insert(schema.campaignDetails).values({
    campaignId: campaign!.id,
    objective: "Drive signups",
    usageRights: "90-day paid social",
    campaignType: "PAID",
    priceStrategy: "REQUEST_RATE_CARD",
    compensationReviewStatus: "CONFIRMED",
    ...details,
  });
  await pgdb.insert(schema.negotiationPolicies).values({
    campaignId: campaign!.id,
    floorCents: 20_000,
    ceilingCents: 50_000,
  });
  const snapshot = await launchCampaign(campaign!.id, pgdb);
  return { campaignId: campaign!.id, campaignTermsSnapshotId: snapshot.id };
}

/** Hand-inserts a CampaignBrief row, bypassing the real render pipeline (Puppeteer). */
async function insertBrief(
  pgdb: Db,
  campaignId: string,
  campaignTermsSnapshotId: string,
  overrides: Partial<schema.CampaignBriefInsert> = {},
): Promise<schema.CampaignBrief> {
  sfx++;
  const [row] = await pgdb
    .insert(schema.campaignBriefs)
    .values({
      campaignId,
      campaignTermsSnapshotId,
      renderRequestId: `req-${sfx}`,
      status: "READY",
      renderedAssetRef: `fake/asset/${sfx}.pdf`,
      brandIdentitySnapshot: {},
      templateVersion: "v1",
      ...overrides,
    })
    .returning();
  return row!;
}

/** Creates a workflow + workflowVersion + creator + ExecutionInstance pinned to `pins`. */
async function enrollInstance(
  pgdb: Db,
  campaignId: string,
  pins: { campaignTermsSnapshotId?: string | null },
): Promise<schema.ExecutionInstance> {
  sfx++;
  const [wf] = await pgdb
    .insert(schema.workflows)
    .values({ name: `wf ${sfx}`, campaignId })
    .returning();
  const [wv] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: wf!.id, version: 1, nodeGraph: [] })
    .returning();
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: `Creator ${sfx}`, email: `creator${sfx}@example.com` })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: wv!.id, creatorId: creator!.id, ...pins })
    .returning();
  return instance!;
}

/**
 * Removes the regeneration job a REGENERATING result enqueued for
 * `campaignId`, if any. Queries for the GENERATING row specifically (not
 * getLatestCampaignBriefForCampaign — its ORDER BY createdAt has no
 * tiebreaker, and a test's hand-inserted fixture row and the just-created
 * regeneration row can land in the same millisecond on in-memory PGlite,
 * making "latest" ambiguous). Only the row this helper's caller just
 * triggered a regeneration for is ever GENERATING at cleanup time.
 */
async function cleanupQueuedJob(pgdb: Db, campaignId: string): Promise<void> {
  const [generating] = await pgdb
    .select()
    .from(schema.campaignBriefs)
    .where(and(eq(schema.campaignBriefs.campaignId, campaignId), eq(schema.campaignBriefs.status, "GENERATING")));
  if (!generating) return;
  await getCampaignBriefRenderQueue().remove(`brief-render|${generating.id}`);
}

async function main(): Promise<void> {
  console.log("\ncampaignBriefValidation.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // -------- resolveCurrentCampaignBriefForCampaign --------

  await test("unknown campaign id -> BLOCKED/NO_CAMPAIGN", async () => {
    const result = await resolveCurrentCampaignBriefForCampaign("does-not-exist", pgdb);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.mismatchCategory, "NO_CAMPAIGN");
    assert.equal(result.expected.campaignId, "does-not-exist");
    assert.equal(result.stored.campaignId, null);
    assert.equal(result.regenerationAllowed, false);
    assert.equal(result.nextAction, "operator_review_required");
  });

  await test("a DRAFT (never launched) campaign -> BLOCKED/NO_CAMPAIGN, real reason in diagnostic", async () => {
    const [campaign] = await pgdb
      .insert(schema.campaigns)
      .values({ name: "Still Draft", brand: "Acme" })
      .returning();
    const result = await resolveCurrentCampaignBriefForCampaign(campaign!.id, pgdb);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.mismatchCategory, "NO_CAMPAIGN");
    assert.ok(result.diagnostic.length > 0);
  });

  await test("a READY brief matching the current snapshot -> CURRENT", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
    const brief = await insertBrief(pgdb, campaignId, campaignTermsSnapshotId);
    const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(result.status, "CURRENT");
    assert.equal(result.brief!.id, brief.id);
    assert.equal(result.mismatchCategory, null);
    assert.equal(result.nextAction, "serve_current");
  });

  await test("no brief ever rendered -> REGENERATING/NO_CURRENT_BRIEF, a new GENERATING row is created", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb);
    const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(result.status, "REGENERATING");
    assert.equal(result.mismatchCategory, "NO_CURRENT_BRIEF");
    assert.equal(result.regenerationAllowed, true);
    assert.equal(result.nextAction, "poll_for_ready");
    const created = await getLatestCampaignBriefForCampaign(campaignId, pgdb);
    assert.ok(created, "a GENERATING row must have been created");
    assert.equal(created!.status, "GENERATING");
    await cleanupQueuedJob(pgdb, campaignId);
  });

  // NOTE: campaign-scoped SNAPSHOT_MISMATCH has no test here — it is not
  // just "unreachable via the public entry points" (the module's own doc
  // comment) but unconstructible in this schema at all: CampaignTermsSnapshot
  // has a UNIQUE(campaignId) constraint (at most one snapshot ever, per
  // campaign, for its whole life) AND CampaignBrief's FK on
  // (campaignTermsSnapshotId, campaignId) is COMPOSITE — so any CampaignBrief
  // row for campaignId X can only ever reference X's one snapshot. There is
  // no way, even with a hand-inserted row, to produce a CampaignBrief whose
  // campaignTermsSnapshotId differs from resolveCampaignLaunchContext's
  // answer for the same campaignId. See the instance-scoped test below,
  // where SNAPSHOT_MISMATCH genuinely IS reachable (an ExecutionInstance's
  // pin has no such composite constraint).

  await test("only a FAILED brief exists -> REGENERATING/ASSET_UNAVAILABLE, never CURRENT", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
    await insertBrief(pgdb, campaignId, campaignTermsSnapshotId, {
      status: "FAILED",
      renderedAssetRef: null,
      errorCategory: "RENDER_FAILED",
    });
    const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
    assert.notEqual(result.status, "CURRENT");
    assert.equal(result.status, "REGENERATING");
    assert.equal(result.mismatchCategory, "ASSET_UNAVAILABLE");
    await cleanupQueuedJob(pgdb, campaignId);
  });

  await test("concurrent calls on the same mismatch collapse into exactly one new row", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb);
    const [a, b] = await Promise.all([
      resolveCurrentCampaignBriefForCampaign(campaignId, pgdb),
      resolveCurrentCampaignBriefForCampaign(campaignId, pgdb),
    ]);
    assert.equal(a.status, "REGENERATING");
    assert.equal(b.status, "REGENERATING");
    const rows = await pgdb
      .select()
      .from(schema.campaignBriefs)
      .where(eq(schema.campaignBriefs.campaignId, campaignId));
    assert.equal(rows.length, 1, "deterministic renderRequestId must collapse both calls onto one row");
    await cleanupQueuedJob(pgdb, campaignId);
  });

  await test("an archived campaign (archivedAt set) still resolves CURRENT normally", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
    const brief = await insertBrief(pgdb, campaignId, campaignTermsSnapshotId);
    await pgdb.update(schema.campaigns).set({ archivedAt: new Date() }).where(eq(schema.campaigns.id, campaignId));
    const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
    assert.equal(result.status, "CURRENT");
    assert.equal(result.brief!.id, brief.id);
  });

  await test("two campaigns never leak each other's brief (cross-campaign isolation)", async () => {
    const a = await seedLaunchedCampaign(pgdb);
    const b = await seedLaunchedCampaign(pgdb);
    const briefB = await insertBrief(pgdb, b.campaignId, b.campaignTermsSnapshotId);

    // Campaign A has no brief of its own — must never resolve to B's row.
    const resultA = await resolveCurrentCampaignBriefForCampaign(a.campaignId, pgdb);
    assert.equal(resultA.status, "REGENERATING");
    assert.notEqual(resultA.mismatchCategory, "CROSS_CAMPAIGN"); // unreachable by construction — see module doc comment
    assert.equal(resultA.stored.campaignId, null);

    const resultB = await resolveCurrentCampaignBriefForCampaign(b.campaignId, pgdb);
    assert.equal(resultB.status, "CURRENT");
    assert.equal(resultB.brief!.id, briefB.id);
    await cleanupQueuedJob(pgdb, a.campaignId);
  });

  // -------- resolveCurrentCampaignBriefForInstance --------

  await test("unknown instance id -> BLOCKED/NO_CAMPAIGN, expected.campaignId is the instance id", async () => {
    const result = await resolveCurrentCampaignBriefForInstance("does-not-exist", pgdb);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.mismatchCategory, "NO_CAMPAIGN");
    assert.equal(result.expected.campaignId, "does-not-exist");
  });

  await test("an instance with no pinned snapshot -> BLOCKED/NO_PINNED_SNAPSHOT, real campaign id still resolved", async () => {
    const { campaignId } = await seedLaunchedCampaign(pgdb);
    const instance = await enrollInstance(pgdb, campaignId, { campaignTermsSnapshotId: null });
    const result = await resolveCurrentCampaignBriefForInstance(instance.id, pgdb);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.mismatchCategory, "NO_PINNED_SNAPSHOT");
    assert.equal(result.expected.campaignId, campaignId);
  });

  await test("an instance pinned to the campaign's current snapshot, brief matches -> CURRENT", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
    const brief = await insertBrief(pgdb, campaignId, campaignTermsSnapshotId);
    const instance = await enrollInstance(pgdb, campaignId, { campaignTermsSnapshotId });
    const result = await resolveCurrentCampaignBriefForInstance(instance.id, pgdb);
    assert.equal(result.status, "CURRENT");
    assert.equal(result.brief!.id, brief.id);
  });

  await test(
    "an instance pinned to a DIFFERENT campaign's snapshot -> REGENERATING/SNAPSHOT_MISMATCH, expected reflects the instance's OWN pin",
    async () => {
      // Unlike CampaignBrief (composite FK, see the NOTE above),
      // ExecutionInstance.campaignTermsSnapshotId references
      // CampaignTermsSnapshot.id directly with no campaignId cross-check —
      // so this really is a reachable state (a data-integrity anomaly, not
      // something enroll() would ever intentionally produce), and it's the
      // one path that genuinely reaches SNAPSHOT_MISMATCH.
      const a = await seedLaunchedCampaign(pgdb);
      const b = await seedLaunchedCampaign(pgdb);
      // The current brief for campaign A matches A's own real snapshot...
      await insertBrief(pgdb, a.campaignId, a.campaignTermsSnapshotId);
      // ...but this instance (enrolled under A's workflow) is pinned to B's snapshot.
      const instance = await enrollInstance(pgdb, a.campaignId, {
        campaignTermsSnapshotId: b.campaignTermsSnapshotId,
      });
      const result = await resolveCurrentCampaignBriefForInstance(instance.id, pgdb);
      assert.equal(result.status, "REGENERATING");
      assert.equal(result.mismatchCategory, "SNAPSHOT_MISMATCH");
      assert.equal(
        result.expected.campaignTermsSnapshotId,
        b.campaignTermsSnapshotId,
        "instance-scoped resolution expects the INSTANCE's own pin, not the campaign's current snapshot",
      );
      await cleanupQueuedJob(pgdb, a.campaignId);
    },
  );

  console.log(`\n${n} passed\n`);
  await closeQueues();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("campaignBriefValidation.db test failed:", err);
  await closeQueues().catch(() => {});
  process.exit(1);
});
