/**
 * Unit tests for the reserve/flush split (Randomized Send Delay §4.1, §4.1a,
 * §4.1b, §4.2a) — in-memory fakes for the DB seam, the send lock, and the email
 * provider. No live database or Redis.
 *
 * Covers §8:
 *   - reserve/flush split: reserveOutbound writes a NULL-external row; flushOutbound
 *     sends once + finalizes; a second flush on an already-sent row is a no-op.
 *   - reserve never sends (§4.1b): P2002 reserved-but-unsent → returns the EXISTING
 *     row id, does NOT call provider.send.
 *   - flush context reload (§4.1a): with only a messageId, flush addresses the
 *     creator, threads the reply, and applies the campaign label; a thread-context
 *     resolve failure degrades to a new-thread send, never throws.
 *   - flush serialization (§4.2a): two concurrent flushes on one messageId send
 *     EXACTLY once; the loser sees the finalized row and no-ops.
 *
 * Run with:  npx tsx src/engine/executors/sendDelaySplit.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reserveOutbound,
  flushOutbound,
  sendOnce,
  type FlushDeps,
} from "./idempotentSend.js";
import type { IEmailProvider, EmailSendOptions, EmailRecipient } from "../providers.js";
import type { ThreadContext } from "../threadContext.js";
import type { EmailAttachment, EmailDraft } from "../types.js";

const draft: EmailDraft = { subject: "Hi", body: "Let's collaborate." };

// A rich in-memory FlushDeps: an idempotencyKey-unique message table with rows
// carrying { id, instanceId, subject, body, externalMessageId, threadId }, a
// stub instance/creator, injectable campaign name + thread context (with a
// throw-on-resolve mode), and a real-ish send lock (single holder per key).
function makeFlushDeps(opts?: {
  ctx?: ThreadContext;
  throwOnResolve?: boolean;
  campaignName?: string;
  lockBusy?: boolean; // acquireSendLock always returns null (someone else holds it)
}) {
  const rows = new Map<string, any>(); // keyed by idempotencyKey
  let seq = 0;
  let resolves = 0;
  const locks = new Set<string>();

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
    async updateMessageSent(id, d) {
      const row = [...rows.values()].find((r) => r.id === id);
      row.externalMessageId = d.externalMessageId;
      row.threadId = d.threadId;
      return row as any;
    },
    async findInstanceById(id: string) {
      return { id, creatorId: "c1", workflowVersionId: "wfv1" };
    },
    async findCreatorById(id: string) {
      return { id, name: "Robin", email: "robin@creator.test" } as any;
    },
    async resolveCampaignName() {
      return opts?.campaignName;
    },
    async acquireSendLock(messageId: string) {
      if (opts?.lockBusy) return null;
      if (locks.has(messageId)) return null;
      locks.add(messageId);
      return `tok-${messageId}`;
    },
    async releaseSendLock(messageId: string) {
      locks.delete(messageId);
    },
    threadContext: {
      async resolve() {
        resolves++;
        if (opts?.throwOnResolve) throw new Error("db read failed");
        return opts?.ctx ?? {};
      },
    },
  };
  return { deps, rows, resolves: () => resolves, locks };
}

// Captures every send with its draft + options + recipient.
function makeEmail() {
  let sends = 0;
  const calls: {
    draft: EmailDraft;
    recipient: EmailRecipient | undefined;
    options: EmailSendOptions | undefined;
    creatorEmail: string | undefined;
  }[] = [];
  const email: IEmailProvider = {
    async draft() {
      return draft;
    },
    async send(sentDraft, creator, recipient, options) {
      sends++;
      calls.push({
        draft: sentDraft,
        recipient,
        options,
        creatorEmail: (creator as any)?.email,
      });
      return { messageId: `ext-${sends}`, threadId: `thread-${sends}` };
    },
  };
  return { email, sends: () => sends, calls };
}

// A labeler-capable email fake to assert the campaign label is applied at flush.
function makeLabelerEmail() {
  let sends = 0;
  const labelCalls: { threadId: string; label: string }[] = [];
  const email: IEmailProvider & {
    applyThreadLabel(threadId: string, label: string): Promise<void>;
  } = {
    async draft() {
      return draft;
    },
    async send() {
      sends++;
      return { messageId: `ext-${sends}`, threadId: `thread-${sends}` };
    },
    async applyThreadLabel(threadId, label) {
      labelCalls.push({ threadId, label });
    },
  };
  return { email, sends: () => sends, labelCalls };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ── reserve/flush split ─────────────────────────────────────────────────────

test("reserveOutbound writes a NULL-external row and does NOT send", async () => {
  const { deps, rows } = makeFlushDeps();
  const { email, sends } = makeEmail();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  assert.equal(r.alreadySent, false);
  assert.ok(r.messageId, "returns a reserved id");
  assert.equal(sends(), 0, "reserve NEVER sends");
  const row = rows.get("negotiation:counter:i1:1");
  assert.equal(row.externalMessageId, null, "row is reserved-but-unsent");
});

test("flushOutbound sends once and finalizes; a SECOND flush is a no-op (exactly-once)", async () => {
  const { deps, rows } = makeFlushDeps();
  const { email, sends } = makeEmail();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);

  const f1 = await flushOutbound(email, r.messageId, deps);
  assert.equal(f1.skipped, false);
  assert.equal(f1.messageId, "ext-1");
  assert.equal(sends(), 1);
  assert.equal(rows.get("negotiation:counter:i1:1").externalMessageId, "ext-1");

  // Second flush on the now-finalized row: no resend.
  const f2 = await flushOutbound(email, r.messageId, deps);
  assert.equal(f2.skipped, true, "already-sent row is a no-op");
  assert.equal(f2.messageId, "ext-1");
  assert.equal(sends(), 1, "provider.send called exactly once across both flushes");
});

// ── §4.1b reserve never sends on the P2002 branch ────────────────────────────

test("§4.1b: reserve on a reserved-but-unsent key returns the EXISTING id and does NOT send", async () => {
  const { deps, rows } = makeFlushDeps();
  const { email, sends } = makeEmail();
  // First reserve.
  const r1 = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  // Second reserve of the SAME key (a producer retry) — hits P2002. Must return
  // the same id and never send.
  const r2 = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  assert.equal(r2.alreadySent, false, "reserved-but-unsent → not alreadySent");
  assert.equal(r2.messageId, r1.messageId, "same STABLE id → jobId send|<id> dedupes");
  assert.equal(sends(), 0, "reserve never calls provider.send on the P2002 branch");
  assert.equal(rows.size, 1, "no duplicate row");
});

test("§4.1b: reserve on an already-FLUSHED key returns alreadySent:true (skip enqueue)", async () => {
  const { deps } = makeFlushDeps();
  const { email, sends } = makeEmail();
  const r1 = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  await flushOutbound(email, r1.messageId, deps); // now sent
  // Re-reserve the same key → prior row has externalMessageId → alreadySent.
  const r2 = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  assert.equal(r2.alreadySent, true, "already delivered → caller skips the delayed flush");
  assert.equal(sends(), 1, "still exactly one send");
});

// ── §4.1a flush-time send-context reconstruction ─────────────────────────────

test("§4.1a: flush with ONLY a messageId addresses the creator + threads the reply", async () => {
  const { deps } = makeFlushDeps({ ctx: { replyToExternalId: "ext-prior" } });
  const { email, calls } = makeEmail();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  // Simulate the DELAYED path: flush is called with just the id, no preResolved.
  await flushOutbound(email, r.messageId, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.creatorEmail, "robin@creator.test", "reloaded creator addressed");
  assert.equal(calls[0]!.options?.replyToExternalId, "ext-prior", "reply threaded");
  assert.equal(calls[0]!.recipient, undefined, "creator-bound → no explicit recipient");
});

test("§4.1a: flush applies the campaign label reloaded from the instance", async () => {
  const { deps } = makeFlushDeps({ campaignName: "Summer Skincare" });
  const { email, labelCalls } = makeLabelerEmail();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  await flushOutbound(email, r.messageId, deps);
  await flush();
  assert.equal(labelCalls.length, 1, "campaign label applied at flush");
  assert.equal(labelCalls[0]!.label, "Pluvus/Summer Skincare");
});

test("§4.1a: a thread-context resolve failure degrades to a new-thread send (never throws)", async () => {
  const { deps } = makeFlushDeps({ throwOnResolve: true });
  const { email, calls, sends } = makeEmail();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  // reserve degraded to empty ctx (new-thread subject); flush re-resolves and also
  // degrades — the send still goes out, unthreaded.
  const f = await flushOutbound(email, r.messageId, deps);
  assert.equal(sends(), 1, "delivery not blocked by a threading failure");
  assert.equal(f.skipped, false);
  assert.equal(calls[0]!.options?.replyToExternalId, undefined, "new thread on degrade");
});

test("§4.1a: flush on a missing message is a safe no-op", async () => {
  const { deps } = makeFlushDeps();
  const { email, sends } = makeEmail();
  const f = await flushOutbound(email, "does-not-exist", deps);
  assert.equal(f.skipped, true);
  assert.equal(sends(), 0);
});

// ── attachments (Content Brief PDF) survive the send split ───────────────────
// Regression: the reserve/flush split rebuilt the wire draft from the Message row
// (which has no attachments column), silently dropping the Content Brief PDF. The
// synchronous sendOnce path must carry draft.attachments straight into flush.

const pdfAttachment: EmailAttachment = {
  filename: "brief.pdf",
  contentType: "application/pdf",
  content: Buffer.from("%PDF-1.4 fake bytes"),
};

test("flushOutbound sends preResolved.attachments on the wire", async () => {
  const { deps } = makeFlushDeps();
  const { email, calls } = makeEmail();
  const r = await reserveOutbound("i1", draft, "content-brief:i1", deps);
  await flushOutbound(email, r.messageId, deps, { attachments: [pdfAttachment] });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.draft.attachments,
    [pdfAttachment],
    "the PDF reaches provider.send()",
  );
});

test("sendOnce threads draft.attachments through to the wire (synchronous path)", async () => {
  const { deps } = makeFlushDeps();
  const { email, calls } = makeEmail();
  const briefDraft: EmailDraft = { ...draft, attachments: [pdfAttachment] };
  const creator = { id: "c1", name: "Robin", email: "robin@creator.test" } as any;
  await sendOnce(email, "i1", creator, briefDraft, "content-brief:i1", deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.draft.attachments?.length, 1, "attachment present");
  assert.equal(calls[0]!.draft.attachments?.[0]!.filename, "brief.pdf");
});

test("a draft with NO attachments still sends an attachment-free wire draft", async () => {
  const { deps } = makeFlushDeps();
  const { email, calls } = makeEmail();
  const creator = { id: "c1", name: "Robin", email: "robin@creator.test" } as any;
  await sendOnce(email, "i1", creator, draft, "negotiation:counter:i1:1", deps);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.draft.attachments,
    undefined,
    "no attachments key added when the draft has none",
  );
});

// ── §4.2a flush serialization ────────────────────────────────────────────────

test("§4.2a: two CONCURRENT flushes on one messageId send exactly once; loser no-ops", async () => {
  // A send() that blocks until released, so we can hold two flushes in-flight and
  // prove the lock serializes them. The lock fake is single-holder per key, so the
  // second flush must fail to acquire and no-op WITHOUT sending.
  const { deps, rows } = makeFlushDeps();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);

  let sends = 0;
  let releaseSend!: () => void;
  const gate = new Promise<void>((res) => (releaseSend = res));
  const email: IEmailProvider = {
    async draft() {
      return draft;
    },
    async send() {
      sends++;
      await gate; // hold the first flush inside send()
      return { messageId: "ext-1", threadId: "thread-1" };
    },
  };

  // Kick off two flushes concurrently. The first acquires the lock and enters
  // send() (then blocks); the second finds the lock busy and no-ops immediately.
  const p1 = flushOutbound(email, r.messageId, deps);
  // Give p1 a tick to acquire the lock before p2 tries.
  await new Promise<void>((res) => setTimeout(res, 5));
  const p2 = flushOutbound(email, r.messageId, deps);
  const f2 = await p2;
  assert.equal(f2.skipped, true, "the loser (busy lock) no-ops without sending");

  releaseSend();
  const f1 = await p1;
  assert.equal(f1.skipped, false, "the winner sends");
  assert.equal(sends, 1, "provider.send invoked EXACTLY once");
  assert.equal(rows.get("negotiation:counter:i1:1").externalMessageId, "ext-1");
});

test("§4.2a: a flush that acquires the lock AFTER the winner finalized re-checks NULL and no-ops", async () => {
  // Sequential: first flush finalizes. Then a second flush acquires the lock fine
  // (it's free now) but the post-lock NULL re-check sees the finalized row → no-op.
  const { deps } = makeFlushDeps();
  const { email, sends } = makeEmail();
  const r = await reserveOutbound("i1", draft, "negotiation:counter:i1:1", deps);
  await flushOutbound(email, r.messageId, deps); // finalizes
  const f2 = await flushOutbound(email, r.messageId, deps);
  assert.equal(f2.skipped, true);
  assert.equal(sends(), 1, "post-lock NULL re-check prevents the second send");
});
