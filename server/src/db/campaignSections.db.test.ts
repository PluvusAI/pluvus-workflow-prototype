/**
 * PLU-139 — DB-backed tests for the sectioned campaign Draft intake against a REAL
 * Postgres (PGlite, embedded) with every Prisma migration applied verbatim, so the
 * three tables, enums, and unique indexes are byte-identical to live Neon.
 *
 * Covers PLAN A1.5:
 *   - per-structure persistence (Paid=fee+strategy / Affiliate=commission,no-fee /
 *     Hybrid=fee+commission / Gifting=gift,no-fee); both price strategies.
 *   - structure switch clears stale fields (0 residue).
 *   - upsert+get for all three modules.
 *   - Draft-lock (assertCampaignIsDraft) throws across ACTIVE/CLOSING/ARCHIVED for
 *     all three modules; passes on DRAFT.
 *   - money units: proposedFeeCents = integer cents, commissionRate = whole percent.
 *
 * Run:  node --import tsx --test src/db/campaignSections.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import type { CampaignStatus } from "./schema.js";
import {
  getCampaignDetails,
  upsertCampaignDetails,
  assertCampaignIsDraft,
  CampaignNotDraftError,
  clearStaleCompFields,
} from "./campaignDetails.js";
import { getBrandIdentity, upsertBrandIdentity } from "./brandIdentity.js";
import {
  getCreatorRequirement,
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
/** Seed a Campaign row at the given status; returns its id. */
async function seedCampaign(
  pgdb: Db,
  status: CampaignStatus = "DRAFT",
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

  // ── per-structure persistence ──────────────────────────────────────────────
  await test("PAID persists fee + strategy (integer cents, whole percent unit)", async () => {
    const id = await seedCampaign(pgdb);
    const d = await upsertCampaignDetails(
      id,
      {
        compensationStructure: "PAID",
        priceStrategy: "PROPOSE_STARTING_AMOUNT",
        proposedFeeCents: 250000, // $2,500.00 — INTEGER CENTS
        feeCurrency: "USD",
      },
      pgdb,
    );
    assert.equal(d.compensationStructure, "PAID");
    assert.equal(d.priceStrategy, "PROPOSE_STARTING_AMOUNT");
    // Money unit assertion: 250000 cents, NOT 2500 dollars.
    assert.equal(d.proposedFeeCents, 250000);
    assert.equal(typeof d.proposedFeeCents, "number");
    assert.equal(d.commissionRate, null, "PAID has no commission");
    const round = await getCampaignDetails(id, pgdb);
    assert.equal(round?.proposedFeeCents, 250000);
  });

  await test("AFFILIATE persists commission, NO upfront fee", async () => {
    const id = await seedCampaign(pgdb);
    const d = await upsertCampaignDetails(
      id,
      {
        compensationStructure: "AFFILIATE",
        commissionRate: 15, // WHOLE PERCENT, not bps
        commissionMode: "percent",
        commissionDurationKind: "lifetime",
        attributionWindowDays: 30,
      },
      pgdb,
    );
    assert.equal(d.compensationStructure, "AFFILIATE");
    assert.equal(d.commissionRate, 15);
    assert.equal(d.proposedFeeCents, null, "AFFILIATE has no upfront fee");
    assert.equal(d.priceStrategy, null, "AFFILIATE has no price strategy");
  });

  await test("HYBRID persists fee AND commission", async () => {
    const id = await seedCampaign(pgdb);
    const d = await upsertCampaignDetails(
      id,
      {
        compensationStructure: "HYBRID",
        priceStrategy: "REQUEST_RATE_CARD",
        proposedFeeCents: 100000,
        commissionRate: 10,
      },
      pgdb,
    );
    assert.equal(d.proposedFeeCents, 100000);
    assert.equal(d.commissionRate, 10);
    assert.equal(d.priceStrategy, "REQUEST_RATE_CARD");
  });

  await test("GIFTING persists gift, NO fee/commission", async () => {
    const id = await seedCampaign(pgdb);
    const d = await upsertCampaignDetails(
      id,
      {
        compensationStructure: "GIFTING",
        additiveGifting: false,
        giftDescription: "A free pair of shoes",
        giftIsCompensation: true, // creator KEEPS as reward
        giftIsPhysical: true,
        giftAccessMethod: "manual_contact",
      },
      pgdb,
    );
    assert.equal(d.giftDescription, "A free pair of shoes");
    assert.equal(d.giftIsCompensation, true);
    assert.equal(d.proposedFeeCents, null);
    assert.equal(d.commissionRate, null);
    assert.equal(d.priceStrategy, null);
  });

  await test("both price strategies round-trip on PAID", async () => {
    for (const strategy of ["REQUEST_RATE_CARD", "PROPOSE_STARTING_AMOUNT"] as const) {
      const id = await seedCampaign(pgdb);
      const d = await upsertCampaignDetails(
        id,
        { compensationStructure: "PAID", priceStrategy: strategy },
        pgdb,
      );
      assert.equal(d.priceStrategy, strategy);
    }
  });

  await test("jsonb string[] lists persist (not text[])", async () => {
    const id = await seedCampaign(pgdb);
    const d = await upsertCampaignDetails(
      id,
      {
        compensationStructure: "PAID",
        keyMessages: ["msg a", "msg b"],
        prohibitedClaims: ["no health claims"],
        platforms: ["instagram", "tiktok"],
      },
      pgdb,
    );
    assert.deepEqual(d.keyMessages, ["msg a", "msg b"]);
    assert.deepEqual(d.platforms, ["instagram", "tiktok"]);
    const round = await getCampaignDetails(id, pgdb);
    assert.deepEqual(round?.prohibitedClaims, ["no health claims"]);
  });

  // ── structure switch clears stale fields ─────────────────────────────────────
  await test("PAID → AFFILIATE clears fee/strategy in the SAME write (0 residue)", async () => {
    const id = await seedCampaign(pgdb);
    await upsertCampaignDetails(
      id,
      {
        compensationStructure: "PAID",
        priceStrategy: "PROPOSE_STARTING_AMOUNT",
        proposedFeeCents: 500000,
        feeCurrency: "USD",
      },
      pgdb,
    );
    const d = await upsertCampaignDetails(
      id,
      { compensationStructure: "AFFILIATE", commissionRate: 20 },
      pgdb,
    );
    assert.equal(d.compensationStructure, "AFFILIATE");
    assert.equal(d.commissionRate, 20);
    // The stale fee/strategy/currency must be GONE, not lingering.
    assert.equal(d.proposedFeeCents, null, "stale fee cleared");
    assert.equal(d.priceStrategy, null, "stale strategy cleared");
    assert.equal(d.feeCurrency, null, "stale currency cleared");
    // Re-read from DB to prove it's persisted, not just returned.
    const round = await getCampaignDetails(id, pgdb);
    assert.equal(round?.proposedFeeCents, null);
    assert.equal(round?.feeCurrency, null);
  });

  await test("PAID → GIFTING clears both fee AND commission", async () => {
    const id = await seedCampaign(pgdb);
    await upsertCampaignDetails(
      id,
      { compensationStructure: "HYBRID", proposedFeeCents: 100, commissionRate: 5 },
      pgdb,
    );
    const d = await upsertCampaignDetails(
      id,
      { compensationStructure: "GIFTING", giftDescription: "sample box" },
      pgdb,
    );
    assert.equal(d.proposedFeeCents, null);
    assert.equal(d.commissionRate, null);
    assert.equal(d.giftDescription, "sample box");
  });

  await test("clearStaleCompFields is pure and structure-scoped", () => {
    // Non-structure patch → untouched.
    assert.deepEqual(clearStaleCompFields(undefined, { objective: "x" }), {
      objective: "x",
    });
    // AFFILIATE clears fee fields, keeps commission.
    const c = clearStaleCompFields("AFFILIATE", {
      compensationStructure: "AFFILIATE",
      proposedFeeCents: 100,
      commissionRate: 10,
    });
    assert.equal(c.proposedFeeCents, null);
    assert.equal(c.priceStrategy, null);
    assert.equal(c.commissionRate, 10);
    // HYBRID clears nothing.
    const h = clearStaleCompFields("HYBRID", { proposedFeeCents: 1, commissionRate: 2 });
    assert.equal(h.proposedFeeCents, 1);
    assert.equal(h.commissionRate, 2);
  });

  // ── brand identity + creator requirement modules ─────────────────────────────
  await test("brandIdentity upsert + get round-trip", async () => {
    const id = await seedCampaign(pgdb);
    const b = await upsertBrandIdentity(
      id,
      { brandName: "Acme", websiteUrl: "https://acme.test", primaryColor: "#123456" },
      pgdb,
    );
    assert.equal(b.brandName, "Acme");
    // A second upsert patches, doesn't duplicate.
    const b2 = await upsertBrandIdentity(id, { logoUrl: "https://acme.test/logo.png" }, pgdb);
    assert.equal(b2.brandName, "Acme", "prior value preserved");
    assert.equal(b2.logoUrl, "https://acme.test/logo.png");
    const round = await getBrandIdentity(id, pgdb);
    assert.equal(round?.id, b.id, "same row (1:1)");
  });

  await test("creatorRequirement upsert + get (informational, jsonb lists)", async () => {
    const id = await seedCampaign(pgdb);
    const r = await upsertCreatorRequirement(
      id,
      {
        platforms: ["youtube"],
        geographies: ["US", "CA"],
        minFollowers: 10000,
        maxFollowers: 500000,
        niche: "fitness",
      },
      pgdb,
    );
    assert.deepEqual(r.platforms, ["youtube"]);
    assert.deepEqual(r.geographies, ["US", "CA"]);
    assert.equal(r.minFollowers, 10000);
    const round = await getCreatorRequirement(id, pgdb);
    assert.equal(round?.niche, "fitness");
  });

  // ── Draft-lock guard ─────────────────────────────────────────────────────────
  await test("assertCampaignIsDraft passes on DRAFT", async () => {
    const id = await seedCampaign(pgdb, "DRAFT");
    await assertCampaignIsDraft(id, pgdb); // must not throw
  });

  for (const status of ["ACTIVE", "CLOSING", "ARCHIVED"] as const) {
    await test(`assertCampaignIsDraft throws CampaignNotDraftError on ${status}`, async () => {
      const id = await seedCampaign(pgdb, status);
      await assert.rejects(
        () => assertCampaignIsDraft(id, pgdb),
        (err: unknown) =>
          err instanceof CampaignNotDraftError && err.status === status,
      );
    });
  }

  await test("assertCampaignIsDraft throws on a missing campaign", async () => {
    await assert.rejects(
      () => assertCampaignIsDraft("nonexistent-id", pgdb),
      (err: unknown) => err instanceof CampaignNotDraftError && err.status === "MISSING",
    );
  });

  // The guard is the ONE shared impl reused by all three modules — prove it gates
  // a write to each table (route enforces it; here we assert the guard itself is
  // what a caller would invoke before any of the three upserts).
  await test("guard gates writes for all three section modules (ACTIVE campaign)", async () => {
    const id = await seedCampaign(pgdb, "ACTIVE");
    for (const guarded of [
      () => assertCampaignIsDraft(id, pgdb).then(() => upsertCampaignDetails(id, { compensationStructure: "PAID" }, pgdb)),
      () => assertCampaignIsDraft(id, pgdb).then(() => upsertBrandIdentity(id, { brandName: "x" }, pgdb)),
      () => assertCampaignIsDraft(id, pgdb).then(() => upsertCreatorRequirement(id, { niche: "x" }, pgdb)),
    ]) {
      await assert.rejects(guarded, CampaignNotDraftError);
    }
    // And none of the three rows were written.
    assert.equal(await getCampaignDetails(id, pgdb), null);
    assert.equal(await getBrandIdentity(id, pgdb), null);
    assert.equal(await getCreatorRequirement(id, pgdb), null);
  });

  // ── cascade: deleting the campaign clears the detail rows ─────────────────────
  await test("ON DELETE CASCADE removes the detail rows with the campaign", async () => {
    const id = await seedCampaign(pgdb);
    await upsertCampaignDetails(id, { compensationStructure: "PAID" }, pgdb);
    await upsertBrandIdentity(id, { brandName: "y" }, pgdb);
    await pgdb.delete(schema.campaigns).where(eq(schema.campaigns.id, id));
    assert.equal(await getCampaignDetails(id, pgdb), null);
    assert.equal(await getBrandIdentity(id, pgdb), null);
  });

  console.log(`\n✓ campaignSections.db: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
