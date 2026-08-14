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
import { CampaignLockedError } from "./campaignDetails.js";
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
        niches: ["fitness"],
        geography: ["US", "CA"],
        minFollowers: 10000,
        audienceNotes: "18-34, US-based",
      },
      pgdb,
    );
    assert.deepEqual(r.platforms, ["youtube", "instagram"]);
    assert.deepEqual(r.geography, ["US", "CA"]);
    assert.equal(r.minFollowers, 10000);
    const round = await getCreatorRequirement(id, pgdb);
    assert.equal(round?.audienceNotes, "18-34, US-based");
    assert.deepEqual(round?.niches, ["fitness"]);
  });

  await test("getCreatorRequirementsByCampaignIds batches", async () => {
    const a = await seedCampaign(pgdb);
    await upsertCreatorRequirement(a, { contentStyle: "UGC" }, pgdb);
    const map = await getCreatorRequirementsByCampaignIds([a], pgdb);
    assert.equal(map.get(a)?.contentStyle, "UGC");
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
      () => upsertCreatorRequirement(id, { niches: ["x"] }, pgdb),
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
    await upsertCreatorRequirement(id, { niches: ["y"] }, pgdb);
    await pgdb.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
    assert.equal(await getBrandIdentity(id, pgdb), null);
    assert.equal(await getCreatorRequirement(id, pgdb), null);
  });

  console.log(`\n✓ campaignSections.db: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
