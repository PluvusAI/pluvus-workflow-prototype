/**
 * PLU-121 migration regression: an unconfigured placeholder grant must never
 * become an eligible default sender.
 *
 * Run: npx tsx --test src/db/connectedEmailAccounts.db.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  configureMigrationSession,
  migrationSessionConfig,
  type MigrationEnvironment,
} from "./migrationSession.js";
import { applyPGliteMigrations } from "../testUtils/pgliteMigrations.js";

const ACCOUNT_MIGRATION = "20260731120000_plu121_connected_email_accounts";

async function applyAccountMigrations(
  pg: PGlite,
  env: MigrationEnvironment = {},
): Promise<void> {
  await applyPGliteMigrations(pg, {
    beforeMigration: async ({ name }) => {
      if (name === ACCOUNT_MIGRATION) {
        await configureMigrationSession(pg, migrationSessionConfig(env));
      }
    },
  });
}

type SeedRow = {
  nylasGrantId: string;
  emailAddress: string;
  status: string;
  isDefault: boolean;
};

async function seedRow(pg: PGlite): Promise<SeedRow> {
  const result = await pg.query<SeedRow>(
    `SELECT "nylasGrantId", "emailAddress", "status", "isDefault"
       FROM "ConnectedEmailAccount"
      WHERE "id" = 'seed_default_email_account'`,
  );
  assert.equal(result.rows.length, 1, "migration must create exactly one seed account");
  return result.rows[0]!;
}

test("missing migration grant creates a disabled, non-default placeholder", async () => {
  const pg = new PGlite();
  try {
    await applyAccountMigrations(pg);
    assert.deepEqual(await seedRow(pg), {
      nylasGrantId: "UNCONFIGURED_DEFAULT_GRANT",
      emailAddress: "default@pluvus.local",
      status: "disabled",
      isDefault: false,
    });
  } finally {
    await pg.close();
  }
});

test("explicit placeholder sentinel stays disabled and non-default", async () => {
  const pg = new PGlite();
  try {
    await applyAccountMigrations(pg, {
      NYLAS_GRANT_ID: "UNCONFIGURED_DEFAULT_GRANT",
      NYLAS_EMAIL_ADDRESS: "ignored@example.com",
    });
    assert.deepEqual(await seedRow(pg), {
      nylasGrantId: "UNCONFIGURED_DEFAULT_GRANT",
      emailAddress: "ignored@example.com",
      status: "disabled",
      isDefault: false,
    });
  } finally {
    await pg.close();
  }
});

test("configured migration grant creates the active default account", async () => {
  const pg = new PGlite();
  try {
    await applyAccountMigrations(pg, {
      NYLAS_GRANT_ID: "grant-real",
      NYLAS_EMAIL_ADDRESS: "legacy@example.com",
    });
    assert.deepEqual(await seedRow(pg), {
      nylasGrantId: "grant-real",
      emailAddress: "legacy@example.com",
      status: "active",
      isDefault: true,
    });
  } finally {
    await pg.close();
  }
});
