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
import { upsertNegotiationPolicy } from "./negotiationPolicy.js";
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

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("negotiationPolicy.db test failed:", err);
  process.exit(1);
});
