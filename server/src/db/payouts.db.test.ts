/**
 * DB-backed tests for the payout ledger (Phase 3) — the transactional creators,
 * every status-guard rejection, refunded/locked exclusion, obligation double-pay
 * block, and auto-settle selection. Runs against a REAL Postgres (PGlite,
 * embedded) with the REAL schema (every Prisma migration applied verbatim), so
 * the tables, enums, and constraints are byte-identical to live Neon.
 *
 * The true CONCURRENCY proof (two parallel commission creations → exactly one
 * payout) needs two real connections contending on a FOR UPDATE lock, which
 * PGlite's single connection cannot demonstrate — that lives in the payouts
 * harness (engine/payouts.harness.ts), driven against the real Neon DB.
 *
 * Run:  npx tsx --test src/db/payouts.db.test.ts   (or via npm test)
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  createCommissionPayout,
  createFixedFeePayout,
  NoUnpaidCommissionError,
  ObligationNotPayableError,
  findPayoutById,
  listPayoutsByPartnership,
  markPayoutSent,
  markPayoutConfirmed,
  markPayoutDisputed,
  markPayoutSettled,
  autoSettlePayout,
  listSentPayoutsOlderThan,
} from "./payouts.js";
import { createObligation } from "./obligations.js";
import { appendEvent } from "./events.js";
import { markConversionRefunded } from "./conversions.js";
import { isUniqueViolation } from "./errors.js";
import { mintFeeObligation } from "../engine/executors/partnership.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Seed a Partnership (via instance/creator/workflow chain) so the payout FKs
// resolve. Returns the partnership id + instance id.
async function seedPartnership(
  pgdb: Db,
  opts: { agreedFeeCents?: number | null; suffix: string },
): Promise<{ partnershipId: string; instanceId: string }> {
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Payout Test", email: `payout-${opts.suffix}@test.local` })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: `Payout WF ${opts.suffix}` })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: version!.id, creatorId: creator!.id })
    .returning();
  const [partnership] = await pgdb
    .insert(schema.partnerships)
    .values({
      instanceId: instance!.id,
      creatorId: creator!.id,
      referralCode: `code-${opts.suffix}`,
      agreedFeeCents: opts.agreedFeeCents ?? null,
    })
    .returning();
  return { partnershipId: partnership!.id, instanceId: instance!.id };
}

async function seedConversion(
  pgdb: Db,
  p: { partnershipId: string; externalId: string; commissionCents: number; refunded?: boolean; payoutId?: string | null },
): Promise<string> {
  const [row] = await pgdb
    .insert(schema.conversions)
    .values({
      partnershipId: p.partnershipId,
      referralCode: "code",
      externalId: p.externalId,
      valueCents: 10000,
      commissionCents: p.commissionCents,
      refunded: p.refunded ?? false,
      payoutId: p.payoutId ?? null,
    })
    .returning();
  return row!.id;
}

const DEST = { method: "PAYPAL" as const, destination: "creator@paypal.me" };

async function main(): Promise<void> {
  console.log("\npayouts.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── Commission payout: sum + count + lock ──────────────────────────────────
  await test("commission payout sums commissionCents, counts, and locks conversions", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "comm1" });
    await seedConversion(pgdb, { partnershipId, externalId: "c1", commissionCents: 250 });
    await seedConversion(pgdb, { partnershipId, externalId: "c2", commissionCents: 750 });

    const payout = await createCommissionPayout(partnershipId, DEST, pgdb);
    assert.equal(payout.payoutType, "COMMISSION");
    assert.equal(payout.amountCents, 1000, "sum of 250 + 750");
    assert.equal(payout.conversionCount, 2);
    assert.equal(payout.status, "PENDING");
    assert.equal(payout.method, "PAYPAL");
    assert.equal(payout.destination, "creator@paypal.me");

    // Both conversions are now locked into this payout.
    const convs = await pgdb
      .select()
      .from(schema.conversions)
      .where(eq(schema.conversions.partnershipId, partnershipId));
    assert.equal(convs.length, 2);
    assert.ok(convs.every((c) => c.payoutId === payout.id), "every conversion locked into the payout");
  });

  // ── Refunded + already-locked conversions are excluded ─────────────────────
  await test("commission excludes refunded, already-locked, and zero-commission conversions", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "comm2" });
    await seedConversion(pgdb, { partnershipId, externalId: "ok", commissionCents: 500 });
    await seedConversion(pgdb, { partnershipId, externalId: "refunded", commissionCents: 999, refunded: true });
    await seedConversion(pgdb, { partnershipId, externalId: "locked", commissionCents: 999, payoutId: "some-other-payout" });
    await seedConversion(pgdb, { partnershipId, externalId: "zero", commissionCents: 0 });

    const payout = await createCommissionPayout(partnershipId, DEST, pgdb);
    assert.equal(payout.amountCents, 500, "only the one eligible conversion counts");
    assert.equal(payout.conversionCount, 1);
  });

  // ── No unpaid commission → rejection, no payout row created ─────────────────
  await test("commission with no eligible conversions throws NoUnpaidCommissionError (no payout)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "comm3" });
    await seedConversion(pgdb, { partnershipId, externalId: "r", commissionCents: 100, refunded: true });

    await assert.rejects(
      () => createCommissionPayout(partnershipId, DEST, pgdb),
      (err) => err instanceof NoUnpaidCommissionError,
    );
    const payouts = await pgdb
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.partnershipId, partnershipId));
    assert.equal(payouts.length, 0, "rollback left no payout row");
  });

  // ── A second commission create pays nothing (all already locked) ────────────
  await test("second commission create finds nothing unpaid → rejects (never double-pays)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "comm4" });
    await seedConversion(pgdb, { partnershipId, externalId: "d1", commissionCents: 300 });
    const first = await createCommissionPayout(partnershipId, DEST, pgdb);
    assert.equal(first.amountCents, 300);

    await assert.rejects(
      () => createCommissionPayout(partnershipId, DEST, pgdb),
      (err) => err instanceof NoUnpaidCommissionError,
    );
    const payouts = await pgdb
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.partnershipId, partnershipId));
    assert.equal(payouts.length, 1, "still exactly one payout after a second attempt");
  });

  // ── Fixed-fee payout + obligation status guard ─────────────────────────────
  await test("fixed-fee payout pays the obligation and flips it PAID + links it", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "fee1", agreedFeeCents: 42000 });
    const ob = await createObligation(
      { partnershipId, description: "Agreed collaboration fee", amountCents: 42000 },
      pgdb,
    );
    const payout = await createFixedFeePayout(ob.id, DEST, pgdb);
    assert.equal(payout.payoutType, "FIXED_FEE");
    assert.equal(payout.amountCents, 42000);
    assert.equal(payout.conversionCount, 0);

    const [after] = await pgdb
      .select()
      .from(schema.obligations)
      .where(eq(schema.obligations.id, ob.id));
    assert.equal(after!.status, "PAID");
    assert.equal(after!.payoutId, payout.id);
    assert.ok(after!.paidAt, "paidAt stamped");
  });

  await test("fixed-fee double-pay is blocked (obligation already PAID)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "fee2", agreedFeeCents: 10000 });
    const ob = await createObligation(
      { partnershipId, description: "Agreed collaboration fee", amountCents: 10000 },
      pgdb,
    );
    await createFixedFeePayout(ob.id, DEST, pgdb);

    await assert.rejects(
      () => createFixedFeePayout(ob.id, DEST, pgdb),
      (err) => err instanceof ObligationNotPayableError && (err as ObligationNotPayableError).currentStatus === "PAID",
    );
    const payouts = await pgdb
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.partnershipId, partnershipId));
    assert.equal(payouts.length, 1, "the second attempt created no second payout");
  });

  // ── BUG-D1: DB backstop against a double-minted fee obligation ─────────────
  await test("second fee Obligation for a partnership is rejected by the unique index (BUG-D1)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "d1", agreedFeeCents: 30000 });
    // First auto-minted fee obligation: fine.
    await createObligation(
      { partnershipId, description: "Agreed collaboration fee", amountCents: 30000 },
      pgdb,
    );
    // Second "Agreed collaboration fee" row for the SAME partnership — the exact
    // shape the mint race would produce — must be rejected by the partial unique
    // index (not silently double-inserted, which is the double-fee bug).
    await assert.rejects(
      () =>
        createObligation(
          { partnershipId, description: "Agreed collaboration fee", amountCents: 30000 },
          pgdb,
        ),
      (err) => isUniqueViolation(err),
      "a second fee obligation must raise a unique violation",
    );
    const rows = await pgdb
      .select()
      .from(schema.obligations)
      .where(eq(schema.obligations.partnershipId, partnershipId));
    assert.equal(rows.length, 1, "exactly one fee obligation exists (no double-fee)");
  });

  await test("the fee unique index is PARTIAL — a differently-described obligation is still allowed (BUG-D1)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "d1b", agreedFeeCents: 20000 });
    await createObligation(
      { partnershipId, description: "Agreed collaboration fee", amountCents: 20000 },
      pgdb,
    );
    // A manual/extra obligation (different description) is NOT the auto-minted fee
    // row, so the partial index does not constrain it — future Phase-4+ manual
    // obligations must remain possible.
    await createObligation(
      { partnershipId, description: "Bonus for extra deliverable", amountCents: 5000 },
      pgdb,
    );
    const rows = await pgdb
      .select()
      .from(schema.obligations)
      .where(eq(schema.obligations.partnershipId, partnershipId));
    assert.equal(rows.length, 2, "the fee row + a distinct manual row both persist");
  });

  // ── BUG-D-events: money mutation + ledger event are atomic (one txn) ────────
  // The routes now wrap the money mutation and its audit event append in ONE
  // db.transaction (the injectable client). These tests replicate that exact
  // pattern against real Postgres to prove the two commit together — and, more
  // importantly, that a FAILED event append ROLLS BACK the money mutation (the
  // property the old best-effort/swallowed append could not guarantee).
  await test("fixed-fee payout + PAYOUT_CREATED event commit together (BUG-D-events)", async () => {
    const { partnershipId, instanceId } = await seedPartnership(pgdb, {
      suffix: "dev1",
      agreedFeeCents: 25000,
    });
    const ob = await createObligation(
      { partnershipId, description: "Agreed collaboration fee", amountCents: 25000 },
      pgdb,
    );
    const payout = await pgdb.transaction(async (tx) => {
      const p = await createFixedFeePayout(ob.id, DEST, tx);
      await appendEvent(
        {
          instanceId,
          type: "PAYOUT_CREATED",
          payload: { payoutId: p.id, payoutType: p.payoutType, amountCents: p.amountCents },
        },
        tx,
      );
      return p;
    });
    // Both landed.
    assert.ok(await findPayoutById(payout.id, pgdb), "payout row committed");
    const evs = await pgdb
      .select()
      .from(schema.events)
      .where(
        and(eq(schema.events.instanceId, instanceId), eq(schema.events.type, "PAYOUT_CREATED")),
      );
    assert.equal(evs.length, 1, "exactly one PAYOUT_CREATED event committed with the payout");
  });

  await test("a failing ledger event ROLLS BACK the money mutation (BUG-D-events)", async () => {
    const { partnershipId, instanceId } = await seedPartnership(pgdb, {
      suffix: "dev2",
      agreedFeeCents: 25000,
    });
    const ob = await createObligation(
      { partnershipId, description: "Agreed collaboration fee", amountCents: 25000 },
      pgdb,
    );
    // Force the event append to fail INSIDE the txn (a bad instanceId violates the
    // Event.instanceId FK). The whole unit must roll back — no payout, and the
    // obligation must stay PENDING (createFixedFeePayout flips it PAID in the txn).
    await assert.rejects(
      () =>
        pgdb.transaction(async (tx) => {
          await createFixedFeePayout(ob.id, DEST, tx);
          await appendEvent(
            {
              instanceId: "does-not-exist",
              type: "PAYOUT_CREATED",
              payload: {},
            },
            tx,
          );
        }),
      "the FK violation on the event must reject the transaction",
    );
    const payouts = await listPayoutsByPartnership(partnershipId, pgdb);
    assert.equal(payouts.length, 0, "no payout committed (money mutation rolled back)");
    const [after] = await pgdb
      .select()
      .from(schema.obligations)
      .where(eq(schema.obligations.id, ob.id));
    assert.equal(after!.status, "PENDING", "obligation stayed PENDING (not left half-paid)");
    void instanceId;
  });

  await test("conversion refund + CONVERSION_REFUNDED event commit together (BUG-D-events)", async () => {
    const { partnershipId, instanceId } = await seedPartnership(pgdb, { suffix: "dev3" });
    const convId = await seedConversion(pgdb, {
      partnershipId,
      externalId: "dev3-c1",
      commissionCents: 500,
    });
    await pgdb.transaction(async (tx) => {
      await markConversionRefunded(convId, tx);
      await appendEvent(
        {
          instanceId,
          type: "CONVERSION_REFUNDED",
          payload: { conversionId: convId },
        },
        tx,
      );
    });
    const [conv] = await pgdb
      .select()
      .from(schema.conversions)
      .where(eq(schema.conversions.id, convId));
    assert.equal(conv!.refunded, true, "conversion is refunded");
    const evs = await pgdb
      .select()
      .from(schema.events)
      .where(
        and(eq(schema.events.instanceId, instanceId), eq(schema.events.type, "CONVERSION_REFUNDED")),
      );
    assert.equal(evs.length, 1, "the refund event committed with the refund");
  });

  // ── Status-guard rejections on the transitions ─────────────────────────────
  await test("markPayoutSent only fires from PENDING (a second send is a no-op null)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "guard1" });
    await seedConversion(pgdb, { partnershipId, externalId: "g1", commissionCents: 100 });
    const payout = await createCommissionPayout(partnershipId, DEST, pgdb);

    const sent = await markPayoutSent(
      payout.id,
      { confirmTokenHash: "hash", confirmTokenExpiresAt: new Date(Date.now() + 1e9), reference: "TXN", note: null },
      pgdb,
    );
    assert.ok(sent, "first send from PENDING succeeds");
    assert.equal(sent!.status, "SENT");

    const again = await markPayoutSent(
      payout.id,
      { confirmTokenHash: "hash2", confirmTokenExpiresAt: new Date(Date.now() + 1e9), reference: "TXN2", note: null },
      pgdb,
    );
    assert.equal(again, null, "a second send (not PENDING) is a no-op null");
  });

  await test("settle only fires from CONFIRMED|DISPUTED (settle from PENDING/SENT is null)", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "guard2" });
    await seedConversion(pgdb, { partnershipId, externalId: "g2", commissionCents: 100 });
    const payout = await createCommissionPayout(partnershipId, DEST, pgdb);

    assert.equal(await markPayoutSettled(payout.id, pgdb), null, "settle from PENDING is null");

    await markPayoutSent(
      payout.id,
      { confirmTokenHash: "h", confirmTokenExpiresAt: new Date(Date.now() + 1e9), reference: null, note: null },
      pgdb,
    );
    assert.equal(await markPayoutSettled(payout.id, pgdb), null, "settle from SENT is null");

    // Move to DISPUTED, then settle succeeds.
    await markPayoutDisputed(payout.id, { confirmIp: null, confirmUserAgent: null }, pgdb);
    const settled = await markPayoutSettled(payout.id, pgdb);
    assert.ok(settled, "settle from DISPUTED succeeds");
    assert.equal(settled!.status, "SETTLED");
  });

  await test("confirm only fires from SENT; a dispute after confirm is a no-op null", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "guard3" });
    await seedConversion(pgdb, { partnershipId, externalId: "g3", commissionCents: 100 });
    const payout = await createCommissionPayout(partnershipId, DEST, pgdb);

    // confirm from PENDING → null (must be SENT)
    assert.equal(
      await markPayoutConfirmed(payout.id, { confirmIp: null, confirmUserAgent: null }, pgdb),
      null,
      "confirm from PENDING is null",
    );

    await markPayoutSent(
      payout.id,
      { confirmTokenHash: "h", confirmTokenExpiresAt: new Date(Date.now() + 1e9), reference: null, note: null },
      pgdb,
    );
    const confirmed = await markPayoutConfirmed(
      payout.id,
      { confirmIp: "1.2.3.4", confirmUserAgent: "UA" },
      pgdb,
    );
    assert.ok(confirmed, "confirm from SENT succeeds");
    assert.equal(confirmed!.status, "SETTLED", "confirm short-circuits straight to SETTLED");
    assert.ok(confirmed!.confirmedAt && confirmed!.settledAt, "confirmedAt + settledAt stamped");
    assert.equal(confirmed!.confirmIp, "1.2.3.4");

    // dispute after confirm → no-op (no longer SENT)
    assert.equal(
      await markPayoutDisputed(payout.id, { confirmIp: null, confirmUserAgent: null }, pgdb),
      null,
      "dispute after confirm is a no-op null",
    );
  });

  // ── Auto-settle selection ──────────────────────────────────────────────────
  await test("auto-settle picks only SENT payouts older than the cutoff", async () => {
    const { partnershipId } = await seedPartnership(pgdb, { suffix: "sweep1" });
    await seedConversion(pgdb, { partnershipId, externalId: "s1", commissionCents: 100 });
    await seedConversion(pgdb, { partnershipId, externalId: "s2", commissionCents: 200 });
    await seedConversion(pgdb, { partnershipId, externalId: "s3", commissionCents: 300 });

    // Old SENT (eligible)
    const oldP = await createCommissionPayout(partnershipId, DEST, pgdb);
    await markPayoutSent(
      oldP.id,
      { confirmTokenHash: "h", confirmTokenExpiresAt: new Date(Date.now() + 1e9), reference: null, note: null },
      pgdb,
    );
    // Backdate its sentAt to 10 days ago.
    await pgdb
      .update(schema.payouts)
      .set({ sentAt: new Date(Date.now() - 10 * 864e5) })
      .where(eq(schema.payouts.id, oldP.id));

    const cutoff = new Date(Date.now() - 7 * 864e5);
    const eligible = await listSentPayoutsOlderThan(cutoff, pgdb);
    assert.equal(eligible.length, 1, "only the backdated SENT payout is eligible");
    assert.equal(eligible[0]!.id, oldP.id);

    const settled = await autoSettlePayout(oldP.id, pgdb);
    assert.ok(settled && settled.status === "SETTLED", "auto-settle flips it SETTLED");

    // A fresh SENT payout is NOT eligible.
    const { partnershipId: p2 } = await seedPartnership(pgdb, { suffix: "sweep2" });
    await seedConversion(pgdb, { partnershipId: p2, externalId: "s4", commissionCents: 400 });
    const freshP = await createCommissionPayout(p2, DEST, pgdb);
    await markPayoutSent(
      freshP.id,
      { confirmTokenHash: "h", confirmTokenExpiresAt: new Date(Date.now() + 1e9), reference: null, note: null },
      pgdb,
    );
    const eligible2 = await listSentPayoutsOlderThan(cutoff, pgdb);
    assert.ok(!eligible2.some((p) => p.id === freshP.id), "a fresh SENT payout is not swept");
  });

  // ── mintFeeObligation guard: zero/negative/null fee mints nothing ──────────
  // These paths short-circuit before any DB access, so they run without the
  // module db. A positive fee then mints exactly one obligation (idempotent).
  await test("mintFeeObligation mints nothing for null/zero/negative fees", async () => {
    assert.equal(await mintFeeObligation("unused", null), false, "null fee → no mint");
    assert.equal(await mintFeeObligation("unused", undefined), false, "undefined fee → no mint");
    assert.equal(await mintFeeObligation("unused", 0), false, "$0.00 fee → no mint (no spurious $0 obligation)");
    assert.equal(await mintFeeObligation("unused", -50), false, "negative fee → no mint");
  });

  console.log(`\n${n} passed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("payouts.db test failed:", err);
  process.exit(1);
});
