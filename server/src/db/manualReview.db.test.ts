/**
 * PLU-154: manual-review resolution + timeout against a real (pglite) database.
 * The resolution is an OCC-CAS transition atomic with a DealHandoff insert + audit
 * events — only a real DB exercises that meaningfully.
 *
 * Run: node --import tsx --test src/db/manualReview.db.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import {
  resolveManualReviewCase,
  assertFeeWithinBand,
  findNegotiationPolicySnapshotById,
  listExpiredManualReviewCases,
  listManualReviewCasesForNudge,
  countNudges,
  getManualReviewCaseMeta,
  ManualReviewRaceError,
  BandViolationError,
} from "./manualReview.js";
import { sweepManualReviewTimeouts } from "../scheduler/manualReviewSweep.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");

// Statement splitter + migration runner copied from campaignClosing.db.test.ts
// (same repo convention — each DB test seeds its own pglite from the real DDL).
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let dollarTag: string | null = null;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          current += quote;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "$") {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        dollarTag = tag;
        current += tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function applyPrismaMigrations(pg: PGlite): Promise<void> {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
    const withoutComments = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of splitSqlStatements(withoutComments)) await pg.exec(statement);
  }
}

async function freshDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  await applyPrismaMigrations(pg);
  return { db: drizzle(pg, { schema }) as unknown as Db, pg };
}

interface CaseFixture {
  instanceId: string;
  creatorName: string;
  creatorEmail: string;
  snapshotId: string | null;
}

let seq = 0;
async function makeManualReviewCase(
  db: Db,
  opts: {
    postAcceptanceMode?: "local_payment" | "operator_handoff";
    dueAt?: Date | null;
    band?: { floorCents: number | null; ceilingCents: number | null };
  } = {},
): Promise<CaseFixture> {
  seq++;
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ name: `PLU-154 ${seq}`, brand: "Pluvus", status: "ACTIVE" })
    .returning();
  const [workflow] = await db
    .insert(schema.workflows)
    .values({ name: "WF", campaignId: campaign!.id })
    .returning();
  const [version] = await db
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [creator] = await db
    .insert(schema.creators)
    .values({ name: `Creator ${seq}`, email: `c${seq}@test.local` })
    .returning();

  let snapshotId: string | null = null;
  if (opts.band) {
    const [snap] = await db
      .insert(schema.negotiationPolicySnapshots)
      .values({
        campaignId: campaign!.id,
        floorCents: opts.band.floorCents,
        ceilingCents: opts.band.ceilingCents,
      })
      .returning();
    snapshotId = snap!.id;
  }

  const [instance] = await db
    .insert(schema.executionInstances)
    .values({
      workflowVersionId: version!.id,
      creatorId: creator!.id,
      currentState: "MANUAL_REVIEW",
      currentNodeId: "negotiation",
      postAcceptanceMode: opts.postAcceptanceMode ?? "operator_handoff",
      dueAt: opts.dueAt ?? null,
      negotiationPolicySnapshotId: snapshotId,
    })
    .returning();

  // A prior escalation event so "history preserved" assertions have something to
  // preserve.
  await db.insert(schema.events).values({
    instanceId: instance!.id,
    type: "MANUAL_REVIEW_FLAGGED",
    payload: { reason: "max_rounds_reached" },
  });

  return {
    instanceId: instance!.id,
    creatorName: creator!.name,
    creatorEmail: creator!.email,
    snapshotId,
  };
}

async function stateOf(db: Db, instanceId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(schema.executionInstances)
    .where(eq(schema.executionInstances.id, instanceId));
  return row!.currentState;
}

async function eventsOf(db: Db, instanceId: string, type: schema.EventType) {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.instanceId, instanceId), eq(schema.events.type, type)));
}

// ── 2. approve → NEEDS_DEAL_FINALIZATION + DealHandoff + one event ──────────
test("approve resolves to NEEDS_DEAL_FINALIZATION with a DealHandoff + audit event; idempotent", async () => {
  const { db, pg } = await freshDb();
  try {
    const c = await makeManualReviewCase(db);
    const updated = await resolveManualReviewCase(
      c.instanceId,
      {
        to: "NEEDS_DEAL_FINALIZATION",
        resolvedBy: "op@pluvus",
        reason: "approved",
        terms: { fixedFee: 500, commissionRate: 0.1, deliverables: "1 reel" },
        creator: { name: c.creatorName, email: c.creatorEmail },
        campaignName: "PLU-154",
      },
      db,
    );
    assert.equal(updated.currentState, "NEEDS_DEAL_FINALIZATION");
    assert.equal(updated.dueAt, null);
    assert.ok(updated.completedAt, "completedAt stamped");

    const [handoff] = await db
      .select()
      .from(schema.dealHandoffs)
      .where(eq(schema.dealHandoffs.instanceId, c.instanceId));
    assert.ok(handoff, "DealHandoff written");
    assert.equal(handoff!.fixedFee, 500);
    assert.equal(handoff!.commissionRate, 0.1);
    assert.equal(handoff!.creatorEmail, c.creatorEmail);
    assert.equal(handoff!.status, "AWAITING_FINALIZATION");

    const resolved = await eventsOf(db, c.instanceId, "MANUAL_REVIEW_RESOLVED");
    assert.equal(resolved.length, 1);
    const p = resolved[0]!.payload as Record<string, unknown>;
    assert.equal(p["outcome"], "NEEDS_DEAL_FINALIZATION");
    assert.equal(p["resolvedBy"], "op@pluvus");

    // Idempotency: the case has left MANUAL_REVIEW, so a second attempt loses the
    // OCC race → ManualReviewRaceError (route maps this to "return existing").
    await assert.rejects(
      () =>
        resolveManualReviewCase(
          c.instanceId,
          {
            to: "NEEDS_DEAL_FINALIZATION",
            resolvedBy: "op@pluvus",
            reason: "approved",
            creator: { name: c.creatorName, email: c.creatorEmail },
          },
          db,
        ),
      ManualReviewRaceError,
    );
    // Still exactly one resolution event + one handoff.
    assert.equal((await eventsOf(db, c.instanceId, "MANUAL_REVIEW_RESOLVED")).length, 1);
  } finally {
    await pg.close();
  }
});

// ── 3. reject / opt-out preserve prior history ──────────────────────────────
test("reject → REJECTED and opt-out → OPTED_OUT, preserving prior events", async () => {
  const { db, pg } = await freshDb();
  try {
    const r = await makeManualReviewCase(db);
    await resolveManualReviewCase(r.instanceId, { to: "REJECTED", resolvedBy: "op", reason: "not a fit" }, db);
    assert.equal(await stateOf(db, r.instanceId), "REJECTED");

    const o = await makeManualReviewCase(db);
    await resolveManualReviewCase(o.instanceId, { to: "OPTED_OUT", resolvedBy: "op", reason: "creator_withdrew" }, db);
    assert.equal(await stateOf(db, o.instanceId), "OPTED_OUT");

    // The original escalation event survives (append-only history).
    assert.equal((await eventsOf(db, r.instanceId, "MANUAL_REVIEW_FLAGGED")).length, 1);
    assert.equal((await eventsOf(db, o.instanceId, "MANUAL_REVIEW_FLAGGED")).length, 1);
  } finally {
    await pg.close();
  }
});

// ── 4. band validation + immutability ───────────────────────────────────────
test("approve fee outside the pinned band is rejected; approvedDeviation allows it; snapshot unchanged", async () => {
  const { db, pg } = await freshDb();
  try {
    const c = await makeManualReviewCase(db, { band: { floorCents: 20000, ceilingCents: 50000 } });
    const snapshot = await findNegotiationPolicySnapshotById(c.snapshotId!, db);

    // $600 > $500 ceiling → BandViolationError.
    assert.throws(() => assertFeeWithinBand({ fixedFee: 600 }, snapshot), BandViolationError);
    // In-band $400 is fine.
    assert.doesNotThrow(() => assertFeeWithinBand({ fixedFee: 400 }, snapshot));
    // Out-of-band but with an approved deviation → allowed.
    assert.doesNotThrow(() => assertFeeWithinBand({ fixedFee: 600, approvedDeviation: true }, snapshot));

    // The snapshot row is never written by resolution — immutable during MR.
    await resolveManualReviewCase(
      c.instanceId,
      {
        to: "NEEDS_DEAL_FINALIZATION",
        resolvedBy: "op",
        reason: "approved deviation",
        terms: { fixedFee: 600, approvedDeviation: true },
        creator: { name: c.creatorName, email: c.creatorEmail },
      },
      db,
    );
    const after = await findNegotiationPolicySnapshotById(c.snapshotId!, db);
    assert.equal(after!.floorCents, 20000);
    assert.equal(after!.ceilingCents, 50000);
  } finally {
    await pg.close();
  }
});

// ── 5. concurrent approve vs reject → exactly one wins ──────────────────────
test("concurrent approve vs reject: exactly one wins (OCC), the other gets a race error", async () => {
  const { db, pg } = await freshDb();
  try {
    const c = await makeManualReviewCase(db);
    const results = await Promise.allSettled([
      resolveManualReviewCase(
        c.instanceId,
        { to: "NEEDS_DEAL_FINALIZATION", resolvedBy: "a", reason: "approve", creator: { name: c.creatorName, email: c.creatorEmail } },
        db,
      ),
      resolveManualReviewCase(c.instanceId, { to: "REJECTED", resolvedBy: "b", reason: "reject" }, db),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one resolution won");
    assert.equal(rejected.length, 1, "the loser errored");
    // Exactly one resolution event recorded (the winner's).
    assert.equal((await eventsOf(db, c.instanceId, "MANUAL_REVIEW_RESOLVED")).length, 1);
  } finally {
    await pg.close();
  }
});

// ── 6/7. timeout sweep → EXPIRED (not NO_RESPONSE); untouched when not due ───
test("timeout sweep expires a past-deadline case to EXPIRED; leaves a future one; human wins the race", async () => {
  const { db, pg } = await freshDb();
  try {
    const now = new Date("2026-08-09T00:00:00.000Z");
    const past = await makeManualReviewCase(db, { dueAt: new Date(now.getTime() - 1000) });
    const future = await makeManualReviewCase(db, { dueAt: new Date(now.getTime() + 86400000) });

    // Minimal deps: real DB queries + resolve, no-op notifier/email (nudge path
    // won't fire for the past case; future case's deadline is a day out).
    const deps = {
      listExpiredManualReviewCases: (a: { now: Date; limit?: number }) => listExpiredManualReviewCases(a, db),
      listManualReviewCasesForNudge: async () => [],
      countNudges: (id: string) => countNudges(id, db),
      resolveManualReviewCase: (id: string, input: Parameters<typeof resolveManualReviewCase>[1]) =>
        resolveManualReviewCase(id, input, db),
      notifyBrandOfEscalation: async () => ({}),
      appendEvent: (data: Parameters<typeof import("./events.js").appendEvent>[0]) =>
        db.insert(schema.events).values(data).returning().then((r) => r[0]!),
      email: () => ({}) as never,
      now: () => now,
    };

    const result = await sweepManualReviewTimeouts(deps as never);
    assert.equal(result.expired, 1);
    assert.equal(await stateOf(db, past.instanceId), "EXPIRED");
    assert.notEqual(await stateOf(db, past.instanceId), "NO_RESPONSE");
    assert.equal(await stateOf(db, future.instanceId), "MANUAL_REVIEW"); // not due

    // A MANUAL_REVIEW_EXPIRED marker was written.
    assert.equal((await eventsOf(db, past.instanceId, "MANUAL_REVIEW_EXPIRED")).length, 1);

    // Human-wins determinism: resolve the future case, then sweep with it "expired"
    // — the OCC CAS loses (already terminal) and the sweep no-ops on it.
    await resolveManualReviewCase(future.instanceId, { to: "REJECTED", resolvedBy: "human", reason: "reject" }, db);
    const later = { ...deps, now: () => new Date(now.getTime() + 2 * 86400000) };
    const second = await sweepManualReviewTimeouts(later as never);
    assert.equal(second.expired, 0, "human-resolved case is not re-expired");
    assert.equal(await stateOf(db, future.instanceId), "REJECTED");
  } finally {
    await pg.close();
  }
});

test("sweep is a no-op when no case is due (empty queue)", async () => {
  const { db, pg } = await freshDb();
  try {
    const now = new Date("2026-08-09T00:00:00.000Z");
    // A case whose deadline is well in the future — not due to expire OR nudge.
    await makeManualReviewCase(db, { dueAt: new Date(now.getTime() + 30 * 86400000) });
    const deps = {
      listExpiredManualReviewCases: (a: { now: Date; limit?: number }) => listExpiredManualReviewCases(a, db),
      listManualReviewCasesForNudge: (a: { now: Date; limit?: number }) => listManualReviewCasesForNudge(a, db),
      countNudges: (id: string) => countNudges(id, db),
      resolveManualReviewCase: (id: string, input: Parameters<typeof resolveManualReviewCase>[1]) =>
        resolveManualReviewCase(id, input, db),
      notifyBrandOfEscalation: async () => ({}),
      appendEvent: (data: Parameters<typeof import("./events.js").appendEvent>[0]) =>
        db.insert(schema.events).values(data).returning().then((r) => r[0]!),
      email: () => ({}) as never,
      now: () => now,
    };
    const result = await sweepManualReviewTimeouts(deps as never);
    assert.deepEqual(result, { expired: 0, nudged: 0 });
  } finally {
    await pg.close();
  }
});

// ── case meta (deadline + nudge count) ──────────────────────────────────────
test("getManualReviewCaseMeta counts ONLY MANUAL_REVIEW_NUDGED events", async () => {
  const { db, pg } = await freshDb();
  try {
    const c = await makeManualReviewCase(db, { dueAt: new Date("2026-08-16T00:00:00.000Z") });
    // A BRAND_NOTIFIED event must NOT be counted as a nudge (the plan's defect 7).
    await db.insert(schema.events).values({ instanceId: c.instanceId, type: "BRAND_NOTIFIED", payload: {} });
    await db.insert(schema.events).values({ instanceId: c.instanceId, type: "MANUAL_REVIEW_NUDGED", payload: { nudgeNumber: 1 } });

    const [inst] = await db
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, c.instanceId));
    const allEvents = await db.select().from(schema.events).where(eq(schema.events.instanceId, c.instanceId));
    const meta = getManualReviewCaseMeta(inst!, allEvents);
    assert.equal(meta.nudgeCount, 1);
    assert.ok(meta.deadline, "deadline surfaced");
  } finally {
    await pg.close();
  }
});
