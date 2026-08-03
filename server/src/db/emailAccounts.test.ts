import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { db } from "./drizzle.js";
import {
  EmailAccountUnavailableError,
  resolveAccountForCampaign,
} from "./emailAccounts.js";

function mockAccountLookup(
  t: TestContext,
  rows: unknown[],
): void {
  const mockDb = db as unknown as { select: (...args: unknown[]) => unknown };
  t.mock.method(mockDb, "select", () => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }));
}

test("an explicit inactive campaign account fails instead of switching sender", async (t) => {
  mockAccountLookup(t, [{ id: "account-a", status: "disabled" }]);

  await assert.rejects(
    () => resolveAccountForCampaign("account-a"),
    (error) =>
      error instanceof EmailAccountUnavailableError &&
      error.message === "Campaign email account account-a is disabled",
  );
});

test("a missing explicit campaign account fails instead of using the default", async (t) => {
  mockAccountLookup(t, []);

  await assert.rejects(
    () => resolveAccountForCampaign("account-missing"),
    (error) =>
      error instanceof EmailAccountUnavailableError &&
      error.message === "Campaign email account account-missing no longer exists",
  );
});

test("an explicit active campaign account remains the pinned sender", async (t) => {
  const account = { id: "account-active", status: "active" };
  mockAccountLookup(t, [account]);

  assert.equal(await resolveAccountForCampaign(account.id), account);
});

test("a Nylas campaign without an active default fails closed", async (t) => {
  const previous = process.env["EMAIL_PROVIDER"];
  process.env["EMAIL_PROVIDER"] = "nylas";
  t.after(() => {
    if (previous === undefined) delete process.env["EMAIL_PROVIDER"];
    else process.env["EMAIL_PROVIDER"] = previous;
  });
  mockAccountLookup(t, []);

  await assert.rejects(
    () => resolveAccountForCampaign(null),
    (error) =>
      error instanceof EmailAccountUnavailableError &&
      error.message === "No active default email account is configured for this campaign",
  );
});

test("a mock campaign backfilled to the unconfigured seed remains enrollable", async (t) => {
  const previous = process.env["EMAIL_PROVIDER"];
  process.env["EMAIL_PROVIDER"] = "mock";
  t.after(() => {
    if (previous === undefined) delete process.env["EMAIL_PROVIDER"];
    else process.env["EMAIL_PROVIDER"] = previous;
  });
  mockAccountLookup(t, [
    {
      id: "seed_default_email_account",
      nylasGrantId: "UNCONFIGURED_DEFAULT_GRANT",
      status: "disabled",
    },
  ]);

  assert.equal(
    await resolveAccountForCampaign("seed_default_email_account"),
    null,
  );
});
