/**
 * PLU-121 provider-id namespaces against the real migrated Postgres schema.
 *
 * Run: npx tsx --test src/db/messages.accountDedupe.db.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { Db } from "./drizzle.js";
import * as schema from "./schema.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

test("external message uniqueness is account-scoped with a legacy-null namespace", async () => {
  const pg = new PGlite();
  try {
    await applyPGliteMigrations(pg);
    const pgdb = drizzle(pg, { schema }) as unknown as Db;

    const [workflow] = await pgdb
      .insert(schema.workflows)
      .values({ name: "Message namespace workflow" })
      .returning();
    const [version] = await pgdb
      .insert(schema.workflowVersions)
      .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
      .returning();
    const [accountA, accountB] = await pgdb
      .insert(schema.connectedEmailAccounts)
      .values([
        {
          nylasGrantId: "grant-message-a",
          emailAddress: "message-a@example.com",
        },
        {
          nylasGrantId: "grant-message-b",
          emailAddress: "message-b@example.com",
        },
      ])
      .returning();
    const [creatorA, creatorB] = await pgdb
      .insert(schema.creators)
      .values([
        { name: "Creator A", email: "message-creator-a@example.com" },
        { name: "Creator B", email: "message-creator-b@example.com" },
      ])
      .returning();
    const [instanceA, instanceB] = await pgdb
      .insert(schema.executionInstances)
      .values([
        {
          workflowVersionId: version!.id,
          creatorId: creatorA!.id,
          emailAccountId: accountA!.id,
        },
        {
          workflowVersionId: version!.id,
          creatorId: creatorB!.id,
          emailAccountId: accountB!.id,
        },
      ])
      .returning();

    const message = (instanceId: string, emailAccountId: string | null, suffix: string) => ({
      instanceId,
      direction: "INBOUND" as const,
      subject: "Re: hello",
      body: suffix,
      externalMessageId: "provider-local-42",
      emailAccountId,
    });

    await pgdb.insert(schema.messages).values(message(instanceA!.id, accountA!.id, "A"));
    await pgdb.insert(schema.messages).values(message(instanceB!.id, accountB!.id, "B"));

    await assert.rejects(
      () =>
        pgdb
          .insert(schema.messages)
          .values(message(instanceA!.id, accountA!.id, "A duplicate")),
      "the same provider id cannot repeat inside one account",
    );

    await pgdb.insert(schema.messages).values({
      ...message(instanceA!.id, null, "legacy"),
      externalMessageId: "legacy-local-42",
    });
    await assert.rejects(
      () =>
        pgdb.insert(schema.messages).values({
          ...message(instanceB!.id, null, "legacy duplicate"),
          externalMessageId: "legacy-local-42",
        }),
      "account-less legacy ids retain global dedupe within the null namespace",
    );

    // The legacy-null namespace is intentionally separate from connected grants.
    await pgdb.insert(schema.messages).values({
      ...message(instanceA!.id, accountA!.id, "same id, connected account"),
      externalMessageId: "legacy-local-42",
    });

    await assert.rejects(
      () =>
        pgdb
          .delete(schema.connectedEmailAccounts)
          .where(eq(schema.connectedEmailAccounts.id, accountA!.id)),
      "an account with message history cannot collapse its ids into the null namespace",
    );
  } finally {
    await pg.close();
  }
});
