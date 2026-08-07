/**
 * PLU-110 — AC-15 executor harness. Drives the REAL executeNegotiationFollowUp
 * across every branch with injected email/agent providers and DB deps (the same
 * deps-seam pattern as reserveOutbound / sendDelaySweep), so no Neon singleton is
 * touched. Covers: disabled → no follow-up, unanswered offer → nudge reserved,
 * max attempts → NO_RESPONSE, guard leak → MANUAL_REVIEW (counter NOT advanced),
 * null-draft → MANUAL_REVIEW, and the budget reset semantics.
 *
 * Run:  node --import tsx --test src/engine/executors/negotiationFollowUp.e2e.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeNegotiationFollowUp,
  type NegotiationFollowUpDeps,
} from "./negotiation.js";
import type { ExecutionContext, NodeResult, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import type { ConversationObligation } from "../../db/schema.js";

const CAMPAIGN = { name: "Test Campaign" } as never;

function ctx(over: {
  followUpCount?: number;
  round?: number;
  config?: Record<string, unknown>;
} = {}): ExecutionContext {
  const config = over.config ?? { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2 };
  return {
    instance: {
      id: "inst-1",
      currentState: "AWAITING_REPLY",
      currentNodeId: "node-negotiation",
      negotiationRound: over.round ?? 1,
      negotiationFollowUpCount: over.followUpCount ?? 0,
      version: 3,
    } as never,
    node: { id: "node-negotiation", type: "NEGOTIATION", order: 3, config },
    nodeGraph: [{ id: "node-negotiation", type: "NEGOTIATION", order: 3, config }],
    creator: { id: "cr-1", name: "Maya", email: "maya@test.local" } as never,
    campaign: CAMPAIGN,
  };
}

// An email provider whose template draft() returns a fixed body (used as the
// fallback when the agent returns null). The agent draft is controlled per test.
function providers(opts: {
  aiBody?: string | null; // null → agent.draftEmail returns null (fallback path)
  templateBody?: string;
  generatesDraftCopy?: boolean;
}): { email: IEmailProvider; agent: IAgentProvider } {
  const email = {
    async draft(): Promise<EmailDraft> {
      return { subject: "Following up", body: opts.templateBody ?? "Just circling back!" };
    },
  } as unknown as IEmailProvider;
  const agent = {
    generatesDraftCopy: opts.generatesDraftCopy ?? false,
    async draftEmail(): Promise<EmailDraft | null> {
      return opts.aiBody === undefined
        ? null
        : opts.aiBody === null
          ? null
          : { subject: "Following up", body: opts.aiBody };
    },
  } as unknown as IAgentProvider;
  return { email, agent };
}

function deps(over: Partial<NegotiationFollowUpDeps> & { reserved?: unknown } = {}): {
  d: NegotiationFollowUpDeps;
  reservedKeys: string[];
} {
  const reservedKeys: string[] = [];
  const d: NegotiationFollowUpDeps = {
    async listOpenObligations(): Promise<ConversationObligation[]> {
      return [];
    },
    async reserveReply(_instanceId, _draft, key, _campaign) {
      reservedKeys.push(key);
      return { deferredSend: { messageId: "msg-1", delayMs: 60_000 }, sendScheduledInMs: 60_000 };
    },
    ...over,
  };
  return { d, reservedKeys };
}

test("disabled config → quiesce, clears dueAt, reserves nothing", async () => {
  const { d, reservedKeys } = deps();
  const { email, agent } = providers({ aiBody: "hi" });
  const r: NodeResult = await executeNegotiationFollowUp(
    ctx({ config: {} }), // no negotiationFollowUpEnabled ⇒ off
    email,
    agent,
    { negotiationFollowUpEnabled: false },
    d,
  );
  assert.equal(r.nextState, "AWAITING_REPLY");
  assert.equal(r.dueAt, null);
  assert.equal(reservedKeys.length, 0, "a disabled node never sends a nudge");
  assert.equal(r.negotiationFollowUpCount, undefined, "counter untouched when disabled");
});

test("max attempts reached → NO_RESPONSE, reserves nothing", async () => {
  const { d, reservedKeys } = deps();
  const { email, agent } = providers({ aiBody: "hi" });
  const r = await executeNegotiationFollowUp(
    ctx({ followUpCount: 2, config: { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2 } }),
    email,
    agent,
    { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2 },
    d,
  );
  assert.equal(r.nextState, "NO_RESPONSE");
  assert.equal(r.completedAt instanceof Date, true);
  assert.equal(r.dueAt, null);
  assert.equal(reservedKeys.length, 0, "an exhausted conversation is not nudged again");
});

test("unanswered offer → nudge reserved, counter advances, dueAt cleared for the flush hook", async () => {
  const { d, reservedKeys } = deps();
  const { email, agent } = providers({ aiBody: "Just following up on our offer!" });
  const r = await executeNegotiationFollowUp(
    ctx({ followUpCount: 0 }),
    email,
    agent,
    { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2 },
    d,
  );
  assert.equal(r.nextState, "AWAITING_REPLY");
  assert.equal(r.negotiationFollowUpCount, 1, "attempt 0 → commit 1 (counter MUST advance)");
  assert.equal(r.dueAt, null, "flush hook writes the next dueAt from sentAt");
  assert.equal(r.eventType, "FOLLOW_UP_DUE");
  assert.deepEqual(reservedKeys, ["negotiation-followup:inst-1:0"], "key = attempt index (0-based)");
});

test("second attempt keys on the pre-increment count (1)", async () => {
  const { d, reservedKeys } = deps();
  const { email, agent } = providers({ aiBody: "Second nudge" });
  const r = await executeNegotiationFollowUp(
    ctx({ followUpCount: 1 }),
    email,
    agent,
    { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2 },
    d,
  );
  assert.equal(r.negotiationFollowUpCount, 2);
  assert.deepEqual(reservedKeys, ["negotiation-followup:inst-1:1"]);
});

test("guard leak → MANUAL_REVIEW, counter NOT advanced, reserves nothing", async () => {
  const { d, reservedKeys } = deps();
  // config carries a band (maxBudget 500 → ceiling), and the AI body leaks "500".
  const leakyConfig = {
    negotiationFollowUpEnabled: true,
    negotiationFollowUpMaxCount: 2,
    minBudget: 200,
    maxBudget: 500,
  };
  const { email, agent } = providers({ aiBody: "We can do 500 dollars for you." });
  const r = await executeNegotiationFollowUp(ctx({ config: leakyConfig }), email, agent, leakyConfig, d);
  assert.equal(r.nextState, "MANUAL_REVIEW", "a leaked ceiling halts for a human");
  assert.equal(r.negotiationFollowUpCount, undefined, "the counter is NOT advanced on a blocked nudge");
  assert.equal(reservedKeys.length, 0, "nothing is reserved when the guard blocks");
});

test("null AI draft + generatesDraftCopy → MANUAL_REVIEW (draft unavailable)", async () => {
  const { d, reservedKeys } = deps();
  const { email, agent } = providers({ aiBody: null, generatesDraftCopy: true });
  const r = await executeNegotiationFollowUp(
    ctx(),
    email,
    agent,
    { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2 },
    d,
  );
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(reservedKeys.length, 0);
});

test("null AI draft WITHOUT generatesDraftCopy → template fallback is sent", async () => {
  const { d, reservedKeys } = deps();
  // mock/template provider: generatesDraftCopy=false, so a null AI draft means
  // "use the template", NOT escalate.
  const { email, agent } = providers({ aiBody: null, templateBody: "Circling back!", generatesDraftCopy: false });
  const r = await executeNegotiationFollowUp(
    ctx(),
    email,
    agent,
    { negotiationFollowUpEnabled: true, negotiationFollowUpMaxCount: 2, negotiationFollowUpBodyTemplate: "Circling back!" },
    d,
  );
  assert.equal(r.nextState, "AWAITING_REPLY", "template fallback nudge is sent, not escalated");
  assert.deepEqual(reservedKeys, ["negotiation-followup:inst-1:0"]);
});
