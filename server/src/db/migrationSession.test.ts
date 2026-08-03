import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configureMigrationSession,
  migrationSessionConfig,
  UNCONFIGURED_NYLAS_GRANT_ID,
} from "./migrationSession.js";

test("migration session trims and parameterizes the legacy Nylas mailbox", async () => {
  const config = migrationSessionConfig({
    NYLAS_GRANT_ID: "  grant-'legacy  ",
    NYLAS_EMAIL_ADDRESS: "  sender@example.com  ",
  });
  assert.deepEqual(config, {
    nylasGrantId: "grant-'legacy",
    nylasEmailAddress: "sender@example.com",
    hasConfiguredNylasGrant: true,
  });

  const calls: Array<{ queryText: string; values: unknown[] | undefined }> = [];
  await configureMigrationSession(
    {
      async query(queryText, values) {
        calls.push({ queryText, values });
      },
    },
    config,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.queryText, /set_config\('pluvus\.nylas_grant_id', \$1, \$3::boolean/);
  assert.match(calls[0]!.queryText, /set_config\('pluvus\.nylas_email_address', \$2, \$3::boolean/);
  assert.deepEqual(calls[0]!.values, ["grant-'legacy", "sender@example.com", false]);
  assert.ok(!calls[0]!.queryText.includes("grant-'legacy"));
});

test("migration session can scope settings to the current transaction", async () => {
  const calls: Array<{ queryText: string; values: unknown[] | undefined }> = [];
  await configureMigrationSession(
    {
      async query(queryText, values) {
        calls.push({ queryText, values });
      },
    },
    migrationSessionConfig({ NYLAS_GRANT_ID: "grant-pooled" }),
    true,
  );

  assert.deepEqual(calls[0]!.values, ["grant-pooled", "", true]);
});

test("missing and sentinel migration grants are both unconfigured", () => {
  assert.deepEqual(migrationSessionConfig({}), {
    nylasGrantId: "",
    nylasEmailAddress: "",
    hasConfiguredNylasGrant: false,
  });
  assert.equal(
    migrationSessionConfig({ NYLAS_GRANT_ID: UNCONFIGURED_NYLAS_GRANT_ID })
      .hasConfiguredNylasGrant,
    false,
  );
});
