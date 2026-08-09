/**
 * PLU-153: ACTIVE → CLOSING transition + intake suppression, against a real
 * (pglite) database — the transition uses row-lock + CAS + a transaction, which
 * only a real DB exercises meaningfully.
 *
 * Run: node --import tsx --test src/db/campaignClosing.db.test.ts
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
  campaignIntakeError,
  getCampaignLifecycleCounts,
  transitionCampaignToClosing,
} from "./campaigns.js";
import { claimInitialOutreachSlot } from "./outboundPacing.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");

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
    const statements = splitSqlStatements(withoutComments);
    for (const statement of statements) await pg.exec(statement);
  }
}

async function freshDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  await applyPrismaMigrations(pg);
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { db, pg };
}

async function makeCampaign(
  db: Db,
  status: schema.CampaignStatus,
  overrides: Partial<schema.CampaignInsert> = {},
): Promise<schema.Campaign> {
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({ name: `PLU-153 ${status}`, brand: "Pluvus", status, ...overrides })
    .returning();
  return campaign!;
}

async function countClosingEvents(db: Db, campaignId: string): Promise<number> {
  const rows = await db
    .select()
    .from(schema.campaignAuditEvents)
    .where(
      and(
        eq(schema.campaignAuditEvents.campaignId, campaignId),
        eq(schema.campaignAuditEvents.eventType, "CLOSING"),
      ),
    );
  return rows.length;
}

test("ACTIVE → CLOSING sets status + writes exactly one CLOSING audit event", async () => {
  const { db, pg } = await freshDb();
  try {
    const campaign = await makeCampaign(db, "ACTIVE");
    const result = await transitionCampaignToClosing(
      campaign.id,
      { actorId: "operator", reason: "budget spent" },
      db,
    );
    assert.equal(result?.status, "closed");

    const [row] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaign.id));
    assert.equal(row!.status, "CLOSING");
    assert.equal(row!.archivedAt, null); // AC: close never archives

    const events = await db
      .select()
      .from(schema.campaignAuditEvents)
      .where(eq(schema.campaignAuditEvents.campaignId, campaign.id));
    const closing = events.filter((e) => e.eventType === "CLOSING");
    assert.equal(closing.length, 1);
    assert.equal(closing[0]!.actorId, "operator");
    assert.deepEqual(closing[0]!.payload, { reason: "budget spent" });
  } finally {
    await pg.close();
  }
});

test("repeated close is idempotent — already_closing, no second event", async () => {
  const { db, pg } = await freshDb();
  try {
    const campaign = await makeCampaign(db, "ACTIVE");
    await transitionCampaignToClosing(campaign.id, { actorId: "operator" }, db);
    const second = await transitionCampaignToClosing(
      campaign.id,
      { actorId: "operator", reason: "again" },
      db,
    );
    assert.equal(second?.status, "already_closing");
    assert.equal(await countClosingEvents(db, campaign.id), 1);
  } finally {
    await pg.close();
  }
});

test("DRAFT and ARCHIVED reject with invalid + write no event", async () => {
  const { db, pg } = await freshDb();
  try {
    const draft = await makeCampaign(db, "DRAFT");
    const draftResult = await transitionCampaignToClosing(
      draft.id,
      { actorId: "operator" },
      db,
    );
    assert.deepEqual(draftResult, { status: "invalid", from: "DRAFT" });
    assert.equal(await countClosingEvents(db, draft.id), 0);

    const archived = await makeCampaign(db, "ARCHIVED");
    const archivedResult = await transitionCampaignToClosing(
      archived.id,
      { actorId: "operator" },
      db,
    );
    assert.deepEqual(archivedResult, { status: "invalid", from: "ARCHIVED" });
    assert.equal(await countClosingEvents(db, archived.id), 0);
  } finally {
    await pg.close();
  }
});

test("transition returns null for a missing campaign", async () => {
  const { db, pg } = await freshDb();
  try {
    const result = await transitionCampaignToClosing("no-such-id", { actorId: "operator" }, db);
    assert.equal(result, null);
  } finally {
    await pg.close();
  }
});

test("concurrent close → exactly one closed + one event (row lock serializes)", async () => {
  const { db, pg } = await freshDb();
  try {
    const campaign = await makeCampaign(db, "ACTIVE");
    const [a, b] = await Promise.all([
      transitionCampaignToClosing(campaign.id, { actorId: "operator" }, db),
      transitionCampaignToClosing(campaign.id, { actorId: "operator" }, db),
    ]);
    const statuses = [a?.status, b?.status].sort();
    assert.deepEqual(statuses, ["already_closing", "closed"]);
    assert.equal(await countClosingEvents(db, campaign.id), 1);
  } finally {
    await pg.close();
  }
});

test("claimInitialOutreachSlot SUPPRESSES for a CLOSING campaign — even with null pacing/cap (B1)", async () => {
  const { db, pg } = await freshDb();
  try {
    // Legacy campaign: no cap, no pacing — proves the guard runs BEFORE the
    // all-null early return that would otherwise send.
    const campaign = await makeCampaign(db, "CLOSING");
    const [workflow] = await db
      .insert(schema.workflows)
      .values({ name: "Outreach", campaignId: campaign.id })
      .returning();
    const [version] = await db
      .insert(schema.workflowVersions)
      .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
      .returning();
    const [creator] = await db
      .insert(schema.creators)
      .values({ name: "C", email: "c@test.local" })
      .returning();
    const [instance] = await db
      .insert(schema.executionInstances)
      .values({
        workflowVersionId: version!.id,
        creatorId: creator!.id,
        currentState: "OUTREACH_QUEUED",
        currentNodeId: "outreach",
      })
      .returning();
    const [message] = await db
      .insert(schema.messages)
      .values({
        instanceId: instance!.id,
        direction: "OUTBOUND",
        body: "Hello",
        idempotencyKey: `outreach:${instance!.id}`,
      })
      .returning();

    const claim = await claimInitialOutreachSlot(message!.id, new Date(), () => 0, db);
    assert.deepEqual(claim, { status: "suppress", reason: "campaign_closing" });

    // No send happened: the message stays reserved-unsent.
    const [fresh] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, message!.id));
    assert.equal(fresh!.initialOutreachQuotaDay, null);
    assert.equal(fresh!.externalMessageId, null);
  } finally {
    await pg.close();
  }
});

test("claimInitialOutreachSlot on an ACTIVE campaign still sends (unchanged)", async () => {
  const { db, pg } = await freshDb();
  try {
    const campaign = await makeCampaign(db, "ACTIVE"); // null pacing/cap = legacy send-now
    const [workflow] = await db
      .insert(schema.workflows)
      .values({ name: "Outreach", campaignId: campaign.id })
      .returning();
    const [version] = await db
      .insert(schema.workflowVersions)
      .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
      .returning();
    const [creator] = await db
      .insert(schema.creators)
      .values({ name: "C", email: "c2@test.local" })
      .returning();
    const [instance] = await db
      .insert(schema.executionInstances)
      .values({
        workflowVersionId: version!.id,
        creatorId: creator!.id,
        currentState: "OUTREACH_QUEUED",
        currentNodeId: "outreach",
      })
      .returning();
    const [message] = await db
      .insert(schema.messages)
      .values({
        instanceId: instance!.id,
        direction: "OUTBOUND",
        body: "Hello",
        idempotencyKey: `outreach:${instance!.id}`,
      })
      .returning();

    const claim = await claimInitialOutreachSlot(message!.id, new Date(), () => 0, db);
    assert.equal(claim.status, "send");
  } finally {
    await pg.close();
  }
});

test("getCampaignLifecycleCounts: coarse in-progress excludes terminal states", async () => {
  const { db, pg } = await freshDb();
  try {
    const campaign = await makeCampaign(db, "CLOSING");
    const [workflow] = await db
      .insert(schema.workflows)
      .values({ name: "W", campaignId: campaign.id })
      .returning();
    const [version] = await db
      .insert(schema.workflowVersions)
      .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
      .returning();
    const states: schema.InstanceState[] = [
      "NEGOTIATING",
      "MANUAL_REVIEW",
      "MANUAL_REVIEW",
      "REJECTED", // terminal — excluded from in-progress
      "HANDOFF_COMPLETE", // terminal — excluded
    ];
    for (let i = 0; i < states.length; i++) {
      const [creator] = await db
        .insert(schema.creators)
        .values({ name: `C${i}`, email: `count-${i}@test.local` })
        .returning();
      await db.insert(schema.executionInstances).values({
        workflowVersionId: version!.id,
        creatorId: creator!.id,
        currentState: states[i]!,
        currentNodeId: "n",
      });
    }
    const counts = await getCampaignLifecycleCounts(campaign.id, db);
    assert.equal(counts.totalCreatorCount, 5);
    assert.equal(counts.inProgressCreatorCount, 3); // NEGOTIATING + 2 MANUAL_REVIEW
    assert.equal(counts.manualReviewCount, 2);
  } finally {
    await pg.close();
  }
});

test("campaignIntakeError: only ACTIVE accepts intake; null campaign allowed", () => {
  assert.equal(campaignIntakeError({ status: "ACTIVE" }), null);
  assert.equal(campaignIntakeError(null), null); // orphan/legacy workflow
  assert.match(campaignIntakeError({ status: "CLOSING" })!, /closing.*not accepting/);
  assert.match(campaignIntakeError({ status: "ARCHIVED" })!, /archived.*not accepting/);
  assert.match(campaignIntakeError({ status: "DRAFT" })!, /draft.*not accepting/);
});

test("both intake chokepoints (enroll + launch) are wired to campaignIntakeError", async () => {
  // The guard is a pure function (tested above); this pins that it stays wired
  // into BOTH routes — the enroll and launch handlers each fetch the campaign
  // and reject non-ACTIVE intake. Removing either call silently re-opens intake
  // on a Closing campaign.
  const src = readFileSync(
    resolve(__dirname, "../routes/workflows.ts"),
    "utf8",
  );
  const guardCalls = src.match(/campaignIntakeError\(/g) ?? [];
  // one import mention + one call in enroll + one call in launch = 3 references;
  // require at least the two call sites.
  assert.ok(
    guardCalls.length >= 2,
    `expected campaignIntakeError wired into both enroll + launch, found ${guardCalls.length}`,
  );
});
