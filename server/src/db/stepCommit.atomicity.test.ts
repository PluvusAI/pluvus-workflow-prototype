/**
 * W-7 atomicity test — the OCC state write and the money-trail event append
 * commit together or not at all.
 *
 * runtime.stepInstance now wraps its conditional state update AND the follow-on
 * event appends (the domain event + the STATE_TRANSITION event) in ONE
 * db.transaction. Before this, a crash after the state write but before the
 * NEGOTIATION_TURN append could commit an ACCEPT whose agreed rate — recovered
 * exclusively by replaying NEGOTIATION_TURN events — was lost, forcing a
 * `no_agreed_fee` escalation on a deal that had actually closed.
 *
 * This test proves the guarantee at the DB layer, on the REAL schema (PGlite +
 * every Prisma migration applied), using the same injectable-client seam the
 * runtime uses: it runs a transaction that performs the conditional update and
 * then throws, and asserts NEITHER the state change NOR the event survive.
 *
 * Run:  npx tsx --test src/db/stepCommit.atomicity.test.ts
 */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { updateInstanceStateConditional } from "./instances.js";
import { appendEvent } from "./events.js";
import type { Db } from "./drizzle.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const migrated = await applyPGliteMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: "W-7 Atomicity Workflow" })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();

  // ExecutionInstance is UNIQUE on (workflowVersionId, creatorId), so each
  // negotiating instance a case needs gets its own fresh creator.
  let seq = 0;
  async function seedNegotiatingInstance(): Promise<string> {
    seq++;
    const [creator] = await pgdb
      .insert(schema.creators)
      .values({ name: `Atomicity Creator ${seq}`, email: `w7-atomic-${seq}@test.local` })
      .returning();
    const [inst] = await pgdb
      .insert(schema.executionInstances)
      .values({
        workflowVersionId: version!.id,
        creatorId: creator!.id,
        currentState: "NEGOTIATING",
      })
      .returning();
    return inst!.id;
  }

  const instId = await seedNegotiatingInstance();

  async function currentState(): Promise<string> {
    const [row] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, instId));
    return row!.currentState;
  }

  await test("happy path: state write + money-trail append commit together", async () => {
    await pgdb.transaction(async (tx) => {
      const row = await updateInstanceStateConditional(
        instId,
        "NEGOTIATING",
        { currentState: "ACCEPTED" },
        tx,
      );
      assert.ok(row, "OCC update won inside the tx");
      await appendEvent(
        {
          instanceId: instId,
          type: "NEGOTIATION_TURN",
          nodeId: "node-negotiate",
          // The agreed rate — the money trail depends on this event.
          payload: { outcome: "ACCEPT", round: 2, currentOffer: 450 },
        },
        tx,
      );
    });

    assert.equal(await currentState(), "ACCEPTED", "state committed");
    const turns = await pgdb
      .select()
      .from(schema.events)
      .where(
        and(eq(schema.events.instanceId, instId), eq(schema.events.type, "NEGOTIATION_TURN")),
      );
    assert.equal(turns.length, 1, "the ACCEPT NEGOTIATION_TURN committed with the state");
    assert.equal(
      (turns[0]!.payload as Record<string, unknown>)["currentOffer"],
      450,
      "agreed rate is recoverable from the event log",
    );
  });

  await test("crash after state write, before append → BOTH roll back", async () => {
    // Re-seed a fresh negotiating instance to isolate this case.
    const id2 = await seedNegotiatingInstance();

    const before = (
      await pgdb.select().from(schema.events).where(eq(schema.events.instanceId, id2))
    ).length;

    await assert.rejects(
      pgdb.transaction(async (tx) => {
        const row = await updateInstanceStateConditional(
          id2,
          "NEGOTIATING",
          { currentState: "ACCEPTED" },
          tx,
        );
        assert.ok(row, "OCC update matched inside the tx");
        // Simulate a crash between the state commit and the money-trail append —
        // exactly the W-7 window. The transaction must roll the state write back.
        throw new Error("simulated crash before money-trail append");
      }),
      /simulated crash/,
    );

    const [row2] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, id2));
    assert.equal(
      row2!.currentState,
      "NEGOTIATING",
      "state write rolled back — instance never silently entered ACCEPTED without a money trail",
    );
    const after = (
      await pgdb.select().from(schema.events).where(eq(schema.events.instanceId, id2))
    ).length;
    assert.equal(after, before, "no partial event was left behind");
  });

  await test("append failure rolls back an already-succeeded state write", async () => {
    const id3 = await seedNegotiatingInstance();

    await assert.rejects(
      pgdb.transaction(async (tx) => {
        await updateInstanceStateConditional(id3, "NEGOTIATING", { currentState: "ACCEPTED" }, tx);
        // A NOT NULL violation on `type` stands in for any append failure — the
        // point is that a failed append undoes the committed state write.
        await appendEvent(
          {
            instanceId: id3,
            // @ts-expect-error deliberately invalid to force a DB error inside the tx
            type: null,
            nodeId: "node-negotiate",
            payload: { outcome: "ACCEPT" },
          },
          tx,
        );
      }),
    );

    const [row3] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, id3));
    assert.equal(row3!.currentState, "NEGOTIATING", "state rolled back when the append failed");
  });

  await pg.close();
  console.log(`\n${n} passed\n`);
}

await main();
