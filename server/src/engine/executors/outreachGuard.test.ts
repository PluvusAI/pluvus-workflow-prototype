/**
 * Tests for the output-guard net on outreach + follow-up (H4).
 *
 * Regression target: the output guard is documented as a MANDATORY net before
 * ANY AI-generated email is sent, but initialOutreach/followUp sent unguarded —
 * a model that leaked the internal floor/ceiling into an outreach body had no
 * backstop. These executors now scan the rendered draft and route a leak to
 * MANUAL_REVIEW instead of emailing the creator. The state machine now permits
 * ENROLLED→MANUAL_REVIEW and AWAITING_REPLY→MANUAL_REVIEW for exactly this.
 *
 * Run with:  npx tsx src/engine/executors/outreachGuard.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../../db/schema.js";
import { executeInitialOutreach } from "./initialOutreach.js";
import type { SendOnceDeps } from "./idempotentSend.js";
import { assertTransition } from "../stateMachine.js";
import type { ExecutionContext, NodeResult, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const creator = { id: "c1", name: "Robin", platform: "instagram", niche: "fitness" } as unknown as Creator;

// A NEGOTIATION node carrying the internal band. 200 is the floor, 500 the
// ceiling — neither may appear in an outreach body.
const negotiationNode = {
  id: "neg1",
  type: "NEGOTIATION",
  order: 1,
  config: { minBudget: 200, maxBudget: 500 },
};
const outreachNode = { id: "out1", type: "INITIAL_OUTREACH", order: 0, config: {} };

function ctx(): ExecutionContext {
  return {
    instance: { id: "i1", currentState: "ENROLLED" } as unknown as ExecutionContext["instance"],
    node: outreachNode,
    nodeGraph: [outreachNode, negotiationNode],
    creator,
  };
}

// Email provider whose send() records calls so we can assert "never sent".
function makeEmail(): IEmailProvider & { sent: number } {
  const email = {
    sent: 0,
    async draft(): Promise<EmailDraft> {
      return { subject: "s", body: "template" };
    },
    async send() {
      email.sent++;
      return { messageId: "m1", threadId: "t1" };
    },
  };
  return email as IEmailProvider & { sent: number };
}

// Agent that returns a specific AI draft body (generatesDraftCopy=true path).
function agentReturning(body: string): IAgentProvider {
  return {
    generatesDraftCopy: true,
    async classify() {
      return { intent: "POSITIVE", confidence: 1 };
    },
    async negotiate() {
      return { outcome: "escalate", message: "" };
    },
    async draftEmail(): Promise<EmailDraft> {
      return { subject: "Partnership", body };
    },
  } as unknown as IAgentProvider;
}

// PLU-128: a ctx whose INITIAL_OUTREACH node carries the given config, so tests
// can put brand-authored public copy (rewardDescription etc.) on the outreach node.
function ctxWithConfig(config: Record<string, unknown>): ExecutionContext {
  const node = { id: "out1", type: "INITIAL_OUTREACH", order: 0, config };
  return {
    instance: { id: "i1", currentState: "ENROLLED" } as unknown as ExecutionContext["instance"],
    node,
    nodeGraph: [node, negotiationNode],
    creator,
  };
}

// PLU-128: an agent whose draftEmail returns null — the AI-degraded path, so the
// executor falls back to the operator template (email.draft).
function agentReturningNull(): IAgentProvider {
  return {
    generatesDraftCopy: true,
    async classify() {
      return { intent: "POSITIVE", confidence: 1 };
    },
    async negotiate() {
      return { outcome: "escalate", message: "" };
    },
    async draftEmail(): Promise<EmailDraft | null> {
      return null;
    },
  } as unknown as IAgentProvider;
}

// PLU-128: an email provider whose draft() renders a fixed body (the operator
// template already substituted), so the guard scans a known draft. Records sends.
function makeEmailBody(subject: string, body: string): IEmailProvider & { sent: number } {
  const email = {
    sent: 0,
    async draft(): Promise<EmailDraft> {
      return { subject, body };
    },
    async send() {
      email.sent++;
      return { messageId: "m1", threadId: "t1" };
    },
  };
  return email as IEmailProvider & { sent: number };
}

// PLU-128: an in-memory SendOnceDeps (mirrors sendDelaySplit.test.ts) so a CLEAN
// draft reaches reserveOutbound and the executor returns its real NodeResult —
// OUTREACH_QUEUED + the event payload — without a live DB.
function makeReserveDeps(): SendOnceDeps {
  const rows = new Map<string, { id: string; idempotencyKey: string; externalMessageId: string | null }>();
  let seq = 0;
  return {
    async createMessage(data) {
      const key = data.idempotencyKey as string;
      const row = { id: `m${++seq}`, idempotencyKey: key, externalMessageId: null };
      rows.set(key, row);
      return row as never;
    },
    async findMessageByIdempotencyKey(key: string) {
      return (rows.get(key) ?? null) as never;
    },
    async updateMessageSent(id, d) {
      return { id, ...d } as never;
    },
    threadContext: {
      async resolve() {
        return {};
      },
    },
  };
}

async function main() {
  console.log("\noutreach/follow-up output guard (H4)\n");

  await test("state machine now permits ENROLLED → MANUAL_REVIEW", () => {
    assertTransition("ENROLLED", "MANUAL_REVIEW"); // must not throw
    assertTransition("AWAITING_REPLY", "MANUAL_REVIEW");
    return Promise.resolve();
  });

  await test("outreach draft leaking the ceiling is blocked → MANUAL_REVIEW, not sent", async () => {
    const email = makeEmail();
    const agent = agentReturning("Hi Robin, our budget goes up to $500 for this campaign.");
    const result: NodeResult = await executeInitialOutreach(ctx(), email, agent);
    assert.equal(result.nextState, "MANUAL_REVIEW");
    assert.equal(result.eventPayload?.["reason"], "output_guard_blocked");
    assert.equal(email.sent, 0, "leaking outreach must NOT be sent");
  });

  await test("outreach draft leaking the floor is blocked", async () => {
    const email = makeEmail();
    const agent = agentReturning("Hi Robin, we start creators at $200.");
    const result = await executeInitialOutreach(ctx(), email, agent);
    assert.equal(result.nextState, "MANUAL_REVIEW");
    assert.equal(email.sent, 0);
  });

  // NOTE: the clean-draft "proceeds to send" path is intentionally NOT tested
  // here — it reaches the real sendOnce/DB seam, which needs a database. The
  // guard's pass-through (clean draft → ok) is covered by outputGuard.test.ts;
  // this file's job is to prove outreach/follow-up now INVOKE the guard and halt
  // on a leak before any send.

  console.log("\nPLU-128 — authorized public $ amounts in initial outreach\n");

  // B6 — AC1 + AC2 (AI-null fallback SENDS): AI draft returns null → operator
  // template used. The rendered body says $200, authorized by the node's
  // rewardDescription. With the injected DB seam the guard runs (unlike the old
  // sentinel tests) and the draft QUEUES rather than routing to MANUAL_REVIEW.
  await test("AI-null fallback: $200 authorized by rewardDescription sends (QUEUED)", async () => {
    const email = makeEmailBody("Partnership", "Hi Robin, you'll receive a $200 gift box.");
    const ctx = ctxWithConfig({ rewardDescription: "a $200 gift box", bodyTemplate: "t" });
    const result = await executeInitialOutreach(ctx, email, agentReturningNull(), makeReserveDeps());
    assert.equal(result.nextState, "OUTREACH_QUEUED", "authorized $200 must send, not escalate");
    assert.notEqual(result.eventPayload?.["reason"], "output_guard_blocked");
  });

  // B7 — AC3: a $200 in the rendered body with NO trusted field authorizing it is
  // still blocked. (No seam needed — the executor returns before reserve.)
  await test("arbitrary $200 (no trusted field) is blocked → MANUAL_REVIEW, not sent", async () => {
    const email = makeEmailBody("Partnership", "Hi Robin, here's a $200 bonus.");
    const ctx = ctxWithConfig({ bodyTemplate: "t" }); // no rewardDescription/etc.
    const result = await executeInitialOutreach(ctx, email, agentReturningNull());
    assert.equal(result.nextState, "MANUAL_REVIEW");
    assert.equal(result.eventPayload?.["reason"], "output_guard_blocked");
    assert.equal(email.sent, 0);
  });

  // B8 — AC4: the ceiling ($500 from the band) in the body with NO authorizing
  // field stays blocked; the SAME $500 authorized in the node's rewardDescription
  // sends. Proves "genuinely authorized in trusted public copy" is the line.
  await test("ceiling $500 blocks unless it is in trusted public copy", async () => {
    const emailBlocked = makeEmailBody("Partnership", "We can go up to $500 for this.");
    const blocked = await executeInitialOutreach(
      ctxWithConfig({ bodyTemplate: "t" }),
      emailBlocked,
      agentReturningNull(),
    );
    assert.equal(blocked.nextState, "MANUAL_REVIEW");
    assert.equal(emailBlocked.sent, 0);

    const emailOk = makeEmailBody("Partnership", "You'll get a $500 product bundle.");
    const ok = await executeInitialOutreach(
      ctxWithConfig({ rewardDescription: "a $500 product bundle", bodyTemplate: "t" }),
      emailOk,
      agentReturningNull(),
      makeReserveDeps(),
    );
    assert.equal(ok.nextState, "OUTREACH_QUEUED", "a $500 the brand published is authorized");
  });

  // B9 — AC5: an unauthorized commission % is blocked even when public copy is
  // present (public copy contributes only $ to the allowlist, never a commission).
  await test("unauthorized commission % blocked even with public copy present", async () => {
    const email = makeEmailBody("Partnership", "Great news — a 15% commission on all sales!");
    const ctx = ctxWithConfig({ rewardDescription: "a $200 gift box", bodyTemplate: "t" });
    // The band lives on negotiationNode; the commission rate must be on the
    // NEGOTIATION config for the guard to enforce it. Add it there for this test.
    const negWithCommission = { ...negotiationNode, config: { ...negotiationNode.config, commissionRate: 10 } };
    ctx.nodeGraph = [ctx.node, negWithCommission];
    const result = await executeInitialOutreach(ctx, email, agentReturningNull());
    assert.equal(result.nextState, "MANUAL_REVIEW");
    assert.equal(result.eventPayload?.["reason"], "output_guard_blocked");
    assert.equal(email.sent, 0);
  });

  // B10 — AC7 (observability): the AI-null fallback records a distinct, auditable
  // reason. A successful AI draft records NO fallback reason.
  await test("AI-null fallback records templateFallbackReason; AI success does not", async () => {
    const emailNull = makeEmailBody("Partnership", "Hi Robin, you'll receive a $200 gift box.");
    const ctxNull = ctxWithConfig({ rewardDescription: "a $200 gift box", bodyTemplate: "t" });
    const nullResult = await executeInitialOutreach(ctxNull, emailNull, agentReturningNull(), makeReserveDeps());
    assert.equal(nullResult.nextState, "OUTREACH_QUEUED");
    assert.equal(nullResult.eventPayload?.["templateFallbackReason"], "ai_draft_unavailable");
    assert.equal(nullResult.eventPayload?.["aiGenerated"], false);

    // AI succeeds (clean body, no $) → ordinary AI send, no fallback reason.
    const emailOk = makeEmailBody("unused", "unused");
    const ctxOk = ctxWithConfig({ bodyTemplate: "t" });
    const okResult = await executeInitialOutreach(
      ctxOk,
      emailOk,
      agentReturning("Hi Robin, we'd love to collaborate with you."),
      makeReserveDeps(),
    );
    assert.equal(okResult.nextState, "OUTREACH_QUEUED");
    assert.equal(okResult.eventPayload?.["templateFallbackReason"], undefined);
    assert.equal(okResult.eventPayload?.["aiGenerated"], true);
  });

  console.log(`\n✓ outreachGuard: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
