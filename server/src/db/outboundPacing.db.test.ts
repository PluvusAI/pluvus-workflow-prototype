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
  claimInitialOutreachSlot,
  completeQueuedInitialOutreach,
} from "./outboundPacing.js";

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

test("initial-outreach claims enforce UTC cap, pacing, retries, reset, and delivery lifecycle", async () => {
  const pg = new PGlite();
  try {
    await applyPrismaMigrations(pg);
    const pgdb = drizzle(pg, { schema }) as unknown as Db;
    const [campaign] = await pgdb
      .insert(schema.campaigns)
      .values({
        name: "PLU-122",
        brand: "Pluvus",
        dailyInitialOutreachLimit: 2,
        outreachPacingMinMinutes: 5,
        outreachPacingMaxMinutes: 5,
        negotiationReplyPacingMinMinutes: 1,
        negotiationReplyPacingMaxMinutes: 5,
      })
      .returning();
    const [workflow] = await pgdb
      .insert(schema.workflows)
      .values({ name: "Outreach", campaignId: campaign!.id })
      .returning();
    const [version] = await pgdb
      .insert(schema.workflowVersions)
      .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
      .returning();

    async function reserve(index: number) {
      const [creator] = await pgdb
        .insert(schema.creators)
        .values({ name: `Creator ${index}`, email: `creator-${index}@test.local` })
        .returning();
      const [instance] = await pgdb
        .insert(schema.executionInstances)
        .values({
          workflowVersionId: version!.id,
          creatorId: creator!.id,
          currentState: "OUTREACH_QUEUED",
          currentNodeId: "follow-up",
        })
        .returning();
      const [message] = await pgdb
        .insert(schema.messages)
        .values({
          instanceId: instance!.id,
          direction: "OUTBOUND",
          body: "Hello",
          idempotencyKey: `outreach:${instance!.id}`,
        })
        .returning();
      return { instance: instance!, message: message! };
    }

    const first = await reserve(1);
    const second = await reserve(2);
    const third = await reserve(3);
    const fourth = await reserve(4);
    const dayOne = new Date("2026-07-31T10:00:00.000Z");

    const firstClaim = await claimInitialOutreachSlot(first.message.id, dayOne, () => 0, pgdb);
    assert.equal(firstClaim.status, "send");

    // Retrying a provider attempt reuses the message's claim and does not
    // increment the daily counter or re-draw pacing.
    const retry = await claimInitialOutreachSlot(
      first.message.id,
      new Date("2026-07-31T10:01:00.000Z"),
      () => 0.9,
      pgdb,
    );
    assert.equal(retry.status, "send");

    const pacingDenied = await claimInitialOutreachSlot(second.message.id, dayOne, () => 0, pgdb);
    assert.deepEqual(pacingDenied, {
      status: "defer",
      reason: "pacing",
      retryAt: new Date("2026-07-31T10:05:00.000Z"),
    });
    assert.equal(
      (await claimInitialOutreachSlot(
        second.message.id,
        new Date("2026-07-31T10:05:00.000Z"),
        () => 0,
        pgdb,
      )).status,
      "send",
    );

    const capDenied = await claimInitialOutreachSlot(
      third.message.id,
      new Date("2026-07-31T10:20:00.000Z"),
      () => 0,
      pgdb,
    );
    assert.deepEqual(capDenied, {
      status: "defer",
      reason: "daily_cap",
      retryAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    // UTC reset admits one send, then pacing defers the next instead of allowing
    // every midnight-delayed job to burst at once.
    const midnight = new Date("2026-08-01T00:00:00.000Z");
    assert.equal(
      (await claimInitialOutreachSlot(third.message.id, midnight, () => 0, pgdb)).status,
      "send",
    );
    assert.deepEqual(
      await claimInitialOutreachSlot(fourth.message.id, midnight, () => 0, pgdb),
      {
        status: "defer",
        reason: "pacing",
        retryAt: new Date("2026-08-01T00:05:00.000Z"),
      },
    );

    const dayOneRows = await pgdb
      .select()
      .from(schema.campaignOutreachDays)
      .where(
        and(
          eq(schema.campaignOutreachDays.campaignId, campaign!.id),
          eq(
            schema.campaignOutreachDays.dayStart,
            new Date("2026-07-31T00:00:00.000Z"),
          ),
        ),
      );
    assert.equal(dayOneRows[0]?.startedCount, 2, "retry did not consume a third slot");

    // Delivery state advances only after sentAt exists, and is idempotent.
    assert.equal(
      await completeQueuedInitialOutreach(first.message.id, dayOne, pgdb),
      "not_sent",
    );
    await pgdb
      .update(schema.messages)
      .set({ sentAt: dayOne, externalMessageId: "provider-1" })
      .where(eq(schema.messages.id, first.message.id));
    assert.equal(
      await completeQueuedInitialOutreach(first.message.id, dayOne, pgdb),
      "completed",
    );
    assert.equal(
      await completeQueuedInitialOutreach(first.message.id, dayOne, pgdb),
      "already_completed",
    );
    const [completedInstance] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, first.instance.id));
    assert.equal(completedInstance?.currentState, "OUTREACH_SENT");
  } finally {
    await pg.close();
  }
});
