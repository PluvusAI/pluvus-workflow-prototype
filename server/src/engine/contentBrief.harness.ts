/**
 * Content Brief verification harness — drives the MERGED post-negotiation flow
 * (negotiation → Content Brief) using mock providers and the real runtime (no
 * Redis/queues). Content Brief now sends ONE email (finalized offer + secure
 * payout link + brief PDF) and collects payout itself. Proves:
 *
 *   ACCEPTED → (auto) merged Content Brief email → PAYMENT_PENDING
 *            → (form submit) → CONTENT_LINKS_PENDING (await content links)
 *
 * Also verifies: the merged email carries the finalized offer — sourced from the
 * FinalAgreement row a real accept turn writes (PLU-143), never config/negotiation
 * history — (fee/commission/deliverables) + the tokenized payout link + creator
 * notes; the configured PDF is loaded from local storage, attached, and its
 * provenance recorded onto FinalAgreement.contentBriefGeneration*; the send is
 * idempotent (a re-run does not send a second email); a CONTENT_BRIEF_SENT event
 * is recorded and the instance parks (non-terminal) on CONTENT_LINKS_PENDING after
 * the form submission.
 *
 * Plus a LEGACY sub-case: a graph that still has REWARD_SETUP → PAYMENT_INFO →
 * CONTENT_BRIEF drives PAYMENT_RECEIVED → CONTENT_BRIEF_SENT with the brief-only
 * email (backward compatibility), and a graph with NO CONTENT_BRIEF node keeps
 * PAYMENT_RECEIVED terminal.
 *
 * Creates its own throwaway workflow/version/creator/instance + a temp PDF, and
 * deletes them on exit, so it does not depend on or mutate seed data. Run:
 *   npx tsx src/engine/contentBrief.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstanceState, InputJsonValue } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  brandNotifications,
  campaignBriefs,
  campaignDetails,
  campaignTermsSnapshots,
  campaigns,
  creators,
  events,
  executionInstances,
  finalAgreements,
  messages,
  negotiationPolicies,
  negotiationPolicySnapshots,
  paymentInfo,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import {
  appendEvent,
  findInstanceById,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
// PLU-143: the merged flow now reads finalized terms from FinalAgreement, not
// resolveAgreedFee/config — the harness must seed the row a real accept turn
// would have written (recordFinalAgreementOnce), same as any other caller.
import { recordFinalAgreementOnce, findFinalAgreementByInstance } from "../db/finalAgreements.js";
// Review fix sub-case: a real launched campaign is required to exercise the
// pluvus_builder BLOCKED branch — resolveCurrentCampaignBriefForInstance's
// "dead auto-regen attempt" result only exists once a CampaignTermsSnapshot
// is real and pinned.
import { launchCampaign } from "../db/campaigns.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";
import { saveUploadedFile } from "../storage/localFileStorage.js";

// A minimal but valid PDF (header + trailer). The mock provider never inspects
// the bytes; this just proves the executor reads a real file from storage.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);

const NOTES = "Please tag @acme in your first post.";
const AGREED_RATE = 420;
const COMMISSION = 12;
// PLU-143: the structured Deliverable[] FinalAgreement now carries, in place
// of the old free-text "2 Reels + 1 Story" config string. Rendered by
// formatDeliverablesForCreator as "2 Instagram Reels" / "1 Instagram Story".
const FINAL_DELIVERABLES = [
  { id: "fd-reel", platform: "instagram" as const, format: "reel" as const, quantity: 2 },
  { id: "fd-story", platform: "instagram" as const, format: "story" as const, quantity: 1 },
];

// Shared pipeline prefix (import → outreach → follow-up → reply → negotiation).
function pipelinePrefix(): NodeSnapshot[] {
  return [
    { id: "node-import", type: "IMPORT_CREATOR_LIST", order: 0, config: {} },
    {
      id: "node-outreach",
      type: "INITIAL_OUTREACH",
      order: 1,
      config: { subjectTemplate: "Partner with {{brandName}}", bodyTemplate: "Hi {{creatorName}}", brandName: "Acme", senderName: "Acme" },
    },
    {
      id: "node-followup",
      type: "FOLLOW_UP",
      order: 2,
      config: { intervals: [3], intervalUnit: "days", maxCount: 1, bodyTemplate: "Following up", stopOnReply: true },
    },
    { id: "node-reply-detection", type: "REPLY_DETECTION", order: 3, config: { lowConfidenceThreshold: 0.5 } },
    {
      id: "node-negotiation",
      type: "NEGOTIATION",
      order: 4,
      config: { minBudget: 200, maxBudget: 500, maxRounds: 3, commissionRate: COMMISSION, deliverables: "2 Reels + 1 Story", brandName: "Acme", senderName: "Acme" },
    },
  ];
}

// MERGED graph: negotiation → Content Brief (the new default). PLU-143: the
// finalized fee/commission/deliverables/timeline now come from the
// FinalAgreement row (seedFinalAgreement below), not this node's config — the
// config here only carries the brand/PDF/notes fields the executor still
// reads directly.
function mergedNodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
  return [
    ...pipelinePrefix(),
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 5,
      config: {
        brandName: "Acme",
        senderName: "Acme",
        briefFileRef,
        briefFileName,
        creatorNotes: NOTES,
      },
    },
  ];
}

// LEGACY graph: negotiation → Reward Setup → Payment Info → Content Brief. Content
// Brief runs from PAYMENT_RECEIVED with the brief-only email.
function legacyNodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
  return [
    ...pipelinePrefix(),
    { id: "node-reward-setup", type: "REWARD_SETUP", order: 5, config: { brandName: "Acme", senderName: "Acme" } },
    { id: "node-payment-info", type: "PAYMENT_INFO", order: 6, config: { brandName: "Acme", senderName: "Acme" } },
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 7,
      config: {
        brandName: "Acme",
        senderName: "Acme",
        briefFileRef,
        briefFileName,
        creatorNotes: NOTES,
      },
    },
  ];
}

async function state(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

// PLU-143: the canonical accepted-terms row a real accept turn writes
// (recordFinalAgreementOnce) — the merged Content Brief flow now reads its
// finalized fee/commission/deliverables/timeline from THIS, never from
// config or NEGOTIATION_TURN history.
async function seedFinalAgreement(
  instanceId: string,
  overrides: { finalDeliverables?: typeof FINAL_DELIVERABLES; finalFeeCents?: number | null } = {},
): Promise<void> {
  await recordFinalAgreementOnce({
    instanceId,
    campaignTermsSnapshotId: null,
    negotiationPolicySnapshotId: null,
    finalFeeCents: overrides.finalFeeCents !== undefined ? overrides.finalFeeCents : AGREED_RATE * 100,
    finalCommissionMode: "PERCENT",
    finalCommissionRate: COMMISSION,
    finalCommissionAmountCents: null,
    finalCommissionDurationDays: null,
    finalCommissionConditions: null,
    finalGiftProductDescription: null,
    finalGiftDisposition: null,
    finalFulfillmentTerms: null,
    finalDeliverables: overrides.finalDeliverables ?? FINAL_DELIVERABLES,
    finalTimeline: null,
    finalPostingDate: null,
    finalUsageRights: null,
    finalExclusivity: null,
    finalAttributionWindow: null,
    finalPaymentTerms: null,
    finalScriptSubmissionRequired: false,
    approvedDeviations: null,
    acceptanceSource: "AI_NEGOTIATION",
    sourceMessageId: null,
    acceptedAt: new Date(),
  });
}

// Seed the ACCEPT NEGOTIATION_TURN event too — a real accept turn writes both;
// no current code path in this file still reads it back (resolveAgreedFee was
// retired from the merged Content Brief flow), kept only for parity with what
// negotiation.ts actually persists on accept.
async function seedAcceptEvent(instanceId: string): Promise<void> {
  await appendEvent({
    instanceId,
    type: "NEGOTIATION_TURN",
    nodeId: "node-negotiation",
    payload: { outcome: "accept", round: 1, message: "Deal", rate: AGREED_RATE },
  });
}

async function main(): Promise<void> {
  console.log("\nContent Brief Harness\n");

  const stamp = process.env["HARNESS_STAMP"] ?? "cb-harness";

  // Store a real PDF via the storage seam under a throwaway uploads dir so the
  // harness never litters the project's uploads/ folder.
  const uploadDir = await mkdtemp(path.join(tmpdir(), "cb-uploads-"));
  const prevUploads = process.env["UPLOADS_DIR"];
  process.env["UPLOADS_DIR"] = uploadDir;
  const stored = await saveUploadedFile(PDF_BYTES, "campaign-brief.pdf");

  const MERGED = mergedNodes(stored.reference, stored.originalName);
  const LEGACY = legacyNodes(stored.reference, stored.originalName);

  const workflow = (await db.insert(workflows).values({
    name: `Content Brief Harness ${stamp}`,
    status: "PUBLISHED",
  }).returning())[0]!;
  // Review fix: a PAID campaignType (via ctx.campaignDetails.campaignType) is
  // what blockedByMissingFixedFee's guard branches on — needs a real
  // campaign/campaignDetails row linked through the workflow for
  // runtime.loadContext to actually populate ctx.campaignDetails.
  const campaign = (await db.insert(campaigns).values({
    name: `Content Brief Harness Campaign ${stamp}`,
    brand: "Acme",
  }).returning())[0]!;
  await db.insert(campaignDetails).values({
    campaignId: campaign.id,
    campaignType: "PAID",
  });
  await db.update(workflows).set({ campaignId: campaign.id }).where(eq(workflows.id, workflow.id));
  const version = (await db.insert(workflowVersions).values({
    workflowId: workflow.id,
    version: 1,
    nodeGraph: MERGED as unknown as InputJsonValue,
  }).returning())[0]!;
  const creator = (await db.insert(creators).values({
    name: "Casey Creator",
    email: `casey-cb-${stamp}@example.com`,
    platform: "Instagram",
    niche: "fitness",
  }).returning())[0]!;
  // Park directly in ACCEPTED with currentNodeId cleared — exactly what the
  // negotiation ACCEPT leaves behind for the merged hand-off.
  const instance = (await db.insert(executionInstances).values({
    workflowVersionId: version.id,
    creatorId: creator.id,
    currentState: "ACCEPTED",
    currentNodeId: null,
  }).returning())[0]!;
  await seedAcceptEvent(instance.id);
  await seedFinalAgreement(instance.id);

  const cleanup = async () => {
    await db.delete(events).where(eq(events.instanceId, instance.id));
    await db.delete(messages).where(eq(messages.instanceId, instance.id));
    await db.delete(brandNotifications).where(eq(brandNotifications.instanceId, instance.id));
    await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, instance.id));
    await db.delete(finalAgreements).where(eq(finalAgreements.instanceId, instance.id));
    await db.delete(executionInstances).where(eq(executionInstances.id, instance.id));
    await db.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
    await db.delete(campaignDetails).where(eq(campaignDetails.campaignId, campaign.id));
    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
    await db.delete(creators).where(eq(creators.id, creator.id));
    await rm(uploadDir, { recursive: true, force: true });
    if (prevUploads === undefined) delete process.env["UPLOADS_DIR"];
    else process.env["UPLOADS_DIR"] = prevUploads;
  };

  try {
    const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

    // ── MERGED FLOW ───────────────────────────────────────────────────────────
    assert.equal(await runtime.contentBriefApplies(instance.id), true);

    // Content Brief auto-runs from ACCEPTED (the step the node-exec worker
    // enqueues): sends the merged email → PAYMENT_PENDING (waits on the form).
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "PAYMENT_PENDING", "merged Content Brief should reach PAYMENT_PENDING");
    console.log("  ✓ ACCEPTED → PAYMENT_PENDING (merged email sent, awaiting payout form)");

    // The merged email carries: subject, finalized offer (fee/commission/
    // deliverables), the tokenized payout link, referral link, creator notes.
    const msgs = await listMessagesByInstance(instance.id);
    const briefEmail = msgs.find(
      (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Your Campaign Brief",
    );
    assert.ok(briefEmail, "a 'Your Campaign Brief' email must be sent");
    assert.ok(briefEmail!.body.includes(`$${AGREED_RATE}`), "email must state the agreed fee");
    assert.ok(briefEmail!.body.includes(`${COMMISSION}%`), "email must state the commission");
    assert.ok(briefEmail!.body.includes("2 Instagram Reels"), "email must list the FinalAgreement deliverables");
    assert.ok(briefEmail!.body.includes("1 Instagram Story"), "email must list every FinalAgreement deliverable");
    assert.ok(/\/payment\//.test(briefEmail!.body), "email must include the tokenized payout link");
    assert.ok(briefEmail!.body.includes(NOTES), "email must include the creator notes");
    assert.ok(
      (briefEmail!.idempotencyKey ?? "").startsWith("content-brief:"),
      "the send must use the content-brief idempotency key",
    );
    console.log("  ✓ email carries the FinalAgreement offer (fee/commission/deliverables) + payout link + notes");

    // PLU-143: the FinalAgreement row is the one source of these terms now
    // (no more resolveAgreedFee/config reads for the merged flow), and this
    // step must have recorded which document was attached (own_doc path: no
    // campaignBriefId, assetRef = the uploaded briefFileRef).
    const finalAgreement = await findFinalAgreementByInstance(instance.id);
    assert.ok(finalAgreement, "a FinalAgreement row must exist for the merged flow");
    assert.equal(finalAgreement!.contentBriefCampaignBriefId, null, "own_doc path attaches no CampaignBrief");
    assert.equal(finalAgreement!.contentBriefAssetRef, stored.reference, "provenance must record the attached PDF");
    assert.equal(finalAgreement!.contentBriefTemplateVersion, "brand_uploaded");
    assert.ok(finalAgreement!.contentBriefGeneratedAt instanceof Date, "generation timestamp must be stamped");
    console.log("  ✓ FinalAgreement.contentBriefGeneration* provenance recorded (own_doc path)");

    // A PaymentInfo row/token was minted, and no completedAt yet (still waiting).
    const pi =
      (await db.select().from(paymentInfo).where(eq(paymentInfo.instanceId, instance.id)).limit(1))[0] ?? null;
    assert.ok(pi && pi.token, "a PaymentInfo row + token must be minted");
    const midInst = await findInstanceById(instance.id);
    assert.ok(!midInst!.completedAt, "completedAt must NOT be stamped while awaiting the form");

    // Idempotency: re-running the send step must NOT send a second email or mint a
    // second token. Reset to ACCEPTED and step again.
    await db.update(executionInstances)
      .set({ currentState: "ACCEPTED", currentNodeId: null })
      .where(eq(executionInstances.id, instance.id));
    await runtime.stepInstance(instance.id);
    const briefEmails = (await listMessagesByInstance(instance.id)).filter(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("content-brief:"),
    );
    assert.equal(briefEmails.length, 1, "re-run must not send a second merged email");
    console.log("  ✓ idempotent: re-run does not duplicate the merged email");

    // Form submission mints the ledger and parks on the non-terminal
    // CONTENT_LINKS_PENDING waiting state (asks the creator for content links).
    await runtime.handlePaymentSubmission(instance.id, {
      method: "PAYPAL",
      accountIdentifier: "casey@paypal.me",
      country: "US",
    });
    assert.equal(
      await state(instance.id),
      "CONTENT_LINKS_PENDING",
      "form submit must park on CONTENT_LINKS_PENDING (await content links)",
    );
    const sentEvents = await listEventsByInstance(instance.id, { type: "CONTENT_BRIEF_SENT" });
    assert.ok(sentEvents.length >= 1, "a CONTENT_BRIEF_SENT event must be recorded");
    const parked = await findInstanceById(instance.id);
    assert.ok(!parked!.completedAt, "completedAt must NOT be stamped — CONTENT_LINKS_PENDING is non-terminal");
    console.log("  ✓ payout form submit → CONTENT_LINKS_PENDING (ledger minted, awaiting content links)");

    // ── PLU-143 SUB-CASE: no FinalAgreement row → MANUAL_REVIEW, never a fee guess ─
    const noFaInstance = (await db.insert(executionInstances).values({
      workflowVersionId: version.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
    }).returning())[0]!;
    try {
      await runtime.stepInstance(noFaInstance.id);
      assert.equal(await state(noFaInstance.id), "MANUAL_REVIEW", "a missing FinalAgreement must escalate, never fabricate terms");
      const escalations = await listEventsByInstance(noFaInstance.id, { type: "MANUAL_REVIEW_FLAGGED" });
      assert.equal((escalations[0]?.payload as Record<string, unknown> | undefined)?.["reason"], "no_final_agreement");
      const noFaMsgs = await listMessagesByInstance(noFaInstance.id);
      assert.equal(
        noFaMsgs.filter((m) => m.direction === "OUTBOUND").length,
        0,
        "no brief/offer email must be sent when there is no FinalAgreement to source it from",
      );
      console.log("  ✓ no FinalAgreement row → MANUAL_REVIEW (no_final_agreement), no email sent");
    } finally {
      await db.delete(events).where(eq(events.instanceId, noFaInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, noFaInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, noFaInstance.id));
    }

    // ── PLU-143 SUB-CASE: FinalAgreement with empty deliverables → MANUAL_REVIEW ─
    const emptyDeliverablesInstance = (await db.insert(executionInstances).values({
      workflowVersionId: version.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
    }).returning())[0]!;
    try {
      await seedFinalAgreement(emptyDeliverablesInstance.id, { finalDeliverables: [] });
      await runtime.stepInstance(emptyDeliverablesInstance.id);
      assert.equal(
        await state(emptyDeliverablesInstance.id),
        "MANUAL_REVIEW",
        "empty finalDeliverables must escalate rather than render 'To be finalized'",
      );
      const escalations = await listEventsByInstance(emptyDeliverablesInstance.id, { type: "MANUAL_REVIEW_FLAGGED" });
      assert.equal((escalations[0]?.payload as Record<string, unknown> | undefined)?.["reason"], "incomplete_final_deliverables");
      console.log("  ✓ FinalAgreement with empty deliverables → MANUAL_REVIEW (incomplete_final_deliverables)");
    } finally {
      await db.delete(events).where(eq(events.instanceId, emptyDeliverablesInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, emptyDeliverablesInstance.id));
      await db.delete(finalAgreements).where(eq(finalAgreements.instanceId, emptyDeliverablesInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, emptyDeliverablesInstance.id));
    }

    // ── Review fix SUB-CASE: FinalAgreement with no fee on a PAID campaign →
    //    MANUAL_REVIEW, never a payout link with no fee attached ────────────
    const noFeeInstance = (await db.insert(executionInstances).values({
      workflowVersionId: version.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
    }).returning())[0]!;
    try {
      // Simulates an ACCEPT turn with no numeric proposedTerms.rate — the
      // exact scenario the review comment described.
      await seedFinalAgreement(noFeeInstance.id, { finalFeeCents: null });
      await runtime.stepInstance(noFeeInstance.id);
      assert.equal(
        await state(noFeeInstance.id),
        "MANUAL_REVIEW",
        "a PAID campaign's accepted agreement with no fee must escalate, never proceed to payout",
      );
      const escalations = await listEventsByInstance(noFeeInstance.id, { type: "MANUAL_REVIEW_FLAGGED" });
      assert.equal(
        (escalations[0]?.payload as Record<string, unknown> | undefined)?.["reason"],
        "missing_fixed_fee",
      );
      const noFeeMsgs = await listMessagesByInstance(noFeeInstance.id);
      assert.equal(
        noFeeMsgs.filter((m) => m.direction === "OUTBOUND").length,
        0,
        "no payout-link email may be sent for a fee-less agreement on a campaign that requires a fee",
      );
      console.log("  ✓ PAID campaign, no fee on FinalAgreement → MANUAL_REVIEW (missing_fixed_fee), no email sent");
    } finally {
      await db.delete(events).where(eq(events.instanceId, noFeeInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, noFeeInstance.id));
      await db.delete(finalAgreements).where(eq(finalAgreements.instanceId, noFeeInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, noFeeInstance.id));
    }

    // ── Review fix SUB-CASE (round 4): campaignType cannot be resolved at
    //    all — no pinned snapshot AND no live campaignDetails (an orphaned
    //    workflow with no campaignId). A fee-less agreement must still
    //    escalate: the old `needsFixedFee` check read an unresolvable type
    //    as neither PAID nor HYBRID and let it through as if no fee were
    //    ever required — this must now fail CLOSED instead. ─────────────
    const orphanWorkflow = (await db.insert(workflows).values({
      name: `Content Brief Harness Orphan Workflow ${stamp}`,
      status: "PUBLISHED",
    }).returning())[0]!;
    const orphanVersion = (await db.insert(workflowVersions).values({
      workflowId: orphanWorkflow.id,
      version: 1,
      nodeGraph: MERGED as unknown as InputJsonValue,
    }).returning())[0]!;
    const orphanInstance = (await db.insert(executionInstances).values({
      workflowVersionId: orphanVersion.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
    }).returning())[0]!;
    try {
      await seedFinalAgreement(orphanInstance.id, { finalFeeCents: null });
      await runtime.stepInstance(orphanInstance.id);
      assert.equal(
        await state(orphanInstance.id),
        "MANUAL_REVIEW",
        "an unresolvable campaignType must fail closed, never assume no fee is needed",
      );
      const escalations = await listEventsByInstance(orphanInstance.id, { type: "MANUAL_REVIEW_FLAGGED" });
      assert.equal(
        (escalations[0]?.payload as Record<string, unknown> | undefined)?.["reason"],
        "missing_fixed_fee",
      );
      const orphanMsgs = await listMessagesByInstance(orphanInstance.id);
      assert.equal(
        orphanMsgs.filter((m) => m.direction === "OUTBOUND").length,
        0,
        "no payout-link email may be sent when campaignType cannot be resolved and no fee is present",
      );
      console.log("  ✓ unresolvable campaignType + no fee → MANUAL_REVIEW (missing_fixed_fee), fails closed");
    } finally {
      await db.delete(events).where(eq(events.instanceId, orphanInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, orphanInstance.id));
      await db.delete(finalAgreements).where(eq(finalAgreements.instanceId, orphanInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, orphanInstance.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, orphanVersion.id));
      await db.delete(workflows).where(eq(workflows.id, orphanWorkflow.id));
    }

    // ── Review fix SUB-CASE (round 4, positive control): an EXPLICITLY
    //    amountless classification (AFFILIATE) with no fee must still
    //    proceed normally — proves the fail-closed fix above didn't turn
    //    into "always require a fee." ──────────────────────────────────
    const affiliateCampaign = (await db.insert(campaigns).values({
      name: `Content Brief Harness Affiliate Campaign ${stamp}`,
      brand: "Acme",
    }).returning())[0]!;
    await db.insert(campaignDetails).values({
      campaignId: affiliateCampaign.id,
      campaignType: "AFFILIATE",
    });
    const affiliateWorkflow = (await db.insert(workflows).values({
      name: `Content Brief Harness Affiliate Workflow ${stamp}`,
      status: "PUBLISHED",
      campaignId: affiliateCampaign.id,
    }).returning())[0]!;
    const affiliateVersion = (await db.insert(workflowVersions).values({
      workflowId: affiliateWorkflow.id,
      version: 1,
      nodeGraph: MERGED as unknown as InputJsonValue,
    }).returning())[0]!;
    const affiliateInstance = (await db.insert(executionInstances).values({
      workflowVersionId: affiliateVersion.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
    }).returning())[0]!;
    try {
      await seedFinalAgreement(affiliateInstance.id, { finalFeeCents: null });
      await runtime.stepInstance(affiliateInstance.id);
      assert.equal(
        await state(affiliateInstance.id),
        "PAYMENT_PENDING",
        "an explicitly AFFILIATE (amountless) agreement with no fee must proceed normally, not escalate",
      );
      console.log("  ✓ explicit AFFILIATE campaignType + no fee → PAYMENT_PENDING (no false-positive escalation)");
    } finally {
      await db.delete(events).where(eq(events.instanceId, affiliateInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, affiliateInstance.id));
      await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, affiliateInstance.id));
      await db.delete(finalAgreements).where(eq(finalAgreements.instanceId, affiliateInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, affiliateInstance.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, affiliateVersion.id));
      await db.delete(workflows).where(eq(workflows.id, affiliateWorkflow.id));
      await db.delete(campaignDetails).where(eq(campaignDetails.campaignId, affiliateCampaign.id));
      await db.delete(campaigns).where(eq(campaigns.id, affiliateCampaign.id));
    }

    // ── Review fix SUB-CASE: a BLOCKED pluvus_builder CampaignBrief (a dead
    //    auto-regen attempt — the exact "transient-looking category, BLOCKED
    //    status" case) must escalate to MANUAL_REVIEW, never throw for a
    //    retry that can only replay the same failed render forever, and must
    //    NOT notify the brand (a platform-side rendering problem, never
    //    something the brand caused or can act on) ─────────────────────────
    const blockedCampaign = (await db.insert(campaigns).values({
      name: `Content Brief Harness BLOCKED Campaign ${stamp}`,
      brand: "Acme",
    }).returning())[0]!;
    await db.insert(campaignDetails).values({
      campaignId: blockedCampaign.id,
      objective: "Drive signups",
      usageRights: "90-day paid social",
      campaignType: "PAID",
      priceStrategy: "REQUEST_RATE_CARD",
      compensationReviewStatus: "CONFIRMED",
      deliverableQuantities: [{ id: "del_default", platform: "instagram", format: "reel", quantity: 1 }],
      briefDeliveryMethod: "pluvus_builder",
    });
    await db.insert(negotiationPolicies).values({
      campaignId: blockedCampaign.id,
      floorCents: 20_000,
      ceilingCents: 50_000,
    });
    const blockedSnapshot = await launchCampaign(blockedCampaign.id);
    // The exact deterministic key resolveAgainstExpectedSnapshot itself would
    // compute for this campaign/snapshot pair — a prior auto-regen attempt
    // that already failed, so a fresh call can never mint a new one.
    await db.insert(campaignBriefs).values({
      campaignId: blockedCampaign.id,
      campaignTermsSnapshotId: blockedSnapshot.id,
      renderRequestId: `auto-regen|${blockedCampaign.id}|${blockedSnapshot.id}`,
      status: "FAILED",
      renderedAssetRef: null,
      errorCategory: "RENDER_FAILED",
      brandIdentitySnapshot: {},
      templateVersion: "v1",
    });
    const blockedWorkflow = (await db.insert(workflows).values({
      name: `Content Brief Harness BLOCKED Workflow ${stamp}`,
      status: "PUBLISHED",
      campaignId: blockedCampaign.id,
    }).returning())[0]!;
    const blockedVersion = (await db.insert(workflowVersions).values({
      workflowId: blockedWorkflow.id,
      version: 1,
      nodeGraph: MERGED as unknown as InputJsonValue,
    }).returning())[0]!;
    const blockedInstance = (await db.insert(executionInstances).values({
      workflowVersionId: blockedVersion.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
      campaignTermsSnapshotId: blockedSnapshot.id,
    }).returning())[0]!;
    try {
      await seedFinalAgreement(blockedInstance.id);
      await runtime.stepInstance(blockedInstance.id);
      assert.equal(
        await state(blockedInstance.id),
        "MANUAL_REVIEW",
        "a BLOCKED pluvus_builder CampaignBrief must escalate, never retry the same dead render forever",
      );
      const escalations = await listEventsByInstance(blockedInstance.id, { type: "MANUAL_REVIEW_FLAGGED" });
      assert.equal(
        (escalations[0]?.payload as Record<string, unknown> | undefined)?.["reason"],
        "campaign_brief_mismatch",
      );
      const blockedMsgs = await listMessagesByInstance(blockedInstance.id);
      assert.equal(
        blockedMsgs.filter((m) => m.direction === "OUTBOUND").length,
        0,
        "no brief/offer email may be sent for a BLOCKED campaign brief",
      );
      const brandNotifs = await db
        .select()
        .from(brandNotifications)
        .where(eq(brandNotifications.instanceId, blockedInstance.id));
      assert.equal(
        brandNotifs.length,
        0,
        "a campaign_brief_mismatch escalation is platform-side — the brand must not be notified",
      );
      console.log(
        "  ✓ pluvus_builder BLOCKED CampaignBrief → MANUAL_REVIEW (campaign_brief_mismatch), no brand notification",
      );
    } finally {
      await db.delete(events).where(eq(events.instanceId, blockedInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, blockedInstance.id));
      await db.delete(brandNotifications).where(eq(brandNotifications.instanceId, blockedInstance.id));
      await db.delete(finalAgreements).where(eq(finalAgreements.instanceId, blockedInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, blockedInstance.id));
      await db.delete(campaignBriefs).where(eq(campaignBriefs.campaignId, blockedCampaign.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, blockedVersion.id));
      await db.delete(workflows).where(eq(workflows.id, blockedWorkflow.id));
      await db.delete(campaignTermsSnapshots).where(eq(campaignTermsSnapshots.campaignId, blockedCampaign.id));
      await db.delete(negotiationPolicySnapshots).where(eq(negotiationPolicySnapshots.campaignId, blockedCampaign.id));
      await db.delete(negotiationPolicies).where(eq(negotiationPolicies.campaignId, blockedCampaign.id));
      await db.delete(campaignDetails).where(eq(campaignDetails.campaignId, blockedCampaign.id));
      await db.delete(campaigns).where(eq(campaigns.id, blockedCampaign.id));
    }

    // ── LEGACY SUB-CASE: reward → payment → content-brief still reaches terminal ─
    const legacyVersion = (await db.insert(workflowVersions).values({
      workflowId: workflow.id,
      version: 2,
      nodeGraph: LEGACY as unknown as InputJsonValue,
    }).returning())[0]!;
    const legacyInstance = (await db.insert(executionInstances).values({
      workflowVersionId: legacyVersion.id,
      creatorId: creator.id,
      currentState: "PAYMENT_RECEIVED",
      currentNodeId: "node-payment-info",
    }).returning())[0]!;
    try {
      assert.equal(await runtime.contentBriefApplies(legacyInstance.id), true);
      // Legacy Content Brief runs from PAYMENT_RECEIVED with the brief-only email.
      await runtime.stepInstance(legacyInstance.id);
      assert.equal(await state(legacyInstance.id), "CONTENT_BRIEF_SENT", "legacy graph reaches CONTENT_BRIEF_SENT");
      const legacyMsgs = await listMessagesByInstance(legacyInstance.id);
      const legacyBrief = legacyMsgs.find(
        (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Your Campaign Brief",
      );
      assert.ok(legacyBrief, "legacy graph must send the brief email");
      assert.ok(!/\/payment\//.test(legacyBrief!.body), "legacy brief email must NOT include a payout link (already collected)");
      console.log("  ✓ legacy graph: PAYMENT_RECEIVED → CONTENT_BRIEF_SENT (brief-only email, no payout link)");
    } finally {
      await db.delete(events).where(eq(events.instanceId, legacyInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, legacyInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, legacyInstance.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, legacyVersion.id));
    }

    // ── LEGACY SUB-CASE: no CONTENT_BRIEF node → PAYMENT_RECEIVED stays terminal ─
    const bareVersion = (await db.insert(workflowVersions).values({
      workflowId: workflow.id,
      version: 3,
      nodeGraph: LEGACY.filter((n) => n.type !== "CONTENT_BRIEF") as unknown as InputJsonValue,
    }).returning())[0]!;
    const bareInstance = (await db.insert(executionInstances).values({
      workflowVersionId: bareVersion.id,
      creatorId: creator.id,
      currentState: "PAYMENT_RECEIVED",
      currentNodeId: "node-payment-info",
    }).returning())[0]!;
    try {
      assert.equal(await runtime.contentBriefApplies(bareInstance.id), false);
      const endState = await runtime.runUntilWaiting(bareInstance.id);
      assert.equal(endState, "PAYMENT_RECEIVED", "graph with no CONTENT_BRIEF keeps PAYMENT_RECEIVED terminal");
      console.log("  ✓ legacy graph without CONTENT_BRIEF: PAYMENT_RECEIVED stays terminal");
    } finally {
      await db.delete(events).where(eq(events.instanceId, bareInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, bareInstance.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, bareVersion.id));
    }

    console.log("\nAll Content Brief checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Content Brief harness failed:", err);
  process.exit(1);
});
