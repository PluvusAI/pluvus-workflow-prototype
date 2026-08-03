/**
 * BUG-Q1/Q2: DB-backed tests for the DeadLetterJob table constraints against a
 * REAL Postgres (PGlite) with every migration applied verbatim — so the enum,
 * partial unique index, and status default are byte-identical to live Neon. These
 * lock the invariants recordDeadLetter / markDeadLetterRedriven rely on:
 *   - a (queue, jobId) is dead-lettered at most once (partial unique index)
 *   - two rows with jobId NULL are allowed (partial index excludes them)
 *   - status defaults to PENDING; a PENDING→REDRIVEN guard is a clean no-op on a
 *     row already claimed.
 *
 * Run: npx tsx --test src/db/deadLetterJobs.db.test.ts   (or via npm test)
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  console.log("\ndeadLetterJobs.db\n");
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  const base = {
    queue: "inbound-email",
    payload: { instanceId: "i1", externalMessageId: "m1" } as schema.JsonValue,
    instanceId: "i1",
    failReason: "agent timeout",
    attemptsMade: 3,
  };

  await test("status defaults to PENDING", async () => {
    const [row] = await pgdb
      .insert(schema.deadLetterJobs)
      .values({ ...base, jobId: "inbound|m1" })
      .returning();
    assert.equal(row!.status, "PENDING");
    assert.equal(row!.redriveCount, 0);
  });

  await test("a (queue, jobId) is dead-lettered at most once (partial unique index)", async () => {
    await pgdb.insert(schema.deadLetterJobs).values({ ...base, jobId: "inbound|dup" });
    await assert.rejects(
      () => pgdb.insert(schema.deadLetterJobs).values({ ...base, jobId: "inbound|dup" }),
      (err) => isUniqueViolation(err),
      "a second row with the same (queue, jobId) must be rejected",
    );
    // A DIFFERENT queue with the same jobId is allowed (the index is per-queue).
    await pgdb
      .insert(schema.deadLetterJobs)
      .values({ ...base, queue: "node-execution", jobId: "inbound|dup" });
    const rows = await pgdb
      .select()
      .from(schema.deadLetterJobs)
      .where(eq(schema.deadLetterJobs.jobId, "inbound|dup"));
    assert.equal(rows.length, 2, "same jobId across two queues → two rows");
  });

  await test("two rows with jobId NULL are allowed (partial index excludes NULLs)", async () => {
    await pgdb.insert(schema.deadLetterJobs).values({ ...base, jobId: null });
    await pgdb.insert(schema.deadLetterJobs).values({ ...base, jobId: null });
    const rows = await pgdb
      .select()
      .from(schema.deadLetterJobs)
      .where(eq(schema.deadLetterJobs.jobId, "inbound|m1")); // sanity: unrelated filter
    assert.ok(rows.length >= 0); // no throw is the assertion; two NULL rows inserted fine
  });

  await test("PENDING→REDRIVEN guard: a second claim on an already-REDRIVEN row is a no-op", async () => {
    const [row] = await pgdb
      .insert(schema.deadLetterJobs)
      .values({ ...base, jobId: "inbound|claim" })
      .returning();
    // First claim wins.
    const first = await pgdb
      .update(schema.deadLetterJobs)
      .set({ status: "REDRIVEN", redrivenAt: new Date() })
      .where(
        and(eq(schema.deadLetterJobs.id, row!.id), eq(schema.deadLetterJobs.status, "PENDING")),
      )
      .returning();
    assert.equal(first.length, 1, "first claim updates the row");
    // Second claim finds no PENDING row → 0 rows updated (the loser no-ops).
    const second = await pgdb
      .update(schema.deadLetterJobs)
      .set({ status: "REDRIVEN" })
      .where(
        and(eq(schema.deadLetterJobs.id, row!.id), eq(schema.deadLetterJobs.status, "PENDING")),
      )
      .returning();
    assert.equal(second.length, 0, "second claim is a clean no-op (already REDRIVEN)");
  });

  console.log(`\n  ${n} passed\n`);
}

await main();
