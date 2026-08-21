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
import { mkdir, writeFile } from "node:fs/promises";
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
  CampaignBriefRegenerationUnavailableError,
} from "./campaignBriefValidation.js";
import { getCampaignBriefRenderQueue, closeQueues } from "../workers/queues.js";
import { uploadsDir, resolveStoredFile } from "../storage/localFileStorage.js";
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
    deliverableQuantities: [{ id: "del_default", platform: "instagram", format: "reel", quantity: 1 }],
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

/**
 * Hand-inserts a CampaignBrief row, bypassing the real render pipeline
 * (Puppeteer). For a READY row (the default), also writes real bytes to the
 * resolved storage path — review fix (#3) makes storedFileExists() a real
 * gate on CURRENT, so a READY row whose file was never actually written
 * would (correctly) no longer read as CURRENT. Pass `withRealFile: false`
 * to deliberately construct the missing-file case that fix exists for.
 */
async function insertBrief(
  pgdb: Db,
  campaignId: string,
  campaignTermsSnapshotId: string,
  overrides: Partial<schema.CampaignBriefInsert> = {},
  opts: { withRealFile?: boolean } = {},
): Promise<schema.CampaignBrief> {
  sfx++;
  const withRealFile = opts.withRealFile ?? true;
  const [row] = await pgdb
    .insert(schema.campaignBriefs)
    .values({
      campaignId,
      campaignTermsSnapshotId,
      renderRequestId: `req-${sfx}`,
      status: "READY",
      renderedAssetRef: `test-asset-${sfx}.pdf`,
      brandIdentitySnapshot: {},
      templateVersion: "v1",
      ...overrides,
    })
    .returning();
  if (withRealFile && row!.status === "READY" && row!.renderedAssetRef) {
    await mkdir(uploadsDir(), { recursive: true });
    await writeFile(resolveStoredFile(row!.renderedAssetRef), "fake pdf bytes");
  }
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

  // Review fix (#3): a DB row claiming READY + renderedAssetRef is not
  // proof the bytes are still retrievable (e.g. an ephemeral filesystem
  // wiped by a container restart, DB untouched). Must not be served as
  // CURRENT — regeneration should trigger instead, same as any other
  // unservable candidate.
  await test("a READY brief whose file is missing on disk -> REGENERATING/ASSET_UNAVAILABLE, never CURRENT", async () => {
    const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
    await insertBrief(pgdb, campaignId, campaignTermsSnapshotId, {}, { withRealFile: false });
    const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
    assert.notEqual(result.status, "CURRENT");
    assert.equal(result.status, "REGENERATING");
    assert.equal(result.mismatchCategory, "ASSET_UNAVAILABLE");
    assert.equal(result.stored.campaignTermsSnapshotId, campaignTermsSnapshotId, "identity matched — only the file was missing");
    await cleanupQueuedJob(pgdb, campaignId);
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

  await test("only an unrelated FAILED brief exists -> REGENERATING/ASSET_UNAVAILABLE (a fresh attempt), never CURRENT", async () => {
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

  // Review fix (#1a): the deterministic auto-regen renderRequestId means a
  // PRIOR failed attempt for this EXACT snapshot is a dead end — a fresh
  // call can never mint a new attempt (renderRequestId is DB-unique), so
  // reporting REGENERATING here (the old behavior) would tell a caller to
  // keep polling a job that will never run, forever.
  await test(
    "a prior auto-regen attempt for the EXACT expected snapshot already failed -> BLOCKED, never a stuck REGENERATING",
    async () => {
      const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
      // The exact deterministic key resolveAgainstExpectedSnapshot itself
      // would compute for this campaign/snapshot pair.
      await insertBrief(
        pgdb,
        campaignId,
        campaignTermsSnapshotId,
        {
          renderRequestId: `auto-regen|${campaignId}|${campaignTermsSnapshotId}`,
          status: "FAILED",
          renderedAssetRef: null,
          errorCategory: "RENDER_FAILED",
        },
        { withRealFile: false },
      );
      const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
      assert.equal(result.status, "BLOCKED", "must not claim REGENERATING for a dead auto-regen attempt");
      assert.equal(result.regenerationAllowed, false);
      assert.equal(result.nextAction, "operator_review_required");
      assert.ok(result.diagnostic.includes("already failed"));
      // No job was ever enqueued for this dead end — nothing to clean up.
    },
  );

  // Review fix (#4, positive control): a genuine domain error mid-
  // regeneration (a renderRequestId collision across campaigns) must still
  // classify as BLOCKED — proving the instanceof allowlist itself works,
  // not just that unknown errors are no longer folded into it.
  await test(
    "a renderRequestId collision with a different campaign's row -> BLOCKED (known domain error), not thrown as transient",
    async () => {
      const { campaignId, campaignTermsSnapshotId } = await seedLaunchedCampaign(pgdb);
      const other = await seedLaunchedCampaign(pgdb);
      // Plant a row under a DIFFERENT campaign using the EXACT renderRequestId
      // this campaign's own auto-regen attempt would deterministically compute.
      await insertBrief(
        pgdb,
        other.campaignId,
        other.campaignTermsSnapshotId,
        { renderRequestId: `auto-regen|${campaignId}|${campaignTermsSnapshotId}` },
        { withRealFile: false },
      );
      const result = await resolveCurrentCampaignBriefForCampaign(campaignId, pgdb);
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.regenerationAllowed, false);
      assert.equal(result.nextAction, "operator_review_required");
    },
  );

  // Review fix (#5): resolveCurrentCampaignBriefForCampaign's own try/catch
  // around resolveCampaignLaunchContext used to ALSO wrap the delegated call
  // to resolveAgainstExpectedSnapshot — so a CampaignBriefRegenerationUnavailableError
  // thrown from THAT function's regeneration attempt (a transient Redis/DB
  // failure, fix #4) was caught here too and silently reclassified as a
  // permanent BLOCKED/NO_CAMPAIGN result, before it could ever reach a
  // route's dedicated 503 handler — defeating fix #4 for every caller that
  // goes through the campaign-scoped entry point (both routes). Proven here
  // by wrapping the real pgdb so every call succeeds normally EXCEPT
  // `.transaction()` — the one method only createOrGetCampaignBriefRenderRequest
  // (called deep inside the regeneration attempt) uses — which throws a
  // plain, non-domain Error simulating a transient failure.
  await test(
    "a transient failure during regeneration propagates as CampaignBriefRegenerationUnavailableError, not a swallowed BLOCKED result",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb);
      const brokenClient = Object.create(pgdb) as Db;
      brokenClient.transaction = (async () => {
        throw new Error("simulated transient Redis/DB failure");
      }) as Db["transaction"];

      await assert.rejects(
        () => resolveCurrentCampaignBriefForCampaign(campaignId, brokenClient),
        (err: unknown) => {
          assert.ok(
            err instanceof CampaignBriefRegenerationUnavailableError,
            `expected CampaignBriefRegenerationUnavailableError, got ${err}`,
          );
          return true;
        },
      );
    },
  );

  // Review fix (#6): fix #5 above only closed the try/catch gap around the
  // DELEGATED call to resolveAgainstExpectedSnapshot — several plain reads
  // (findCampaignById here, plus getCurrentReadyCampaignBrief/
  // getLatestCampaignBriefForCampaign inside resolveAgainstExpectedSnapshot
  // itself) had NO error handling at all, so a transient failure on any of
  // them propagated as a raw driver error rather than
  // CampaignBriefRegenerationUnavailableError — bypassing both routes'
  // `instanceof` check and falling through to their generic 500 instead of
  // the intended 503. Now every one of those reads goes through the same
  // `wrapTransient()` helper `resolveAgainstExpectedSnapshot`'s own
  // regeneration-attempt catch already used. Proven here for the
  // campaign-lookup call specifically (the cleanest to isolate — the very
  // first DB call in the chain); the other three share this exact same
  // helper and code shape, so are covered by construction rather than each
  // needing its own isolated mock (the same practical-testability boundary
  // already noted for fix #4's negative-space branch, above).
  await test(
    "a transient failure during the campaign lookup itself propagates as CampaignBriefRegenerationUnavailableError, not a raw error",
    async () => {
      const { campaignId } = await seedLaunchedCampaign(pgdb);
      const brokenClient = Object.create(pgdb) as Db;
      brokenClient.select = (() => {
        throw new Error("simulated transient DB failure");
      }) as Db["select"];

      await assert.rejects(
        () => resolveCurrentCampaignBriefForCampaign(campaignId, brokenClient),
        (err: unknown) => {
          assert.ok(
            err instanceof CampaignBriefRegenerationUnavailableError,
            `expected CampaignBriefRegenerationUnavailableError, got ${err}`,
          );
          return true;
        },
      );
    },
  );

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

  // Review fix (#1b): regeneration ALWAYS renders the CAMPAIGN's own
  // permanent snapshot (createOrGetCampaignBriefRenderRequest resolves it
  // via resolveCampaignLaunchContext, never from expectedSnapshotId) — so
  // when an instance is pinned to a DIFFERENT campaign's snapshot,
  // "regenerating" campaign A can never produce a document matching B's
  // snapshot. The old behavior reported REGENERATING here forever; this
  // must now be BLOCKED — regeneration is provably incapable of fixing it.
  await test(
    "an instance pinned to a DIFFERENT campaign's snapshot -> BLOCKED (impossible for regeneration to satisfy), never a stuck REGENERATING",
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
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.mismatchCategory, "SNAPSHOT_MISMATCH");
      assert.equal(result.regenerationAllowed, false);
      assert.equal(result.nextAction, "operator_review_required");
      assert.equal(
        result.expected.campaignTermsSnapshotId,
        b.campaignTermsSnapshotId,
        "instance-scoped resolution expects the INSTANCE's own pin, not the campaign's current snapshot",
      );
      assert.ok(result.diagnostic.includes("does not belong to campaign"));
      // Regeneration was attempted (and detected as impossible) before we
      // could know that — a GENERATING row for campaign A's OWN snapshot
      // may exist, but no job was ever enqueued for it (the check runs
      // before enqueueing), so there's nothing queued to clean up.
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
