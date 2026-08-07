/**
 * PLU-110 LIVE harness — drives the negotiation follow-up cycle through REAL
 * infrastructure (Redis + BullMQ workers + poller + live Neon), creating its own
 * disposable fixtures and cleaning them up. EMAIL_PROVIDER=mock so no real email
 * is sent; everything else (runtime dispatch, reserve/flush, flush-anchored
 * scheduling, poller, reply-cancel, exhaustion) is the real code path.
 *
 * Run (from server/):
 *   cross-env EMAIL_PROVIDER=mock NEGOTIATION_PROVIDER=mock \
 *     tsx --include ../.env src/scheduler/negotiationFollowUp.harness.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
// Force safe providers for the harness regardless of .env.
process.env["EMAIL_PROVIDER"] = "mock";
process.env["NEGOTIATION_PROVIDER"] = "mock";
process.env["AGENT_PROVIDER"] = "mock";

import { Worker } from "bullmq";
import {
  createCreator,
  createWorkflow,
  createVersion,
  createInstance,
  findInstanceById,
  updateInstanceState,
  listMessagesByInstance,
} from "../db/index.js";
import { deleteInstanceCascade } from "../db/campaigns.js";
import { db } from "../db/drizzle.js";
import { createNodeExecutionWorker } from "../workers/nodeExecutionWorker.js";
import { createInboundEmailWorker } from "../workers/inboundEmailWorker.js";
import { createDelayedSendWorker } from "../workers/delayedSendWorker.js";
import { closeLockClient, forceReleaseLock } from "./lock.js";
import {
  getNodeExecutionQueue,
  getInboundEmailQueue,
  enqueueInboundEmail,
  enqueueNodeExecution,
} from "../workers/queues.js";
import { flushOutbound } from "../engine/executors/idempotentSend.js";
import { emailProvider } from "../engine/providerFactory.js";
import { scheduleNegotiationFollowUpAfterSend } from "../db/outboundPacing.js";
import { resolveNegotiationFollowUpIntervalMs } from "../engine/executors/negotiation.js";
import type { NodeSnapshot } from "../engine/types.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`  ${m}`);
function section(t: string) {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
}

const NEG_NODE: NodeSnapshot = {
  id: "node-negotiation",
  type: "NEGOTIATION",
  order: 1,
  config: {
    minBudget: 200,
    maxBudget: 500,
    maxRounds: 3,
    commissionRate: 15,
    // Fast intervals so the harness runs in seconds, not days.
    negotiationFollowUpEnabled: true,
    negotiationFollowUpIntervals: [3, 3],
    negotiationFollowUpIntervalUnit: "seconds",
    negotiationFollowUpMaxCount: 2,
    negotiationFollowUpBodyTemplate:
      "Hi {{creatorName}},\n\nJust circling back on our last note — still keen to work with you.\n\nBest,\n{{brandName}} Team",
    brandName: "Acme",
    senderName: "Acme",
  },
};

async function makeInstance(tag: string) {
  const creator = await createCreator({ name: `PLU110 ${tag}`, email: `plu110-${tag}-${Date.now()}@harness.local` });
  const workflow = await createWorkflow({ name: `PLU110 harness ${tag}` });
  const version = await createVersion({ workflowId: workflow.id, version: 1, nodeGraph: [NEG_NODE] as unknown as never });
  const instance = await createInstance({
    workflowVersionId: version.id,
    creatorId: creator.id,
    currentState: "AWAITING_REPLY",
    currentNodeId: NEG_NODE.id,
    negotiationRound: 1,
    negotiationFollowUpCount: 0,
    dueAt: new Date(Date.now() - 1000), // already due
  });
  return { instance, creatorId: creator.id };
}

async function reservedFollowUpKeys(instanceId: string): Promise<string[]> {
  const msgs = await listMessagesByInstance(instanceId);
  return msgs
    .map((m) => m.idempotencyKey ?? "")
    .filter((k) => k.startsWith("negotiation-followup:"));
}

async function waitFor(
  instanceId: string,
  pred: (s: string, count: number) => boolean,
  timeoutMs = 25_000,
): Promise<{ state: string; count: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = await findInstanceById(instanceId);
    if (inst && pred(inst.currentState, inst.negotiationFollowUpCount)) {
      return { state: inst.currentState, count: inst.negotiationFollowUpCount };
    }
    await delay(400);
  }
  const inst = await findInstanceById(instanceId);
  throw new Error(`Timeout: ${instanceId} at state=${inst?.currentState} count=${inst?.negotiationFollowUpCount}`);
}

// ── Scenario 1: unanswered offer → nudge → arm → exhaust → NO_RESPONSE ──────
// The poller→executor→reserve path is fully real. We drive flush + the arm hook
// explicitly (rather than wait on BullMQ's delayed-job promotion timing, which is
// unrelated to PLU-110) — the arm is scheduleNegotiationFollowUpAfterSend, the
// exact prod helper, against live Neon.
async function scenarioCycle(): Promise<void> {
  section("Scenario 1: nudge cycle → exhaustion → NO_RESPONSE");
  const { instance } = await makeInstance("cycle");
  await forceReleaseLock(instance.id);
  log(`created instance ${instance.id} at AWAITING_REPLY (past dueAt), max=2, interval=3s`);

  const email = emailProvider();

  // Enqueue exactly ONE node-execution job (what the poller does) — no continuous
  // poller so jobs can't pile up on the instance lock. Then flush + arm explicitly.
  async function nudgeThenArm(expectedCount: number, keyIndex: number): Promise<void> {
    await forceReleaseLock(instance.id);
    await enqueueNodeExecution({
      instanceId: instance.id,
      expectedState: "AWAITING_REPLY",
      triggerRef: `harness-nudge-${keyIndex}-${Date.now()}`,
    });
    await waitFor(instance.id, (_s, c) => c >= expectedCount);

    const keys = await reservedFollowUpKeys(instance.id);
    const key = `negotiation-followup:${instance.id}:${keyIndex}`;
    if (!keys.includes(key)) throw new Error(`FAIL: nudge did not reserve ${key} (got ${JSON.stringify(keys)})`);
    log(`nudge #${keyIndex}: count=${expectedCount}, reserved ${key}`);

    // Flush the reserved nudge (mock send stamps sentAt), then arm the next dueAt
    // from confirmed send — the real flush-anchored scheduling.
    const msgs = await listMessagesByInstance(instance.id);
    const reserved = msgs.find((m) => m.idempotencyKey === key)!;
    const flush = await flushOutbound(email, reserved.id);
    log(`flushed ${key}: skipped=${flush.skipped}`);

    const inst = await findInstanceById(instance.id);
    const intervalMs = resolveNegotiationFollowUpIntervalMs(NEG_NODE.config, inst!.negotiationFollowUpCount);
    const armed = await scheduleNegotiationFollowUpAfterSend(reserved.id, intervalMs);
    log(`arm result: ${armed} (interval=${intervalMs}ms, index=${inst!.negotiationFollowUpCount})`);
    if (armed !== "scheduled") throw new Error(`FAIL: expected arm 'scheduled', got '${armed}'`);

    const after = await findInstanceById(instance.id);
    if (!after?.dueAt) throw new Error("FAIL: dueAt not armed after confirmed send");
    log(`next dueAt armed: ${after.dueAt.toISOString()}`);
  }

  await nudgeThenArm(1, 0); // attempt 0 → count 1, arm index 1
  await nudgeThenArm(2, 1); // attempt 1 → count 2, arm index 2

  // count(2) >= max(2): one more node-execution step must exhaust → NO_RESPONSE.
  await forceReleaseLock(instance.id);
  await enqueueNodeExecution({
    instanceId: instance.id,
    expectedState: "AWAITING_REPLY",
    triggerRef: `harness-exhaust-${Date.now()}`,
  });
  const final = await waitFor(instance.id, (s) => s === "NO_RESPONSE");
  log(`final state: ${final.state} (count=${final.count})`);

  await db.transaction((tx) => deleteInstanceCascade(tx, [instance.id]));
  log("PASS — nudge armed from confirmed send, counter advanced, exhausted to NO_RESPONSE. Cleaned up.");
}

// ── Scenario 2: a creator reply cancels the pending follow-up ───────────────
async function scenarioReplyCancels(): Promise<void> {
  section("Scenario 2: reply cancels the pending follow-up (dueAt cleared)");
  const { instance } = await makeInstance("reply");
  await forceReleaseLock(instance.id);
  // Give it a FUTURE dueAt so the poller won't fire before the reply lands.
  await updateInstanceState(instance.id, { dueAt: new Date(Date.now() + 60_000) });
  log(`instance ${instance.id} at AWAITING_REPLY with a pending (future) dueAt`);

  const externalMessageId = `plu110-reply-${Date.now()}`;
  await enqueueInboundEmail({
    instanceId: instance.id,
    externalMessageId,
    threadId: `plu110-thread-${instance.id}`,
    subject: "Re: Collaboration",
    body: "Sounds good, let's do it!",
    mockIntent: "POSITIVE",
  });
  log("injected a POSITIVE reply");

  const res = await waitFor(instance.id, (s) => s !== "AWAITING_REPLY");
  const inst = await findInstanceById(instance.id);
  log(`state after reply: ${res.state}, dueAt: ${inst?.dueAt ?? "null"}`);
  if (inst?.dueAt !== null) {
    throw new Error(`FAIL: reply did not clear dueAt (still ${inst?.dueAt})`);
  }

  await db.transaction((tx) => deleteInstanceCascade(tx, [instance.id]));
  log("PASS — reply moved the instance off AWAITING_REPLY and cleared the follow-up timer. Cleaned up.");
}

async function main(): Promise<void> {
  console.log("\nPLU-110 — Negotiation Follow-up LIVE Harness (Redis + Neon + workers)\n");
  const workers: Worker[] = [
    createNodeExecutionWorker(),
    createInboundEmailWorker(),
    createDelayedSendWorker(),
  ];
  log("workers started (node-execution, inbound-email, delayed-send)");

  try {
    await scenarioCycle();
    await scenarioReplyCancels();
    console.log("\n✓ PLU-110 live harness complete — all scenarios passed\n");
  } catch (err) {
    console.error("\n✗ PLU-110 live harness FAILED:", err);
    process.exitCode = 1;
  } finally {
    await closeLockClient();
    await Promise.all(workers.map((w) => w.close()));
    await getNodeExecutionQueue().close();
    await getInboundEmailQueue().close();
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
