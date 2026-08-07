/**
 * PLU-110 — scheduleNegotiationFollowUpAfterSend against a real (pglite) DB.
 * Proves the confirmed-send gate + idempotency contract:
 *   not_sent → not_waiting → already_scheduled → scheduled(dueAt = sentAt+interval).
 *
 * Run:  node --import tsx --test src/db/negotiationFollowUpSchedule.db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./drizzle.js";
import { scheduleNegotiationFollowUpAfterSend } from "./outboundPacing.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const DAY = 24 * 60 * 60 * 1_000;

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
      } else current += char;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          current += quote;
          index++;
        } else quote = null;
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
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function applyPrismaMigrations(pg: PGlite): Promise<void> {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
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

async function setup(pgdb: Db, state: string, dueAt: Date | null) {
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "C", email: `c-${Math.floor(state.length)}-${dueAt?.getTime() ?? "n"}@test.local` })
    .returning();
  const [workflow] = await pgdb.insert(schema.workflows).values({ name: "W" }).returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({
      workflowVersionId: version!.id,
      creatorId: creator!.id,
      currentState: state as never,
      currentNodeId: "node-negotiation",
      dueAt,
    })
    .returning();
  const [message] = await pgdb
    .insert(schema.messages)
    .values({
      instanceId: instance!.id,
      direction: "OUTBOUND",
      body: "nudge",
      idempotencyKey: `negotiation-followup:${instance!.id}:0`,
    })
    .returning();
  return { instance: instance!, message: message! };
}

test("scheduleNegotiationFollowUpAfterSend: full state contract", async () => {
  const pg = new PGlite();
  try {
    await applyPrismaMigrations(pg);
    const pgdb = drizzle(pg, { schema }) as unknown as Db;
    const now = new Date("2026-08-07T12:00:00.000Z");

    // not_sent — sentAt is null.
    const a = await setup(pgdb, "AWAITING_REPLY", null);
    assert.equal(
      await scheduleNegotiationFollowUpAfterSend(a.message.id, 2 * DAY, now, pgdb),
      "not_sent",
    );

    // scheduled — sentAt set, AWAITING_REPLY, no dueAt.
    const sentAt = new Date("2026-08-07T11:00:00.000Z");
    await pgdb.update(schema.messages).set({ sentAt }).where(eq(schema.messages.id, a.message.id));
    assert.equal(
      await scheduleNegotiationFollowUpAfterSend(a.message.id, 2 * DAY, now, pgdb),
      "scheduled",
    );
    const [armed] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, a.instance.id));
    assert.equal(armed?.dueAt?.getTime(), sentAt.getTime() + 2 * DAY, "dueAt = sentAt + interval");

    // already_scheduled — a pending dueAt is idempotent under flush retry.
    assert.equal(
      await scheduleNegotiationFollowUpAfterSend(a.message.id, 2 * DAY, now, pgdb),
      "already_scheduled",
    );

    // not_waiting — a reply/exhaustion moved the instance out of AWAITING_REPLY.
    const b = await setup(pgdb, "NEGOTIATING", null);
    await pgdb.update(schema.messages).set({ sentAt }).where(eq(schema.messages.id, b.message.id));
    assert.equal(
      await scheduleNegotiationFollowUpAfterSend(b.message.id, 2 * DAY, now, pgdb),
      "not_waiting",
    );
    const [untouched] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, b.instance.id));
    assert.equal(untouched?.dueAt, null, "a non-waiting instance is never armed");
  } finally {
    await pg.close();
  }
});
