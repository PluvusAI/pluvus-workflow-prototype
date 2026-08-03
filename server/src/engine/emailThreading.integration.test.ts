/**
 * Integration test — Email Threading end-to-end (E1–E7), hermetic.
 * Run with:  npx tsx src/engine/emailThreading.integration.test.ts
 *
 * Wires the REAL threading pipeline together over an in-memory message store:
 *   - real sendOnce (idempotentSend.ts)                 — the single send seam
 *   - real DefaultThreadContextResolver (threadContext) — reply target + subject
 *   - real buildReplySubject                            — Re: policy
 *   - real NylasEmailProvider + real MockNylasClient    — replyToMessageId mapping
 * The ONLY fake is the DB seam (an in-memory Message[] the resolver reads and
 * sendOnce writes), so this exercises the actual code paths without a live DB.
 *
 * Proves the RFC's acceptance gate:
 *   - a full outreach → reply → counter → accept → content-brief run persists
 *     exactly ONE threadId for the instance;
 *   - every reply subject after the first is `Re: <original subject>`;
 *   - the first email is unchanged (its own subject, new thread);
 *   - concurrent sends share the one threadId (accepted shallow fork);
 *   - an imported campaign (no prior rows) opens a new thread.
 */

import assert from "node:assert/strict";
import { sendOnce, type FlushDeps } from "./executors/idempotentSend.js";
import {
  DefaultThreadContextResolver,
  type ThreadContextDeps,
} from "./threadContext.js";
import { NylasEmailProvider } from "../providers/nylas/nylasEmailProvider.js";
import { MockNylasClient } from "../providers/nylas/mockNylasClient.js";
import type { Creator, Message, MessageInsert } from "../db/schema.js";
import type { EmailDraft } from "./types.js";

let n = 0;
function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

const creator = {
  id: "c1",
  name: "Robin Vega",
  email: "robin@creators.test",
} as unknown as Creator;

// ---------------------------------------------------------------------------
// In-memory DB seam — the ONLY fake. Insertion order is preserved and drives the
// resolver's `createdAt asc` contract; a monotonic counter stamps createdAt so
// no Date.now() is needed (tsx test env forbids it, and it keeps ordering stable).
// ---------------------------------------------------------------------------
function makeStore() {
  const rows: Message[] = [];
  let seq = 0;
  let clock = 0;

  function createMessage(data: MessageInsert): Message {
    const key = data.idempotencyKey ?? null;
    if (key && rows.some((r) => r.idempotencyKey === key)) {
      const err: any = new Error("Unique constraint failed");
      err.code = "P2002";
      throw err;
    }
    const row = {
      id: `m${++seq}`,
      instanceId: data.instanceId,
      direction: data.direction,
      subject: data.subject ?? null,
      body: data.body ?? "",
      threadId: data.threadId ?? null,
      externalMessageId: data.externalMessageId ?? null,
      idempotencyKey: key,
      senderEmail: null,
      replyIntent: null,
      classifyConfidence: null,
      sentAt: null,
      receivedAt: null,
      processedAt: null,
      createdAt: new Date(++clock),
    } as unknown as Message;
    rows.push(row);
    return row;
  }

  // Record an INBOUND reply (the creator's message), as the webhook would, so the
  // resolver can pick it as the next reply target (D2: latest either direction).
  function recordInbound(instanceId: string, externalMessageId: string, threadId: string): void {
    rows.push({
      id: `m${++seq}`,
      instanceId,
      direction: "INBOUND",
      subject: null,
      body: "creator reply",
      threadId,
      externalMessageId,
      idempotencyKey: null,
      senderEmail: creator.email,
      replyIntent: null,
      classifyConfidence: null,
      sentAt: null,
      receivedAt: new Date(++clock),
      processedAt: null,
      createdAt: new Date(clock),
    } as unknown as Message);
  }

  const sendDeps: Pick<
    FlushDeps,
    | "createMessage"
    | "findMessageByIdempotencyKey"
    | "updateMessageSent"
    | "findMessageById"
    | "findInstanceById"
    | "findCreatorById"
    | "resolveCampaignName"
    | "acquireSendLock"
    | "releaseSendLock"
    | "resolveInstanceProvider"
  > = {
    async createMessage(data) {
      return createMessage(data);
    },
    async findMessageByIdempotencyKey(key) {
      return rows.find((r) => r.idempotencyKey === key) ?? null;
    },
    async updateMessageSent(id, data) {
      const row = rows.find((r) => r.id === id)!;
      (row as any).externalMessageId = data.externalMessageId;
      (row as any).threadId = data.threadId;
      (row as any).sentAt = new Date(++clock);
      return row;
    },
    async findMessageById(id) {
      return rows.find((r) => r.id === id) ?? null;
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
      return "test-lock";
    },
    async releaseSendLock() {
      // no-op
    },
    async resolveInstanceProvider() {
      return null;
    },
  };

  const threadDeps: ThreadContextDeps = {
    async listMessagesByInstance(instanceId) {
      return rows
        .filter((r) => r.instanceId === instanceId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
  };

  return { rows, recordInbound, sendDeps, threadDeps };
}

// Assemble real sendOnce deps over the store + the real resolver reading it.
function makeDeps(store: ReturnType<typeof makeStore>): FlushDeps {
  return {
    ...store.sendDeps,
    threadContext: new DefaultThreadContextResolver(store.threadDeps),
  };
}

function draftWith(subject: string): EmailDraft {
  return { subject, body: `Body for ${subject}` };
}

async function main() {
  console.log("\nEmail Threading — integration (E1–E7)\n");

  await test("outreach → reply → counter → accept → content brief = ONE threadId, Re: on every reply", async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    const provider = new NylasEmailProvider(new MockNylasClient(), "grant-test");
    const instanceId = "inst-1";

    // 1. Initial outreach — a fresh thread with its own subject.
    const outreach = await sendOnce(
      provider,
      instanceId,
      creator,
      draftWith("Collaboration opportunity — Robin Vega"),
      `outreach:${instanceId}`,
      deps,
    );
    // Creator replies (inbound), on the same thread.
    store.recordInbound(instanceId, "creator-reply-1", outreach.threadId);

    // 2. Counter (negotiation round 1) — must reply into the thread.
    await sendOnce(
      provider,
      instanceId,
      creator,
      draftWith("Re: something the agent regenerated"),
      `negotiation:counter:${instanceId}:1`,
      deps,
    );
    store.recordInbound(instanceId, "creator-reply-2", outreach.threadId);

    // 3. Acceptance.
    await sendOnce(
      provider,
      instanceId,
      creator,
      draftWith("Partnership confirmed!"),
      `negotiation:accept:${instanceId}`,
      deps,
    );

    // 4. Content brief (a distinct executor, with attachments in reality).
    await sendOnce(
      provider,
      instanceId,
      creator,
      draftWith("Your campaign brief"),
      `contentBrief:${instanceId}`,
      deps,
    );

    // ── Acceptance gate 1: exactly ONE threadId for the instance ──────────────
    const outboundRows = store.rows.filter(
      (r) => r.instanceId === instanceId && r.direction === "OUTBOUND",
    );
    assert.equal(outboundRows.length, 4, "four outbound sends");
    const threadIds = new Set(store.rows.filter((r) => r.instanceId === instanceId).map((r) => r.threadId));
    assert.equal(threadIds.size, 1, `exactly one threadId, got ${[...threadIds].join(", ")}`);

    // ── Acceptance gate 2: first email unchanged; every later reply is Re: ─────
    const [first, second, third, fourth] = outboundRows;
    assert.equal(first!.subject, "Collaboration opportunity — Robin Vega", "first email keeps its own subject");
    // Canonical = first outbound subject; every subsequent send is Re: <canonical>.
    assert.equal(second!.subject, "Re: Collaboration opportunity — Robin Vega");
    assert.equal(third!.subject, "Re: Collaboration opportunity — Robin Vega");
    assert.equal(fourth!.subject, "Re: Collaboration opportunity — Robin Vega");
    // Never Re: Re:.
    for (const r of outboundRows) assert.ok(!/^Re:\s*Re:/i.test(r.subject ?? ""), "no Re: Re:");
  });

  await test("each reply after the first threads onto the PRIOR message (replyToMessageId set)", async () => {
    // We assert threading via the persisted rows: the resolver picks the latest
    // external id as the reply target, and the provider maps it to replyToMessageId
    // — verified here by checking the MockNylasClient recorded a reply id on the
    // 2nd+ sends but not the 1st.
    const store = makeStore();
    const deps = makeDeps(store);
    const client = new MockNylasClient();
    const provider = new NylasEmailProvider(client, "grant-test");
    const instanceId = "inst-2";

    await sendOnce(provider, instanceId, creator, draftWith("Opening subject"), `outreach:${instanceId}`, deps);
    await sendOnce(provider, instanceId, creator, draftWith("regenerated"), `followup:${instanceId}:1`, deps);
    await sendOnce(provider, instanceId, creator, draftWith("regenerated again"), `followup:${instanceId}:2`, deps);

    assert.equal(client.sent.length, 3);
    assert.equal(client.sent[0]!.replyToMessageId, undefined, "first send opens a new thread");
    // 2nd replies to the 1st outbound's id; 3rd replies to the 2nd's id.
    assert.equal(client.sent[1]!.replyToMessageId, client.sent[0]!.id);
    assert.equal(client.sent[2]!.replyToMessageId, client.sent[1]!.id);
  });

  await test("imported campaign (no prior rows) → new thread, own subject", async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    const client = new MockNylasClient();
    const provider = new NylasEmailProvider(client, "grant-test");

    await sendOnce(provider, "imported-1", creator, draftWith("Fresh outreach"), `outreach:imported-1`, deps);

    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0]!.replyToMessageId, undefined, "no reply target on an imported instance");
    assert.equal(client.sent[0]!.subject, "Fresh outreach", "keeps its own subject, no Re:");
  });

  await test("concurrent sends fork shallowly but share ONE threadId", async () => {
    // Two near-simultaneous sends after one prior outbound. Both may pick the same
    // reply target (a shallow fork), but both must land on the same threadId — the
    // invariant the RFC guarantees (no lock; one threadId per instance).
    const store = makeStore();
    const deps = makeDeps(store);
    const client = new MockNylasClient();
    const provider = new NylasEmailProvider(client, "grant-test");
    const instanceId = "inst-3";

    // Prior outbound establishes the thread.
    const first = await sendOnce(provider, instanceId, creator, draftWith("Opening"), `outreach:${instanceId}`, deps);

    // Two concurrent sends (distinct idempotency keys → both send).
    await Promise.all([
      sendOnce(provider, instanceId, creator, draftWith("a"), `followup:${instanceId}:A`, deps),
      sendOnce(provider, instanceId, creator, draftWith("b"), `followup:${instanceId}:B`, deps),
    ]);

    const threadIds = new Set(
      store.rows.filter((r) => r.instanceId === instanceId).map((r) => r.threadId),
    );
    assert.equal(threadIds.size, 1, "all messages share one threadId despite the fork");
    // Both concurrent sends threaded onto the same first message (the shallow fork).
    const replyIds = client.sent.slice(1).map((s) => s.replyToMessageId);
    for (const id of replyIds) assert.equal(id, first.messageId, "both forked onto the first message");
  });

  await test("crash recovery (BUG-E3) keeps the ONE threadId and threads the re-send", async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    const client = new MockNylasClient();
    const provider = new NylasEmailProvider(client, "grant-test");
    const instanceId = "inst-4";

    // Establish the thread.
    await sendOnce(provider, instanceId, creator, draftWith("Opening"), `outreach:${instanceId}`, deps);
    store.recordInbound(instanceId, "creator-reply", `nylas-thread-${creator.email}`);

    // Simulate a crash after reserve, before send: reserve the counter row directly.
    await store.sendDeps.createMessage({
      instanceId,
      direction: "OUTBOUND",
      subject: "Re: Opening",
      body: "counter body",
      idempotencyKey: `counter:${instanceId}:1`,
    } as MessageInsert);

    // Retry drives the recovery re-send — it must thread onto the creator's reply.
    await sendOnce(provider, instanceId, creator, draftWith("regenerated"), `counter:${instanceId}:1`, deps);

    const threadIds = new Set(
      store.rows.filter((r) => r.instanceId === instanceId && r.threadId).map((r) => r.threadId),
    );
    assert.equal(threadIds.size, 1, "recovery keeps the single threadId");
    // The recovery send carried a reply id (threaded onto the latest inbound).
    const recovery = client.sent[client.sent.length - 1]!;
    assert.equal(recovery.replyToMessageId, "creator-reply", "recovery re-send threads onto the reply");
  });

  console.log(`\n✓ emailThreading integration: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
