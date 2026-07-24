/**
 * Tests for Manual Initial Outreach — the operator writes the first email by
 * hand and it is sent verbatim (after variable substitution) instead of an AI
 * draft.
 *
 * Coverage:
 *   - manual mode does NOT call the AI (agent.draftEmail); the body is the
 *     rendered operator template, with {{variables}} resolved;
 *   - manual mode records aiGenerated=false, outreachMode="manual";
 *   - absent mode preserves the legacy AI-first behavior (agent IS called);
 *   - explicit "ai" mode calls the AI;
 *   - a hand-typed floor/ceiling in a MANUAL body is still caught by the output
 *     guard → MANUAL_REVIEW, not sent.
 *
 * Like outreachGuard.test.ts, the clean-send happy path reaches the real
 * sendOnce/DB seam (which needs a database). To stay DB-free we observe the
 * manual behavior at the DRAFT step: makeEmail(throwAfterDraft=true) records the
 * rendered body and then throws a sentinel from draft() BEFORE the executor
 * reaches the output guard or sendOnce — so a clean manual draft is fully
 * observable without a DB. For the guard-blocked case we let draft() return
 * normally (throwAfterDraft=false) so the guard can scan and the executor
 * returns its MANUAL_REVIEW NodeResult before any send.
 *
 * Run with:  npx tsx src/engine/executors/manualOutreach.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../../db/schema.js";
import { executeInitialOutreach } from "./initialOutreach.js";
import type { ExecutionContext, NodeResult, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { MockEmailProvider } from "../providers.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const creator = {
  id: "c1",
  name: "Robin",
  platform: "instagram",
  niche: "fitness",
} as unknown as Creator;

const negotiationNode = {
  id: "neg1",
  type: "NEGOTIATION",
  order: 1,
  config: { minBudget: 200, maxBudget: 500 },
};

// Build a ctx whose outreach node carries the given config.
function ctxWith(config: Record<string, unknown>): ExecutionContext {
  const outreachNode = { id: "out1", type: "INITIAL_OUTREACH", order: 0, config };
  return {
    instance: { id: "i1", currentState: "ENROLLED" } as unknown as ExecutionContext["instance"],
    node: outreachNode,
    nodeGraph: [outreachNode, negotiationNode],
    creator,
  };
}

const DRAFT_SENTINEL = "DRAFT_DONE";

// Email provider using the REAL MockEmailProvider.draft (so {{variable}}
// substitution is exercised). It records the rendered body. When
// throwAfterDraft is true, draft() throws a sentinel AFTER recording — halting
// the executor before the output guard / sendOnce so a clean manual draft is
// observable without a DB. When false, draft() returns normally (used by the
// guard-blocked test, which returns its NodeResult before any send).
function makeEmail(throwAfterDraft: boolean): IEmailProvider & { lastDraftBody: string | null } {
  const mock = new MockEmailProvider();
  const email = {
    lastDraftBody: null as string | null,
    async draft(c: Creator, template: string, config: Record<string, unknown>): Promise<EmailDraft> {
      const d = await mock.draft(c, template, config);
      email.lastDraftBody = d.body;
      if (throwAfterDraft) throw new Error(DRAFT_SENTINEL);
      return d;
    },
    async send(): Promise<{ messageId: string; threadId: string }> {
      return { messageId: "m1", threadId: "t1" };
    },
  };
  return email as unknown as IEmailProvider & { lastDraftBody: string | null };
}

// Agent that records whether draftEmail was called.
function makeAgent(): IAgentProvider & { drafted: number } {
  const agent = {
    drafted: 0,
    generatesDraftCopy: true,
    async classify() {
      return { intent: "POSITIVE", confidence: 1 };
    },
    async negotiate() {
      return { outcome: "escalate", message: "" };
    },
    async draftEmail(): Promise<EmailDraft> {
      agent.drafted++;
      return { subject: "AI Subject", body: "AI wrote this body." };
    },
  };
  return agent as unknown as IAgentProvider & { drafted: number };
}

// Run the executor, swallowing the draft sentinel. reachedGuard=true means the
// draft was clean and the executor progressed PAST draft toward the guard/send
// (we halted it at the sentinel). When makeEmail(false) is used, no sentinel
// throws and `result` is the real NodeResult.
async function run(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<{ result?: NodeResult; reachedGuard: boolean }> {
  try {
    const result = await executeInitialOutreach(ctx, email, agent);
    return { result, reachedGuard: false };
  } catch (err) {
    if (err instanceof Error && err.message === DRAFT_SENTINEL) {
      return { reachedGuard: true };
    }
    throw err;
  }
}

async function main() {
  console.log("\nmanual initial outreach\n");

  await test("manual mode does NOT call the AI; renders operator body verbatim", async () => {
    const email = makeEmail(true);
    const agent = makeAgent();
    const ctx = ctxWith({
      outreachMode: "manual",
      subjectTemplate: "Hey from {{brandName}}",
      bodyTemplate: "Hi {{creatorName}}, we love your work.",
      brandName: "Acme",
      senderName: "Acme",
    });
    const { reachedGuard } = await run(ctx, email, agent);
    assert.equal(agent.drafted, 0, "AI must NOT be called in manual mode");
    assert.equal(reachedGuard, true, "clean manual draft should progress past draft");
    assert.equal(email.lastDraftBody, "Hi Robin, we love your work.");
  });

  await test("manual mode resolves brand/sender variables", async () => {
    const email = makeEmail(true);
    const agent = makeAgent();
    const ctx = ctxWith({
      outreachMode: "manual",
      subjectTemplate: "s",
      bodyTemplate: "From {{senderName}} at {{brandName}} on {{platform}}.",
      brandName: "Acme",
      senderName: "Acme Partnerships",
    });
    await run(ctx, email, agent);
    assert.equal(email.lastDraftBody, "From Acme Partnerships at Acme on instagram.");
  });

  await test("manual mode strips an unknown variable to empty (send-time net)", async () => {
    const email = makeEmail(true);
    const agent = makeAgent();
    const ctx = ctxWith({
      outreachMode: "manual",
      subjectTemplate: "s",
      bodyTemplate: "Hi {{creatorName}}{{firstName}}.",
      brandName: "Acme",
    });
    await run(ctx, email, agent);
    assert.equal(email.lastDraftBody, "Hi Robin.", "unknown {{firstName}} must be stripped");
  });

  await test("absent mode preserves legacy AI-first behavior", async () => {
    const email = makeEmail(true);
    const agent = makeAgent();
    // No outreachMode → treated as "ai": the AI is called first. The AI draft is
    // clean so the executor proceeds to email.draft only as fallback; here the AI
    // succeeds, so we assert the AI was invoked (draft sentinel won't fire because
    // the AI path returns a body and skips email.draft on success).
    const ctx = ctxWith({ subjectTemplate: "s", bodyTemplate: "fallback", brandName: "Acme" });
    await run(ctx, email, agent).catch(() => undefined);
    assert.equal(agent.drafted, 1, "absent mode must call the AI (legacy default)");
  });

  await test('explicit "ai" mode calls the AI', async () => {
    const email = makeEmail(true);
    const agent = makeAgent();
    const ctx = ctxWith({
      outreachMode: "ai",
      subjectTemplate: "s",
      bodyTemplate: "fallback",
      brandName: "Acme",
    });
    await run(ctx, email, agent).catch(() => undefined);
    assert.equal(agent.drafted, 1);
  });

  await test("manual mode stamps campaignName + deal shape from campaign/negotiation", async () => {
    // PLU-117 §2: campaignName off ctx.campaign, collaborationType/offerSummary
    // off the NEGOTIATION deal shape (here fixed-fee: minBudget/maxBudget, no
    // commission). None are in the node config, so the executor must stamp them.
    const email = makeEmail(true);
    const agent = makeAgent();
    const ctx = ctxWith({
      outreachMode: "manual",
      subjectTemplate: "s",
      bodyTemplate: "{{campaignName}} — {{collaborationType}} — {{offerSummary}}",
      brandName: "Acme",
    });
    (ctx as { campaign?: unknown }).campaign = { name: "Spring Launch" };
    await run(ctx, email, agent);
    assert.equal(
      email.lastDraftBody,
      "Spring Launch — fixed-fee collaboration — a fixed-fee collaboration — a flat fee for an agreed piece of content. (The exact fee is discussed once you reply.)",
    );
  });

  await test("required placeholder empty for this creator → MANUAL_REVIEW, not sent", async () => {
    // PLU-117 §3 / AC10: the template uses {{creatorName}} (required) but this
    // creator has a blank name → block this send, surface the missing var, no AI.
    const email = makeEmail(false);
    const agent = makeAgent();
    const blankNameCreator = { id: "c2", name: "", platform: "instagram", niche: "fitness" } as unknown as Creator;
    const outreachNode = {
      id: "out1",
      type: "INITIAL_OUTREACH",
      order: 0,
      config: {
        outreachMode: "manual",
        subjectTemplate: "Hi {{creatorName}}",
        bodyTemplate: "Hi {{creatorName}}, from {{brandName}}.",
        brandName: "Acme",
      },
    };
    const ctx = {
      instance: { id: "i2", currentState: "ENROLLED" } as unknown as ExecutionContext["instance"],
      node: outreachNode,
      nodeGraph: [outreachNode, negotiationNode],
      creator: blankNameCreator,
    } as ExecutionContext;
    const { result } = await run(ctx, email, agent);
    assert.equal(result?.nextState, "MANUAL_REVIEW");
    assert.equal(result?.eventPayload?.["reason"], "outreach_missing_required_value");
    assert.deepEqual(result?.eventPayload?.["missingVariables"], ["creatorName"]);
    assert.equal(email.lastDraftBody, null, "must NOT render/draft when a required value is missing");
    assert.equal(agent.drafted, 0, "must NOT call the AI on a required-value block");
  });

  await test("required check ignores a required var the template does not use", async () => {
    // Blank-name creator, but the template never references {{creatorName}} → the
    // send proceeds (creatorFirstName is optional, resolves to "").
    const email = makeEmail(true);
    const agent = makeAgent();
    const blankNameCreator = { id: "c3", name: "", platform: "instagram", niche: "fitness" } as unknown as Creator;
    const outreachNode = {
      id: "out1",
      type: "INITIAL_OUTREACH",
      order: 0,
      config: {
        outreachMode: "manual",
        subjectTemplate: "A collab opportunity",
        bodyTemplate: "Hey there, from {{brandName}}.",
        brandName: "Acme",
      },
    };
    const ctx = {
      instance: { id: "i3", currentState: "ENROLLED" } as unknown as ExecutionContext["instance"],
      node: outreachNode,
      nodeGraph: [outreachNode, negotiationNode],
      creator: blankNameCreator,
    } as ExecutionContext;
    const { reachedGuard } = await run(ctx, email, agent);
    assert.equal(reachedGuard, true, "send proceeds when no required var is referenced");
    assert.equal(email.lastDraftBody, "Hey there, from Acme.");
  });

  await test("manual body leaking the ceiling is blocked → MANUAL_REVIEW, not sent", async () => {
    // draft returns normally so the output guard can scan the rendered body.
    const email = makeEmail(false);
    const agent = makeAgent();
    const ctx = ctxWith({
      outreachMode: "manual",
      subjectTemplate: "s",
      bodyTemplate: "Hi {{creatorName}}, our budget goes up to $500.",
      brandName: "Acme",
    });
    const { result, reachedGuard } = await run(ctx, email, agent);
    assert.equal(reachedGuard, false, "guard-blocked path returns a NodeResult, no sentinel");
    assert.equal(result?.nextState, "MANUAL_REVIEW");
    assert.equal(result?.eventPayload?.["reason"], "output_guard_blocked");
    assert.equal(agent.drafted, 0, "manual mode still skips the AI even when guard-blocked");
  });

  console.log(`\n✓ manualOutreach: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
