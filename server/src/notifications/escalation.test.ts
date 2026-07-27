/**
 * Unit tests for the manual-queue escalation notifier (Phase 11).
 * In-memory fakes for the DB seam + email provider — no live database.
 * Run with:  npx tsx src/notifications/escalation.test.ts
 */

import assert from "node:assert/strict";
import type { BrandNotification, Creator } from "../db/schema.js";
import {
  notifyBrandOfEscalation,
  resolveBrandRecipient,
  buildEscalationEmail,
  type EscalationDeps,
} from "./escalation.js";
import type { IEmailProvider } from "../engine/providers.js";

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
  handle: "robinv",
  platform: "YouTube",
  niche: "fitness",
} as unknown as Creator;

// Build a deps seam over an in-memory "BrandNotification table" that enforces the
// unique idempotencyKey constraint (throws a P2002-shaped error on duplicate),
// plus a context loader and an event recorder.
function makeDeps(opts?: {
  notifyEmail?: string | null;
  contextNull?: boolean;
  transcript?: import("../adapters/negotiation/types.js").DraftHistoryEntry[];
  threadId?: string | null;
}) {
  const rows = new Map<string, BrandNotification>();
  const events: Array<{ type: string; payload: unknown }> = [];
  let seq = 0;

  const deps: EscalationDeps = {
    async loadContext() {
      if (opts?.contextNull) return null;
      return {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: opts?.notifyEmail ?? null,
        transcript: opts?.transcript ?? [],
        threadId: opts?.threadId ?? null,
        gmailRfc822MessageId: null,
      };
    },
    async createBrandNotification(data: any) {
      const key = data.idempotencyKey as string;
      if (rows.has(key)) {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        throw err;
      }
      const row = {
        id: `bn${++seq}`,
        instanceId: "i1",
        recipient: data.recipient,
        reason: data.reason,
        status: data.status,
        idempotencyKey: key,
        error: null,
        createdAt: new Date(),
      } as unknown as BrandNotification;
      rows.set(key, row);
      return row;
    },
    async findBrandNotificationByKey(key: string) {
      return rows.get(key) ?? null;
    },
    async updateBrandNotificationStatus(id: string, d) {
      const row = [...rows.values()].find((r) => r.id === id)!;
      (row as any).status = d.status;
      (row as any).error = d.error ?? null;
      return row;
    },
    async appendEvent(data: any) {
      events.push({ type: data.type, payload: data.payload });
      return { id: `e${events.length}` } as any;
    },
  };
  return { deps, rows, events };
}

function makeEmail(opts?: { throwOnSend?: boolean; threadUrl?: boolean }) {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const email: IEmailProvider = {
    async draft() {
      return { subject: "", body: "" };
    },
    // CRITICAL-2: the real send() signature is (draft, creator, recipient?). Brand
    // outbound now passes the brand as the explicit 3rd-arg recipient instead of
    // forging a Creator in arg 2, so the captured "to" reads the recipient when
    // present (the brand) and the creator otherwise.
    async send(draft, creator, recipient) {
      if (opts?.throwOnSend) throw new Error("smtp unreachable");
      sent.push({
        to: recipient?.email ?? creator.email,
        subject: draft.subject,
        body: draft.body,
      });
      return { messageId: `ext-${sent.length}`, threadId: `thread-${sent.length}` };
    },
    // E6: only some providers expose a thread deep-link builder. When enabled,
    // return a URL for any non-empty threadId (mirroring the Nylas provider's
    // configured-template behavior).
    ...(opts?.threadUrl
      ? {
          threadUrl(threadId: string) {
            return threadId ? `https://mail.example.test/threads/${threadId}` : undefined;
          },
        }
      : {}),
  };
  return { email, sent };
}

async function main() {
  console.log("\nnotifyBrandOfEscalation\n");

  await test("resolveBrandRecipient: campaign > env > operator default", async () => {
    assert.equal(resolveBrandRecipient("brand@acme.com"), "brand@acme.com");
    const prev = process.env["BRAND_NOTIFY_EMAIL"];
    process.env["BRAND_NOTIFY_EMAIL"] = "ops@platform.com";
    assert.equal(resolveBrandRecipient(null), "ops@platform.com");
    assert.equal(resolveBrandRecipient(" "), "ops@platform.com");
    delete process.env["BRAND_NOTIFY_EMAIL"];
    // Falls back to the hard-coded operator address.
    assert.equal(resolveBrandRecipient(null), "affiliatepartner@pluvus.com");
    if (prev !== undefined) process.env["BRAND_NOTIFY_EMAIL"] = prev;
  });

  await test("buildEscalationEmail names the creator, brand and reason", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: null,
        gmailRfc822MessageId: null,
      },
      "low_confidence_reply",
    );
    assert.match(draft.subject, /Robin Vega/);
    assert.match(draft.body, /Acme Co/);
    assert.match(draft.body, /robin@creators\.test/);
    assert.match(draft.body, /could not confidently classify/);
    // First-turn escalation (empty transcript) has no conversation block.
    assert.ok(!/Conversation so far/.test(draft.body));
    // E6: no threadId + no URL builder → the thread link is omitted.
    assert.ok(!/Open the full email thread/.test(draft.body));
  });

  await test("buildEscalationEmail no longer inlines the transcript, but keeps the rest", async () => {
    // The inline conversation block is TEMPORARILY DISABLED (the Gmail deep-link
    // opens the real thread instead). The rest of the notice is unchanged.
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [
          { role: "creator", message: "What's the pay and timeline?" },
          { role: "us", round: 1, action: "PRESENT_OFFER", rate: 350, message: "We can offer $350." },
          { role: "creator", message: "I want 40% commission or this doesn't happen." },
        ],
        threadId: null,
        gmailRfc822MessageId: null,
      },
      "pricing_exception",
    );
    // The inline conversation block is gone.
    assert.ok(!/Conversation so far/.test(draft.body));
    assert.ok(!/I want 40% commission/.test(draft.body));
    // …but the who/why and reply instructions still render.
    assert.match(draft.body, /Robin Vega/);
    assert.match(draft.body, /custom fee structure, bonus, or guarantee/); // pricing_exception reason label
    assert.match(draft.body, /reply to Robin Vega directly at robin@creators\.test/);
    assert.match(draft.body, /Replying to THIS notification does nothing/);
  });

  await test("content-links escalation lists the submitted URLs (each openable) + count, no transcript", async () => {
    const urls = [
      "https://instagram.com/reel/abc",
      "https://tiktok.com/@robin/video/123",
    ];
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [
          { role: "creator", message: "here are my links" },
        ],
        threadId: null,
        gmailRfc822MessageId: null,
        submittedUrls: urls,
      },
      "content_links_submitted",
    );
    // Objective reason label.
    assert.match(draft.body, /submitted content links for review/);
    // Count + each URL rendered verbatim (directly openable), on their own lines.
    assert.match(draft.body, /Submitted content links \(2\):/);
    for (const u of urls) assert.ok(draft.body.includes(u), `body must contain ${u}`);
    // The escalation stays compact — the full transcript is never embedded.
    assert.ok(!/Conversation so far/.test(draft.body));
  });

  await test("content-links section is omitted when there are no submitted URLs", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: null,
        gmailRfc822MessageId: null,
        submittedUrls: [],
      },
      "low_confidence_reply",
    );
    assert.ok(!/Submitted content links/.test(draft.body));
  });

  await test("E6: includes the thread deep-link when a threadId + URL builder are present", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: "thread-xyz",
        gmailRfc822MessageId: null,
      },
      "escalated",
      (threadId) => `https://mail.example.test/threads/${threadId}`,
    );
    assert.match(draft.body, /Open the full email thread: https:\/\/mail\.example\.test\/threads\/thread-xyz/);
  });

  await test("E6: omits the thread link when the provider has no URL builder", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: "thread-xyz", // threadId present …
        gmailRfc822MessageId: null,
      },
      "escalated",
      // … but no URL builder passed → link omitted gracefully (mock-provider path).
    );
    assert.ok(!/Open the full email thread/.test(draft.body));
  });

  await test("E6: omits the thread link when there is no threadId even if a builder exists", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: null, // no thread yet …
        gmailRfc822MessageId: null,
      },
      "escalated",
      // … a builder exists but is never invoked without a threadId.
      (threadId) => `https://mail.example.test/threads/${threadId}`,
    );
    assert.ok(!/Open the full email thread/.test(draft.body));
  });

  await test("E6: notifyBrandOfEscalation threads the provider's threadUrl into the email", async () => {
    const { deps } = makeDeps({ notifyEmail: "brand@acme.com", threadId: "thread-live" });
    const { email, sent } = makeEmail({ threadUrl: true });
    const r = await notifyBrandOfEscalation(email, "i1", "escalated", deps);
    assert.equal(r.status, "SENT");
    assert.equal(sent.length, 1);
    // The provider's threadUrl builder was applied to the resolved threadId.
    assert.match(
      sent[0]!.body,
      /Open the full email thread: https:\/\/mail\.example\.test\/threads\/thread-live/,
    );
  });

  // ── Gmail deep-link (rfc822msgid — cold-load-safe) ─────────────────────────
  await test("Gmail link: prominent section with the default rfc822msgid search URL", async () => {
    delete process.env["GMAIL_THREAD_URL_TEMPLATE"]; // exercise the default template
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: "19f82873dea651de",
        gmailRfc822MessageId: "CALpXEbZ6jsiRZ@mail.gmail.com",
      },
      "escalated",
      // No provider threadUrl builder — the Gmail link is independent of E6.
    );
    assert.match(draft.body, /Official Creator Conversation/);
    assert.match(
      draft.body,
      /Open Gmail Thread: https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/rfc822msgid:CALpXEbZ6jsiRZ(%40|@)mail\.gmail\.com/,
    );
    // The prominent section sits ABOVE the "escalated to the manual review queue" line.
    assert.ok(
      draft.body.indexOf("Official Creator Conversation") <
        draft.body.indexOf("escalated to the manual review queue"),
    );
  });

  await test("Gmail link: honors GMAIL_THREAD_URL_TEMPLATE override with {messageId}", async () => {
    process.env["GMAIL_THREAD_URL_TEMPLATE"] =
      "https://mail.google.com/mail/u/2/#search/rfc822msgid:{messageId}";
    try {
      const draft = buildEscalationEmail(
        {
          creator,
          campaignName: "Summer Launch",
          brandName: "Acme Co",
          workflowName: "Summer Outreach",
          notifyEmail: null,
          transcript: [],
          threadId: "abc123",
          gmailRfc822MessageId: "msg-abc@mail.gmail.com",
        },
        "escalated",
      );
      assert.match(
        draft.body,
        /Open Gmail Thread: https:\/\/mail\.google\.com\/mail\/u\/2\/#search\/rfc822msgid:msg-abc(%40|@)mail\.gmail\.com/,
      );
    } finally {
      delete process.env["GMAIL_THREAD_URL_TEMPLATE"];
    }
  });

  await test("Gmail link: hidden entirely when the rfc822 Message-ID is absent", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: "19f82873dea651de", // a thread exists …
        gmailRfc822MessageId: null, // … but the rfc822 id couldn't be resolved
      },
      "escalated",
    );
    assert.ok(!/Official Creator Conversation/.test(draft.body));
    assert.ok(!/Open Gmail Thread/.test(draft.body));
  });

  await test("fresh escalation sends to the campaign recipient and records SENT", async () => {
    const { deps, rows, events } = makeDeps({ notifyEmail: "brand@acme.com" });
    const { email, sent } = makeEmail();
    const r = await notifyBrandOfEscalation(email, "i1", "low_confidence_reply", deps);
    assert.equal(r.status, "SENT");
    assert.equal(r.recipient, "brand@acme.com");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "brand@acme.com");
    // One audit event of the right type.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "BRAND_NOTIFIED");
    // The reserved row is SENT.
    assert.equal([...rows.values()][0]!.status, "SENT");
  });

  await test("retry of the same escalation does NOT send again (idempotent)", async () => {
    const { deps } = makeDeps({ notifyEmail: "brand@acme.com" });
    const { email, sent } = makeEmail();
    await notifyBrandOfEscalation(email, "i1", "low_confidence_reply", deps);
    const r2 = await notifyBrandOfEscalation(email, "i1", "low_confidence_reply", deps);
    assert.equal(r2.status, "ALREADY_NOTIFIED");
    assert.equal(r2.recipient, "brand@acme.com");
    assert.equal(sent.length, 1, "send() must be called exactly once across both attempts");
  });

  await test("a different reason for the same instance sends a fresh notice", async () => {
    const { deps } = makeDeps({ notifyEmail: "brand@acme.com" });
    const { email, sent } = makeEmail();
    await notifyBrandOfEscalation(email, "i1", "low_confidence_reply", deps);
    await notifyBrandOfEscalation(email, "i1", "output_guard_blocked", deps);
    assert.equal(sent.length, 2, "distinct reasons are distinct escalation events");
  });

  await test("send failure records FAILED and never throws", async () => {
    const { deps, rows, events } = makeDeps({ notifyEmail: "brand@acme.com" });
    const { email } = makeEmail({ throwOnSend: true });
    const r = await notifyBrandOfEscalation(email, "i1", "escalated", deps);
    assert.equal(r.status, "FAILED");
    assert.equal([...rows.values()][0]!.status, "FAILED");
    assert.equal([...rows.values()][0]!.error, "smtp unreachable");
    assert.equal(events.length, 0, "no BRAND_NOTIFIED audit event when the send failed");
  });

  await test("instance/context not found → SKIPPED, no send", async () => {
    // When the instance (and thus its campaign/creator) can't be loaded there is
    // nothing to notify about. Records nothing, sends nothing.
    const { deps } = makeDeps({ contextNull: true });
    const { email, sent } = makeEmail();
    const r = await notifyBrandOfEscalation(email, "i1", "escalated", deps);
    assert.equal(r.status, "SKIPPED");
    assert.equal(sent.length, 0);
  });

  await test("falls back to operator default when campaign has no notifyEmail", async () => {
    const prev = process.env["BRAND_NOTIFY_EMAIL"];
    delete process.env["BRAND_NOTIFY_EMAIL"];
    const { deps } = makeDeps({ notifyEmail: null });
    const { email, sent } = makeEmail();
    const r = await notifyBrandOfEscalation(email, "i1", "escalated", deps);
    assert.equal(r.status, "SENT");
    assert.equal(r.recipient, "affiliatepartner@pluvus.com");
    assert.equal(sent[0]!.to, "affiliatepartner@pluvus.com");
    if (prev !== undefined) process.env["BRAND_NOTIFY_EMAIL"] = prev;
  });

  // PLU-82 §4.5 / §8-h: the new material_knowledge_conflict reason renders its own
  // label in the brand FYI email (not the generic fallback). This is the
  // escalation-side half of the two-map drift guard.
  await test("buildEscalationEmail renders the material_knowledge_conflict reason label", async () => {
    const draft = buildEscalationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
        threadId: null,
        gmailRfc822MessageId: null,
      },
      "material_knowledge_conflict",
    );
    // The specific label, not the "(material_knowledge_conflict)" fallback.
    assert.match(draft.body, /brief and the campaign settings disagree/);
    assert.ok(
      !/it was escalated for human review \(material_knowledge_conflict\)/.test(draft.body),
      "must not fall through to the generic reason fallback",
    );
  });

  console.log(`\n✓ escalation: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
