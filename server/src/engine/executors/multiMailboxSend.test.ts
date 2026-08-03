/**
 * PLU-121 (multi-mailbox) — unit tests for per-account sender selection at the
 * send choke point. In-memory fakes for the DB seam + providers; no live DB.
 * Run with:  npx tsx src/engine/executors/multiMailboxSend.test.ts
 *
 * Proves the two invariants the ticket calls out for the send side:
 *   1. When a run pins a connected account, the send goes out on THAT account's
 *      provider (not the caller's default provider), and the sent Message is
 *      attributed to that account id.
 *   2. On a non-Nylas/test path (resolveInstanceProvider → null, or the seam is
 *      absent), the caller-supplied provider is used and no account is stamped.
 *      Production Nylas resolution is covered separately and fails closed.
 */

import assert from "node:assert/strict";
import type { Creator } from "../../db/schema.js";
import { sendOnce, type FlushDeps } from "./idempotentSend.js";
import type { IEmailProvider } from "../providers.js";
import type { EmailDraft } from "../types.js";

let n = 0;
function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

const creator = { id: "c1", name: "Robin", email: "robin@example.com" } as unknown as Creator;
const draft: EmailDraft = { subject: "Hi", body: "Let's collaborate." };

// A provider that tags its returned ids so a test can tell WHICH provider sent.
function makeTaggedEmail(tag: string) {
  let sends = 0;
  const labels: Array<{ threadId: string; label: string }> = [];
  const email: IEmailProvider & {
    applyThreadLabel(threadId: string, label: string): Promise<void>;
  } = {
    async draft() {
      return draft;
    },
    async send() {
      sends++;
      return { messageId: `${tag}-ext-${sends}`, threadId: `${tag}-thread-${sends}` };
    },
    async applyThreadLabel(threadId, label) {
      labels.push({ threadId, label });
    },
  };
  return { email, sends: () => sends, labels };
}

// A full FlushDeps over an in-memory rows map. `resolveInstanceProvider` is
// supplied by the caller so each test controls whether a run is "pinned".
function makeDeps(
  resolveInstanceProvider?: FlushDeps["resolveInstanceProvider"],
) {
  const rows = new Map<string, any>();
  let seq = 0;
  const deps: FlushDeps = {
    async createMessage(data: any) {
      const key = data.idempotencyKey as string;
      if (rows.has(key)) {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        throw err;
      }
      const row = {
        id: `m${++seq}`,
        instanceId: data.instanceId ?? "i1",
        idempotencyKey: key,
        subject: data.subject,
        body: data.body,
        externalMessageId: null,
        threadId: null,
        emailAccountId: data.emailAccountId ?? null,
      };
      rows.set(key, row);
      return row as any;
    },
    async findMessageByIdempotencyKey(key: string) {
      return (rows.get(key) ?? null) as any;
    },
    async findMessageById(id: string) {
      return ([...rows.values()].find((r) => r.id === id) ?? null) as any;
    },
    async updateMessageSent(
      id: string,
      d: { externalMessageId: string; threadId: string; emailAccountId?: string },
    ) {
      const row = [...rows.values()].find((r) => r.id === id);
      row.externalMessageId = d.externalMessageId;
      row.threadId = d.threadId;
      // Mirror the real DB: stamp the sending mailbox at finalize when supplied.
      if (d.emailAccountId) row.emailAccountId = d.emailAccountId;
      return row as any;
    },
    async findInstanceById(id: string) {
      return { id, creatorId: "c1", workflowVersionId: "wfv1" };
    },
    async findCreatorById(id: string) {
      return { id, name: "Robin", email: "robin@example.com" } as any;
    },
    async resolveCampaignName() {
      return undefined;
    },
    async acquireSendLock() {
      return "tok";
    },
    async releaseSendLock() {
      /* no-op */
    },
    threadContext: {
      async resolve() {
        return {};
      },
    },
    ...(resolveInstanceProvider ? { resolveInstanceProvider } : {}),
  };
  return { deps, rows };
}

async function run() {
  console.log("multi-mailbox send selection (PLU-121)");

  await test("pinned account → sends on that account's provider + stamps id", async () => {
    const defaultEmail = makeTaggedEmail("default");
    const accountEmail = makeTaggedEmail("acct");
    const { deps, rows } = makeDeps(async (instanceId) => {
      assert.equal(instanceId, "i1");
      return { provider: accountEmail.email, accountId: "acc_2" };
    });

    const res = await sendOnce(defaultEmail.email, "i1", creator, draft, "outreach:i1", deps);

    // The account provider sent; the default one never did.
    assert.equal(accountEmail.sends(), 1, "account provider should have sent");
    assert.equal(defaultEmail.sends(), 0, "default provider must NOT send when pinned");
    assert.ok(res.messageId.startsWith("acct-ext-"), `expected acct id, got ${res.messageId}`);

    // The sent row is attributed to the pinned account.
    const row = [...rows.values()][0];
    assert.equal(row.emailAccountId, "acc_2", "sent Message must be stamped with the account id");
  });

  await test("non-Nylas resolver → caller provider, no account stamp", async () => {
    const defaultEmail = makeTaggedEmail("default");
    // resolver returns null (deployment not nylas / run unpinned).
    const { deps, rows } = makeDeps(async () => null);

    const res = await sendOnce(defaultEmail.email, "i1", creator, draft, "outreach:i1", deps);

    assert.equal(defaultEmail.sends(), 1, "default provider should send when unpinned");
    assert.ok(res.messageId.startsWith("default-ext-"), `expected default id, got ${res.messageId}`);
    const row = [...rows.values()][0];
    assert.equal(row.emailAccountId, null, "unpinned send must not stamp an account");
  });

  await test("resolver seam absent → single-mailbox behavior unchanged", async () => {
    const defaultEmail = makeTaggedEmail("default");
    const { deps } = makeDeps(undefined); // no resolveInstanceProvider at all

    const res = await sendOnce(defaultEmail.email, "i1", creator, draft, "outreach:i1", deps);

    assert.equal(defaultEmail.sends(), 1);
    assert.ok(res.messageId.startsWith("default-ext-"));
  });

  await test("already-sent retry repairs labels through the pinned provider", async () => {
    const defaultEmail = makeTaggedEmail("default");
    const accountEmail = makeTaggedEmail("acct");
    const { deps } = makeDeps(async () => ({
      provider: accountEmail.email,
      accountId: "acc_2",
    }));

    await sendOnce(
      defaultEmail.email,
      "i1",
      creator,
      draft,
      "outreach:label-retry",
      deps,
      undefined,
      "Summer",
    );
    const retry = await sendOnce(
      defaultEmail.email,
      "i1",
      creator,
      draft,
      "outreach:label-retry",
      deps,
      undefined,
      "Summer",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(retry.alreadySent, true);
    assert.equal(defaultEmail.labels.length, 0, "caller/default mailbox must never be labeled");
    assert.equal(accountEmail.labels.length, 2, "initial send + retry repair use pinned mailbox");
  });

  await test("already-sent retry safely skips labeling when pinned provider is unavailable", async () => {
    const defaultEmail = makeTaggedEmail("default");
    const accountEmail = makeTaggedEmail("acct");
    let resolutions = 0;
    const { deps } = makeDeps(async () => {
      resolutions++;
      if (resolutions > 1) throw new Error("account lookup unavailable");
      return { provider: accountEmail.email, accountId: "acc_2" };
    });

    await sendOnce(
      defaultEmail.email,
      "i1",
      creator,
      draft,
      "outreach:label-skip",
      deps,
      undefined,
      "Summer",
    );
    const retry = await sendOnce(
      defaultEmail.email,
      "i1",
      creator,
      draft,
      "outreach:label-skip",
      deps,
      undefined,
      "Summer",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(retry.alreadySent, true, "delivery retry remains a successful no-op");
    assert.equal(defaultEmail.labels.length, 0, "unavailable pin never falls back for repair");
    assert.equal(accountEmail.labels.length, 1, "only the initial successful send was labeled");
  });

  console.log(`\n${n} passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
