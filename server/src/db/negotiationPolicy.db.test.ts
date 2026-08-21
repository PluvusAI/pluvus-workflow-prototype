/**
 * PLU-172 — DB-backed tests for upsertNegotiationPolicy()'s audit behavior
 * (Calvin review, items 4/12): a private-policy edit is audited under the
 * EXISTING POLICY_CHANGED CampaignAuditEvent type — no new enum value — and
 * the payload records WHICH fields changed, NEVER their values.
 *
 * Run: npx tsx --test src/db/negotiationPolicy.db.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  upsertNegotiationPolicy,
  upsertNegotiationPolicyValidated,
  NegotiationPolicyValidationError,
} from "./negotiationPolicy.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  console.log("\nnegotiationPolicy.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  const [campaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: "Audit Test", brand: "Acme" })
    .returning();
  const campaignId = campaign!.id;

  await test("a policy PATCH writes a POLICY_CHANGED audit event listing the changed field NAMES, never their values", async () => {
    await upsertNegotiationPolicy(campaignId, { floorCents: 40000, ceilingCents: 60000 }, pgdb);

    const auditRows = await pgdb
      .select()
      .from(schema.campaignAuditEvents)
      .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
    assert.equal(auditRows.length, 1, "exactly one audit event for this PATCH");
    assert.equal(auditRows[0]!.eventType, "POLICY_CHANGED", "reuses the EXISTING event type — no new enum value");

    const payload = auditRows[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload["changedFields"], ["ceilingCents", "floorCents"], "field NAMES, sorted");

    // The privacy-critical assertion: the raw values (40000, 60000) must
    // never appear anywhere in the payload.
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("40000"), "the raw floorCents VALUE must never be recorded in the audit payload");
    assert.ok(!serialized.includes("60000"), "the raw ceilingCents VALUE must never be recorded in the audit payload");
  });

  await test("a second, different PATCH writes a second, independent audit event", async () => {
    await upsertNegotiationPolicy(campaignId, { feeMode: "ALLOW_WITHIN_LIMIT" }, pgdb);

    const auditRows = await pgdb
      .select()
      .from(schema.campaignAuditEvents)
      .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
    assert.equal(auditRows.length, 2, "the first PATCH's event is untouched; a new one is appended");
    const latest = auditRows[auditRows.length - 1]!;
    assert.equal(latest.eventType, "POLICY_CHANGED");
    assert.deepEqual((latest.payload as Record<string, unknown>)["changedFields"], ["feeMode"]);
  });

  await test("a no-op patch (empty data) writes NO audit event", async () => {
    const before = await pgdb
      .select()
      .from(schema.campaignAuditEvents)
      .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
    await upsertNegotiationPolicy(campaignId, {}, pgdb);
    const after = await pgdb
      .select()
      .from(schema.campaignAuditEvents)
      .where(eq(schema.campaignAuditEvents.campaignId, campaignId));
    assert.equal(after.length, before.length, "nothing changed, nothing to audit");
  });

  // -------------------------------------------------------------------------
  // Review fix: "policy validation is not atomic with its write." The OLD
  // route flow read CampaignDetails/NegotiationPolicy, validated, THEN
  // separately called upsertNegotiationPolicy — two concurrent PATCHes could
  // each validate against a stale snapshot of the OTHER's not-yet-committed
  // change. upsertNegotiationPolicyValidated fixes this by reading+
  // validating INSIDE the same locked transaction as the write. PGlite is a
  // single connection (documented elsewhere in this codebase, e.g.
  // campaigns.launch.db.test.ts), so these tests prove the fix via
  // SEQUENTIAL calls — each one re-reads whatever the PREVIOUS call actually
  // committed, which is exactly the property that closes the race: a second
  // request can never validate against data staler than what the first one
  // left behind.
  // -------------------------------------------------------------------------

  const [raceCampaign] = await pgdb
    .insert(schema.campaigns)
    .values({ name: "Atomicity Test", brand: "Acme" })
    .returning();
  const raceCampaignId = raceCampaign!.id;
  await pgdb.insert(schema.campaignDetails).values({
    campaignId: raceCampaignId,
    priceStrategy: "PROPOSE_STARTING_FEE",
    publicStartingFeeCents: 1000,
  });

  await test(
    "BUG (fixed) — reported scenario: mode set first, then a limit below the public fee is rejected against the FRESH (not stale) mode",
    async () => {
      const afterModeSet = await upsertNegotiationPolicyValidated(raceCampaignId, { feeMode: "ALLOW_WITHIN_LIMIT" }, pgdb);
      assert.equal(afterModeSet.feeMode, "ALLOW_WITHIN_LIMIT");

      // This second call does NOT resubmit feeMode — the exact shape of the
      // reported bug. It must still be rejected because the validator
      // re-reads feeMode fresh (ALLOW_WITHIN_LIMIT, just committed above),
      // not the undefined-from-this-patch value the old code effectively
      // treated as "not ALLOW_WITHIN_LIMIT, skip the check."
      await assert.rejects(
        () => upsertNegotiationPolicyValidated(raceCampaignId, { ceilingCents: 500 }, pgdb),
        (err: unknown) => {
          assert.ok(err instanceof NegotiationPolicyValidationError);
          assert.equal(err.code, "FEE_LIMIT_BELOW_PUBLIC_OFFER");
          return true;
        },
      );

      // Nothing partial was written — ceilingCents stays whatever it was
      // (null) before the rejected call, not 500.
      const [row] = await pgdb.select().from(schema.negotiationPolicies).where(eq(schema.negotiationPolicies.campaignId, raceCampaignId));
      assert.equal(row!.ceilingCents, null, "a rejected validated write must not persist ANY part of its patch");
    },
  );

  await test(
    "BUG (fixed) — symmetric scenario: a stale limit set BEFORE the mode existed is caught once the mode newly authorizes it",
    async () => {
      const [freshCampaign] = await pgdb
        .insert(schema.campaigns)
        .values({ name: "Atomicity Test 2", brand: "Acme" })
        .returning();
      const freshCampaignId = freshCampaign!.id;
      await pgdb.insert(schema.campaignDetails).values({
        campaignId: freshCampaignId,
        priceStrategy: "PROPOSE_STARTING_FEE",
        publicStartingFeeCents: 1000,
      });

      // feeMode defaults to KEEP_PUBLIC_OFFER — this passes today (the check
      // only fires under ALLOW_WITHIN_LIMIT), leaving a "stale" ceilingCents
      // sitting in storage that was never actually validated against the
      // public fee.
      await upsertNegotiationPolicyValidated(freshCampaignId, { ceilingCents: 500 }, pgdb);

      // NOW the mode is patched to ALLOW_WITHIN_LIMIT WITHOUT resubmitting
      // ceilingCents — the stale 500 becomes load-bearing and must be
      // caught.
      await assert.rejects(
        () => upsertNegotiationPolicyValidated(freshCampaignId, { feeMode: "ALLOW_WITHIN_LIMIT" }, pgdb),
        (err: unknown) => {
          assert.ok(err instanceof NegotiationPolicyValidationError);
          assert.equal(err.code, "FEE_LIMIT_BELOW_PUBLIC_OFFER");
          return true;
        },
      );

      const [row] = await pgdb.select().from(schema.negotiationPolicies).where(eq(schema.negotiationPolicies.campaignId, freshCampaignId));
      assert.equal(row!.feeMode, "KEEP_PUBLIC_OFFER", "the rejected mode change must not persist");
    },
  );

  await test("a fully valid sequence (limit set high enough, then mode authorized) succeeds both times", async () => {
    const [okCampaign] = await pgdb
      .insert(schema.campaigns)
      .values({ name: "Atomicity Test 3", brand: "Acme" })
      .returning();
    const okCampaignId = okCampaign!.id;
    await pgdb.insert(schema.campaignDetails).values({
      campaignId: okCampaignId,
      priceStrategy: "PROPOSE_STARTING_FEE",
      publicStartingFeeCents: 1000,
    });

    await upsertNegotiationPolicyValidated(okCampaignId, { ceilingCents: 1500 }, pgdb);
    const final = await upsertNegotiationPolicyValidated(okCampaignId, { feeMode: "ALLOW_WITHIN_LIMIT" }, pgdb);
    assert.equal(final.feeMode, "ALLOW_WITHIN_LIMIT");
    assert.equal(final.ceilingCents, 1500);
  });

  await test("an unrelated field patch (posting) is never blocked by pre-existing invalid fee data it doesn't touch", async () => {
    const [unrelatedCampaign] = await pgdb
      .insert(schema.campaigns)
      .values({ name: "Atomicity Test 4", brand: "Acme" })
      .returning();
    const unrelatedCampaignId = unrelatedCampaign!.id;
    await pgdb.insert(schema.campaignDetails).values({
      campaignId: unrelatedCampaignId,
      priceStrategy: "PROPOSE_STARTING_FEE",
      publicStartingFeeCents: 1000,
    });
    // Hand-seed an already-invalid combination directly (bypassing
    // validation entirely, via the plain unvalidated upsert) — simulates
    // data that predates this ticket's checks.
    await upsertNegotiationPolicy(unrelatedCampaignId, { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 1 }, pgdb);

    const result = await upsertNegotiationPolicyValidated(
      unrelatedCampaignId,
      { postingNegotiationMode: "ALLOW_DELAY_DAYS", postingMaxDelayDays: 3 },
      pgdb,
    );
    assert.equal(result.postingMaxDelayDays, 3, "an edit unrelated to fee/commission must succeed even if stored fee data is already invalid");
  });

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("negotiationPolicy.db test failed:", err);
  process.exit(1);
});
