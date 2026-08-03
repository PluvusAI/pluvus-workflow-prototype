/**
 * PLU-121 regressions for the production account resolver. A pinned Nylas run
 * must fail closed when its mailbox cannot be resolved; sending from the
 * caller/default provider would put the conversation on the wrong account.
 *
 * Run: npx tsx --test src/engine/executors/multiMailboxSendResolution.test.ts
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { db } from "../../db/drizzle.js";
import type { Creator } from "../../db/schema.js";
import type { IEmailProvider } from "../providers.js";
import type { EmailDraft } from "../types.js";
import {
  defaultResolveInstanceProvider,
  sendOnce,
  type FlushDeps,
} from "./idempotentSend.js";

const INSTANCE_ID = "instance-pinned";
const ACCOUNT_ID = "account-pinned";
const creator = {
  id: "creator-1",
  name: "Robin",
  email: "robin@example.com",
} as unknown as Creator;
const draft: EmailDraft = { subject: "Hi", body: "Let's collaborate." };

type SelectResult = unknown[] | Error;

function useNylas(t: TestContext): void {
  const previous = process.env["EMAIL_PROVIDER"];
  process.env["EMAIL_PROVIDER"] = "nylas";
  t.after(() => {
    if (previous === undefined) delete process.env["EMAIL_PROVIDER"];
    else process.env["EMAIL_PROVIDER"] = previous;
  });
}

function useMockProvider(t: TestContext): void {
  const previous = process.env["EMAIL_PROVIDER"];
  process.env["EMAIL_PROVIDER"] = "mock";
  t.after(() => {
    if (previous === undefined) delete process.env["EMAIL_PROVIDER"];
    else process.env["EMAIL_PROVIDER"] = previous;
  });
}

/** Mock the real Drizzle reads used by defaultResolveInstanceProvider. */
function mockSelects(t: TestContext, results: SelectResult[]): void {
  let query = 0;
  const mockDb = db as unknown as {
    select: (...args: unknown[]) => unknown;
  };
  t.mock.method(mockDb, "select", () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const result = results[query++];
          assert.notEqual(result, undefined, `unexpected DB read ${query}`);
          if (result instanceof Error) throw result;
          return result;
        },
      }),
    }),
  }));
}

function makeHarness() {
  let row: Record<string, unknown> | null = null;
  let sends = 0;
  let finalizes = 0;
  let lockAttempts = 0;

  const email: IEmailProvider = {
    async draft() {
      return draft;
    },
    async send() {
      sends++;
      return { messageId: "default-message", threadId: "default-thread" };
    },
  };

  const deps: FlushDeps = {
    async createMessage(data) {
      row = {
        id: "message-1",
        instanceId: data.instanceId,
        idempotencyKey: data.idempotencyKey,
        subject: data.subject,
        body: data.body,
        externalMessageId: null,
        threadId: null,
        emailAccountId: null,
      };
      return row as never;
    },
    async findMessageByIdempotencyKey() {
      return row as never;
    },
    async findMessageById() {
      return row as never;
    },
    async updateMessageSent(_id, sent) {
      finalizes++;
      assert.ok(row);
      row["externalMessageId"] = sent.externalMessageId;
      row["threadId"] = sent.threadId;
      return row as never;
    },
    async findInstanceById(id) {
      return { id, creatorId: creator.id, workflowVersionId: "version-1" };
    },
    async findCreatorById() {
      return creator;
    },
    async resolveCampaignName() {
      return undefined;
    },
    async acquireSendLock() {
      lockAttempts++;
      return "lock-token";
    },
    async releaseSendLock() {
      // no-op
    },
    threadContext: {
      async resolve() {
        return {};
      },
    },
    // Exercise the production resolver, not a resolver-shaped test double.
    resolveInstanceProvider: defaultResolveInstanceProvider,
  };

  return {
    deps,
    email,
    row: () => row,
    sends: () => sends,
    finalizes: () => finalizes,
    lockAttempts: () => lockAttempts,
  };
}

async function attemptSend(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await sendOnce(
    harness.email,
    INSTANCE_ID,
    creator,
    draft,
    `outreach:${INSTANCE_ID}`,
    harness.deps,
  );
}

function assertReservedButUnsent(harness: ReturnType<typeof makeHarness>): void {
  assert.equal(harness.sends(), 0, "the default provider must not send");
  assert.equal(harness.finalizes(), 0, "the reservation must not be finalized");
  assert.equal(harness.lockAttempts(), 0, "resolution fails before taking the send lock");
  assert.equal(
    harness.row()?.["externalMessageId"],
    null,
    "the row remains reserved for a BullMQ retry",
  );
}

test("production resolver propagates a transient DB failure and does not send", async (t) => {
  useNylas(t);
  mockSelects(t, [new Error("database temporarily unavailable")]);
  const harness = makeHarness();

  await assert.rejects(() => attemptSend(harness), /database temporarily unavailable/);
  assertReservedButUnsent(harness);
});

test("production resolver rejects a missing pinned account and does not send", async (t) => {
  useNylas(t);
  mockSelects(t, [
    [{ id: INSTANCE_ID, emailAccountId: ACCOUNT_ID }],
    [],
  ]);
  const harness = makeHarness();

  await assert.rejects(
    () => attemptSend(harness),
    new RegExp(`pinned account ${ACCOUNT_ID}.*was not found`),
  );
  assertReservedButUnsent(harness);
});

test("production resolver rejects an inactive pinned account and does not send", async (t) => {
  useNylas(t);
  mockSelects(t, [
    [{ id: INSTANCE_ID, emailAccountId: ACCOUNT_ID }],
    [{ id: ACCOUNT_ID, status: "disabled" }],
  ]);
  const harness = makeHarness();

  await assert.rejects(
    () => attemptSend(harness),
    new RegExp(`pinned account ${ACCOUNT_ID}.*is disabled`),
  );
  assertReservedButUnsent(harness);
});

test("production Nylas resolver rejects an unsafe null account pin", async (t) => {
  useNylas(t);
  mockSelects(t, [[{ id: INSTANCE_ID, emailAccountId: null }]]);
  const harness = makeHarness();

  await assert.rejects(
    () => attemptSend(harness),
    /Nylas instance instance-pinned has no pinned account/,
  );
  assertReservedButUnsent(harness);
});

test("non-Nylas runs preserve caller-provider fallback without an account lookup", async (t) => {
  useMockProvider(t);
  const harness = makeHarness();

  const result = await sendOnce(
    harness.email,
    INSTANCE_ID,
    creator,
    draft,
    `legacy:${INSTANCE_ID}`,
    harness.deps,
  );

  assert.equal(result.messageId, "default-message");
  assert.equal(result.alreadySent, false);
  assert.equal(harness.sends(), 1);
  assert.equal(harness.finalizes(), 1);
  assert.equal(harness.lockAttempts(), 1);
});
