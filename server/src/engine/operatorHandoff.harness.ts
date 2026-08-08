/**
 * Operator-handoff verification harness (PLU-70) — drives the post-acceptance
 * branch using mock providers and the real runtime (no Redis/queues). Proves:
 *
 *   ACCEPTED (operator_handoff) → handoff note sent → NEEDS_DEAL_FINALIZATION
 *                               → (operator completes) → HANDOFF_COMPLETE
 *
 * And, critically, what it does NOT do: no payout token, no payout form, no
 * campaign brief — handoff mode collects no payout information at all.
 *
 * Also verifies:
 *   - the acceptance snapshot is persisted with the agreed terms,
 *   - the creator note is CC'd to the campaign's escalation contact,
 *   - the operator is emailed once, via the existing BrandNotification seam,
 *   - re-running the step duplicates NOTHING (no second row, no second email),
 *   - a creator reply while parked is recorded + forwarded WITHOUT transitioning,
 *   - the same graph with a local_payment instance still runs the payout flow —
 *     i.e. the branch is keyed on the instance, not the workflow version.
 *
 * Creates its own throwaway campaign/workflow/version/creator/instances and
 * deletes them on exit, so it does not depend on or mutate seed data. Run:
 *   npx tsx src/engine/operatorHandoff.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import type { InstanceState, InputJsonValue } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  brandNotifications,
  campaigns,
  creators,
  dealHandoffs,
  events,
  executionInstances,
  messages,
  paymentInfo,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import { upsertCampaignDetails } from "../db/campaignDetails.js";
import {
  appendEvent,
  findInstanceById,
  findDealHandoffByInstance,
  completeDealHandoff,
  listEventsByInstance,
  listMessagesByInstance,
  updateInstanceStateConditional,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import { assertTransition } from "./stateMachine.js";
import { formatAgreedCompensation } from "./dealTerms.js";
import type { NodeSnapshot } from "./types.js";

const AGREED_RATE = 420;
const COMMISSION = 12;
const DELIVERABLES = "2 Reels + 1 Story";
const TIMELINE = "Live by Sept 15, 2026";
const PAYMENT_TERMS = "net-30 after content approval";
const NOTIFY_EMAIL = "ops-handoff@example.com";

// A normal MERGED graph — deliberately identical to what a local_payment
// campaign publishes. The handoff branch must work without any graph change,
// which is what keeps published immutable versions compatible.
function nodes(): NodeSnapshot[] {
  return [
    { id: "node-import", type: "IMPORT_CREATOR_LIST", order: 0, config: {} },
    {
      id: "node-outreach",
      type: "INITIAL_OUTREACH",
      order: 1,
      config: {
        subjectTemplate: "Partner with {{brandName}}",
        bodyTemplate: "Hi {{creatorName}}",
        brandName: "Acme",
        senderName: "Acme",
      },
    },
    { id: "node-reply-detection", type: "REPLY_DETECTION", order: 2, config: { lowConfidenceThreshold: 0.5 } },
    {
      id: "node-negotiation",
      type: "NEGOTIATION",
      order: 3,
      config: {
        minBudget: 200,
        maxBudget: 500,
        maxRounds: 3,
        commissionRate: COMMISSION,
        deliverables: DELIVERABLES,
        timeline: TIMELINE,
        brandName: "Acme",
        senderName: "Acme",
      },
    },
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 4,
      config: {
        brandName: "Acme",
        senderName: "Acme",
        commissionRate: COMMISSION,
        deliverables: DELIVERABLES,
        // No briefFileRef: a local_payment run on this graph would throw at the
        // PDF load. That is exactly the point of the negative check below — the
        // handoff path must never reach the Content Brief executor at all.
      },
    },
  ];
}

async function state(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

/** Mirror what the negotiation executor persists on an ACCEPT. */
async function seedAcceptEvent(instanceId: string): Promise<void> {
  await appendEvent({
    instanceId,
    type: "NEGOTIATION_TURN",
    nodeId: "node-negotiation",
    payload: { outcome: "accept", round: 1, message: "Deal — works for me.", rate: AGREED_RATE },
  });
}

async function main(): Promise<void> {
  console.log("\nOperator Handoff Harness (PLU-70)\n");

  const stamp = process.env["HARNESS_STAMP"] ?? `oh-${Date.now()}`;

  const campaign = (await db.insert(campaigns).values({
    name: `Handoff Harness ${stamp}`,
    brand: "Acme",
    notifyEmail: NOTIFY_EMAIL,
    postAcceptanceMode: "operator_handoff",
  }).returning())[0]!;
  // PLU-135 (1a): deliverables/timeline/paymentTerms moved off Campaign onto
  // CampaignDetails.
  await upsertCampaignDetails(campaign.id, {
    deliverables: DELIVERABLES,
    timeline: TIMELINE,
    publicPaymentTerms: PAYMENT_TERMS,
  });

  const workflow = (await db.insert(workflows).values({
    name: `Handoff Harness ${stamp}`,
    status: "PUBLISHED",
    campaignId: campaign.id,
  }).returning())[0]!;
  const version = (await db.insert(workflowVersions).values({
    workflowId: workflow.id,
    version: 1,
    nodeGraph: nodes() as unknown as InputJsonValue,
  }).returning())[0]!;

  const creator = (await db.insert(creators).values({
    name: "Casey Creator",
    email: `casey-oh-${stamp}@example.com`,
    platform: "Instagram",
    niche: "fitness",
  }).returning())[0]!;
  const localCreator = (await db.insert(creators).values({
    name: "Local Lee",
    email: `lee-oh-${stamp}@example.com`,
    platform: "TikTok",
  }).returning())[0]!;

  // Parked exactly as the negotiation ACCEPT leaves an instance: ACCEPTED with
  // currentNodeId cleared.
  const instance = (await db.insert(executionInstances).values({
    workflowVersionId: version.id,
    creatorId: creator.id,
    currentState: "ACCEPTED",
    currentNodeId: null,
    postAcceptanceMode: "operator_handoff",
  }).returning())[0]!;
  await seedAcceptEvent(instance.id);

  // Same version, same graph — but a local_payment execution. Used to prove the
  // branch is per-execution, not per-workflow.
  const localInstance = (await db.insert(executionInstances).values({
    workflowVersionId: version.id,
    creatorId: localCreator.id,
    currentState: "ACCEPTED",
    currentNodeId: null,
    postAcceptanceMode: "local_payment",
  }).returning())[0]!;
  await seedAcceptEvent(localInstance.id);

  const cleanup = async () => {
    for (const id of [instance.id, localInstance.id]) {
      await db.delete(events).where(eq(events.instanceId, id));
      await db.delete(messages).where(eq(messages.instanceId, id));
      await db.delete(brandNotifications).where(eq(brandNotifications.instanceId, id));
      await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, id));
      await db.delete(dealHandoffs).where(eq(dealHandoffs.instanceId, id));
      await db.delete(executionInstances).where(eq(executionInstances.id, id));
    }
    await db.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
    await db.delete(creators).where(eq(creators.id, creator.id));
    await db.delete(creators).where(eq(creators.id, localCreator.id));
    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
  };

  try {
    const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

    // ── The handoff step ────────────────────────────────────────────────────
    await runtime.stepInstance(instance.id);
    assert.equal(
      await state(instance.id),
      "NEEDS_DEAL_FINALIZATION",
      "an operator_handoff ACCEPT must park in NEEDS_DEAL_FINALIZATION",
    );
    console.log("  ✓ ACCEPTED → NEEDS_DEAL_FINALIZATION");

    const parked = await findInstanceById(instance.id);
    assert.ok(!parked!.completedAt, "the run is PAUSED, not completed — completedAt must be unset");
    assert.equal(parked!.currentNodeId, null, "no node owns the parked state");

    // ── The acceptance snapshot ─────────────────────────────────────────────
    const handoff = await findDealHandoffByInstance(instance.id);
    assert.ok(handoff, "a DealHandoff snapshot must be persisted");
    assert.equal(handoff!.creatorName, "Casey Creator");
    assert.equal(handoff!.creatorEmail, creator.email);
    assert.equal(handoff!.campaignName, campaign.name);
    assert.equal(handoff!.fixedFee, AGREED_RATE, "the agreed fee is recovered from the ACCEPT event");
    assert.equal(handoff!.commissionRate, COMMISSION);
    assert.equal(handoff!.deliverables, DELIVERABLES);
    assert.equal(handoff!.timeline, TIMELINE);
    // PLU-135 (1a) KNOWN GAP: paymentTerms has no node-config source in this
    // harness's graph (unlike deliverables/timeline above) — it relies
    // entirely on the campaign-level fallback, which now lives in
    // CampaignDetails rather than on Campaign itself. executeOperatorHandoff
    // still reads ctx.campaign (the raw, trimmed Campaign row), so this
    // fallback is temporarily unavailable until Issue 1c wires
    // CampaignDetails into ExecutionContext. Expected to fail here until then.
    assert.equal(handoff!.paymentTerms, PAYMENT_TERMS, "payment terms fall back to the campaign");
    assert.match(handoff!.acceptanceMessage ?? "", /works for me/i);
    assert.equal(handoff!.status, "AWAITING_FINALIZATION");
    assert.equal(
      formatAgreedCompensation(handoff!.fixedFee, handoff!.commissionRate),
      "$420 fixed fee + 12% commission",
    );
    console.log("  ✓ acceptance snapshot persisted with the agreed terms");

    // ── No payout artifacts ─────────────────────────────────────────────────
    const pi =
      (await db.select().from(paymentInfo).where(eq(paymentInfo.instanceId, instance.id)).limit(1))[0] ?? null;
    assert.equal(pi, null, "handoff mode must NOT mint a payout token or form");
    console.log("  ✓ no payout token, no payout form, no brief");

    // ── The creator note ────────────────────────────────────────────────────
    const msgs = await listMessagesByInstance(instance.id);
    const note = msgs.find(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("deal-handoff:"),
    );
    assert.ok(note, "the creator must receive the handoff note");
    assert.match(note!.body, /looping in our campaign manager/i);
    assert.match(note!.body, /onboarding link/i);
    // The note must NOT restate terms — the operator's record is the agreement.
    assert.ok(!note!.body.includes(`$${AGREED_RATE}`), "the handoff note must not quote a fee");
    console.log("  ✓ creator got the handoff note (no terms restated)");

    // The CC is recorded on the DEAL_HANDOFF_REQUESTED event payload.
    const handoffEvents = await listEventsByInstance(instance.id, { type: "DEAL_HANDOFF_REQUESTED" });
    assert.equal(handoffEvents.length, 1, "exactly one handoff event");
    assert.equal(
      (handoffEvents[0]!.payload as Record<string, unknown>)["ccOperator"],
      NOTIFY_EMAIL,
      "the campaign's escalation contact must be CC'd on the creator note",
    );
    console.log(`  ✓ operator CC'd on the creator thread (${NOTIFY_EMAIL})`);

    // ── The operator notification ───────────────────────────────────────────
    const notices = await db
      .select()
      .from(brandNotifications)
      .where(eq(brandNotifications.instanceId, instance.id));
    assert.equal(notices.length, 1, "the operator is notified exactly once");
    assert.equal(notices[0]!.reason, "needs_deal_finalization");
    assert.equal(notices[0]!.recipient, NOTIFY_EMAIL);
    assert.equal(notices[0]!.status, "SENT");
    console.log("  ✓ operator notified via the existing escalation-email seam");

    // ── Idempotency ─────────────────────────────────────────────────────────
    // Reset to ACCEPTED and re-run, exactly as a BullMQ retry would.
    await db.update(executionInstances)
      .set({ currentState: "ACCEPTED", currentNodeId: null })
      .where(eq(executionInstances.id, instance.id));
    await runtime.stepInstance(instance.id);

    const notesAfter = (await listMessagesByInstance(instance.id)).filter(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("deal-handoff:"),
    );
    assert.equal(notesAfter.length, 1, "a retry must not send a second creator note");
    const handoffRows = await db
      .select()
      .from(dealHandoffs)
      .where(eq(dealHandoffs.instanceId, instance.id));
    assert.equal(handoffRows.length, 1, "a retry must not duplicate the acceptance record");
    const noticesAfter = await db
      .select()
      .from(brandNotifications)
      .where(eq(brandNotifications.instanceId, instance.id));
    assert.equal(noticesAfter.length, 1, "a retry must not re-notify the operator");
    console.log("  ✓ idempotent: retry duplicates no note, no record, no notification");

    // ── A creator reply while parked ────────────────────────────────────────
    await runtime.recordHandoffReply(instance.id, {
      subject: "one more thing",
      body: "Can we start in October instead?",
      externalMessageId: `inbound-${stamp}-1`,
    });
    assert.equal(
      await state(instance.id),
      "NEEDS_DEAL_FINALIZATION",
      "a reply must NOT move the instance — a human owns this thread",
    );
    const inbound = (await listMessagesByInstance(instance.id)).filter((m) => m.direction === "INBOUND");
    assert.equal(inbound.length, 1, "the reply is recorded in the thread");
    const forwards = (await db
      .select()
      .from(brandNotifications)
      .where(eq(brandNotifications.instanceId, instance.id))
    ).filter((r) => r.reason.startsWith("handoff_reply:"));
    assert.equal(forwards.length, 1, "the reply is forwarded to the operator exactly once");
    // A redelivery of the SAME inbound message must not forward twice.
    await runtime.recordHandoffReply(instance.id, {
      subject: "one more thing",
      body: "Can we start in October instead?",
      externalMessageId: `inbound-${stamp}-1`,
    });
    const forwardsAfter = (await db
      .select()
      .from(brandNotifications)
      .where(eq(brandNotifications.instanceId, instance.id))
    ).filter((r) => r.reason.startsWith("handoff_reply:"));
    assert.equal(forwardsAfter.length, 1, "a redelivered reply must not forward twice");
    console.log("  ✓ creator reply recorded + forwarded once, no transition, no auto-reply");

    // ── The operator completes the handoff ──────────────────────────────────
    // Mirrors POST /manual-queue/instances/:id/handoff/complete.
    assertTransition("NEEDS_DEAL_FINALIZATION", "HANDOFF_COMPLETE");
    const completed = await completeDealHandoff(instance.id, { completedBy: "ops@acme.com" });
    assert.equal(completed!.status, "COMPLETED");
    assert.ok(completed!.completedAt, "completedAt is stamped");
    const closed = await updateInstanceStateConditional(instance.id, "NEEDS_DEAL_FINALIZATION", {
      currentState: "HANDOFF_COMPLETE",
      currentNodeId: null,
      completedAt: new Date(),
    });
    assert.ok(closed, "the OCC-guarded transition commits");
    assert.equal(await state(instance.id), "HANDOFF_COMPLETE");
    console.log("  ✓ operator completed → HANDOFF_COMPLETE (terminal)");

    // Completing twice must not overwrite the original completion.
    const again = await completeDealHandoff(instance.id, { completedBy: "someone-else@acme.com" });
    assert.equal(again!.completedBy, "ops@acme.com", "a second complete must not overwrite the first");
    console.log("  ✓ completing twice is idempotent");

    // ── The local_payment execution on the SAME version is unaffected ───────
    // The graph has no briefFileRef, so the Content Brief executor throws — which
    // proves the local instance took the LOCAL path and never touched the handoff
    // branch. (An instance-level branch that leaked to the version would have
    // parked this one in NEEDS_DEAL_FINALIZATION instead.)
    let localTookLocalPath = false;
    try {
      await runtime.stepInstance(localInstance.id);
    } catch (err) {
      localTookLocalPath = /campaign brief PDF/i.test(
        err instanceof Error ? err.message : String(err),
      );
    }
    assert.ok(
      localTookLocalPath,
      "a local_payment instance on the same version must run the Content Brief path",
    );
    assert.equal(
      await findDealHandoffByInstance(localInstance.id),
      null,
      "a local_payment instance must never get a handoff record",
    );
    console.log("  ✓ same workflow version: a local_payment execution still runs the payout flow");

    console.log("\nAll operator-handoff checks passed.\n");
  } finally {
    await cleanup();
  }
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nHarness FAILED:\n", err);
    process.exit(1);
  });
