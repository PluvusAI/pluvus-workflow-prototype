/**
 * Brand-approval gate verification harness — drives the FULL gated post-acceptance
 * flow against a REAL local stack (Neon DB + the real Express app over HTTP, mock
 * email provider), proving both the Approve path and the Reject path end to end.
 *
 * It boots the real createApp() on an ephemeral port and drives the magic-link
 * route with fetch, so /brand-approval executes exactly as in production. The
 * "mock outbox" is the persisted OUTBOUND Message row: sendOnce writes the full
 * draft body (including the token-bearing approve/reject links) before send(), so
 * the harness recovers the raw token from there — the token itself is never stored.
 *
 * Proves (gate ON):
 *   1. ACCEPTED → AWAITING_BRAND_APPROVAL: NO content brief goes to the creator;
 *      the BRAND is emailed an approve/reject request; a BrandApproval row (hash
 *      only) is written; a BRAND_APPROVAL_REQUESTED event is recorded.
 *   2. GET interstitial renders AND MUTATES NOTHING (mail-prefetch safe).
 *   3. POST approve → the content brief + payout link finally go out and the
 *      instance advances to PAYMENT_PENDING (the exact non-gated behavior, deferred).
 *   4. Reject case (separate instance): POST reject → MANUAL_REVIEW, no brief sent,
 *      a BRAND_REJECTED event recorded.
 *   5. Token tamper / reuse: a wrong token 404s; a re-POST of a decided link is a
 *      safe idempotent notice.
 *   6. Gate OFF (control): ACCEPTED goes STRAIGHT to the content brief (unchanged).
 *
 * Creates its own throwaway campaign/workflow/creator/instances + a temp PDF and
 * deletes them on exit. Run:
 *   npm run harness:brand-approval   (or npx tsx src/engine/brandApproval.harness.ts)
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

// The route calls emailProvider(); force the mock + a self-referential base URL
// BEFORE the app (and its route modules) read them.
process.env["EMAIL_PROVIDER"] = "mock";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  brandApprovals,
  brandNotifications,
  campaigns,
  creators,
  events,
  executionInstances,
  messages,
  paymentInfo,
  workflows,
  workflowVersions,
  type InputJsonValue,
} from "../db/schema.js";
import {
  appendEvent,
  findInstanceById,
  findBrandApprovalByInstance,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
import type { NodeSnapshot } from "./types.js";
import { saveUploadedFile } from "../storage/localFileStorage.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import { createApp } from "../app.js";

const STAMP = process.env["HARNESS_STAMP"] ?? `ba-${Date.now()}`;
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);
const AGREED_RATE = 420;
const COMMISSION = 12;
const DELIVERABLES = "2 Reels + 1 Story";

function nodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
  return [
    { id: "node-import", type: "IMPORT_CREATOR_LIST", order: 0, config: {} },
    {
      id: "node-outreach",
      type: "INITIAL_OUTREACH",
      order: 1,
      config: { subjectTemplate: "Partner with {{brandName}}", bodyTemplate: "Hi {{creatorName}}", brandName: "Acme", senderName: "Acme" },
    },
    { id: "node-reply-detection", type: "REPLY_DETECTION", order: 2, config: { lowConfidenceThreshold: 0.5 } },
    {
      id: "node-negotiation",
      type: "NEGOTIATION",
      order: 3,
      config: { minBudget: 200, maxBudget: 500, maxRounds: 3, commissionRate: COMMISSION, deliverables: DELIVERABLES, brandName: "Acme", senderName: "Acme" },
    },
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 4,
      config: { brandName: "Acme", senderName: "Acme", commissionRate: COMMISSION, deliverables: DELIVERABLES, briefFileRef, briefFileName },
    },
  ];
}

async function state(instanceId: string): Promise<string> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

/** Recover the approve/reject raw token from the persisted brand email body. */
function tokenFromBody(body: string, action: "approve" | "reject"): string {
  const re = new RegExp(`/brand-approval/${action}/([^?]+)\\?token=([0-9a-f]+)`);
  const m = body.match(re);
  if (!m) throw new Error(`no ${action} link found in brand email body:\n${body}`);
  return m[2]!;
}
function approvalIdFromBody(body: string): string {
  const m = body.match(/\/brand-approval\/approve\/([^?]+)\?token=/);
  if (!m) throw new Error(`no approvalId in body:\n${body}`);
  return m[1]!;
}

async function main(): Promise<void> {
  console.log("\nBrand Approval Gate Harness\n");

  const uploadDir = await mkdtemp(path.join(tmpdir(), "ba-uploads-"));
  const prevUploads = process.env["UPLOADS_DIR"];
  process.env["UPLOADS_DIR"] = uploadDir;
  const stored = await saveUploadedFile(PDF_BYTES, "campaign-brief.pdf");
  const GRAPH = nodes(stored.reference, stored.originalName);

  // Boot the real app on an ephemeral port; links point back at it.
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const prevBase = process.env["PAYMENT_BASE_URL"];
  process.env["PAYMENT_BASE_URL"] = origin;
  console.log(`  (app listening on ${origin})`);

  const campaign = (await db.insert(campaigns).values({
    name: `Brand Approval Harness ${STAMP}`, brand: "Acme", notifyEmail: `brand-${STAMP}@example.com`,
  }).returning())[0]!;
  const workflow = (await db.insert(workflows).values({ name: `BA WF ${STAMP}`, campaignId: campaign.id, status: "PUBLISHED" }).returning())[0]!;
  const version = (await db.insert(workflowVersions).values({ workflowId: workflow.id, version: 1, nodeGraph: GRAPH as unknown as InputJsonValue }).returning())[0]!;

  // Two creators: one for the Approve path, one for the Reject path. Plus a third
  // for the gate-OFF control.
  const mk = async (suffix: string) =>
    (await db.insert(creators).values({ name: `Creator ${suffix}`, email: `ba-${suffix}-${STAMP}@example.com`, platform: "Instagram", handle: `creator_${suffix}`, niche: "fitness" }).returning())[0]!;
  const creatorA = await mk("approve");
  const creatorR = await mk("reject");
  const creatorC = await mk("control");

  const mkInstance = async (creatorId: string) => {
    const inst = (await db.insert(executionInstances).values({
      workflowVersionId: version.id, creatorId, currentState: "ACCEPTED", currentNodeId: null, postAcceptanceMode: "local_payment",
    }).returning())[0]!;
    await appendEvent({ instanceId: inst.id, type: "NEGOTIATION_TURN", nodeId: "node-negotiation", payload: { outcome: "accept", round: 1, message: "Deal", rate: AGREED_RATE } });
    return inst;
  };
  const instA = await mkInstance(creatorA.id);
  const instR = await mkInstance(creatorR.id);
  const instC = await mkInstance(creatorC.id);

  const cleanup = async () => {
    for (const id of [instA.id, instR.id, instC.id]) {
      await db.delete(events).where(eq(events.instanceId, id));
      await db.delete(messages).where(eq(messages.instanceId, id));
      await db.delete(brandApprovals).where(eq(brandApprovals.instanceId, id));
      await db.delete(brandNotifications).where(eq(brandNotifications.instanceId, id));
      await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, id));
      await db.delete(executionInstances).where(eq(executionInstances.id, id));
    }
    await db.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
    for (const c of [creatorA, creatorR, creatorC]) await db.delete(creators).where(eq(creators.id, c.id));
    await rm(uploadDir, { recursive: true, force: true });
    server.close();
    if (prevUploads === undefined) delete process.env["UPLOADS_DIR"]; else process.env["UPLOADS_DIR"] = prevUploads;
    if (prevBase === undefined) delete process.env["PAYMENT_BASE_URL"]; else process.env["PAYMENT_BASE_URL"] = prevBase;
  };

  const prevFlag = process.env["BRAND_APPROVAL_GATE_ENABLED"];
  try {
    const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

    // ── GATE ON ──────────────────────────────────────────────────────────────
    process.env["BRAND_APPROVAL_GATE_ENABLED"] = "true";

    // 1. ACCEPTED → AWAITING_BRAND_APPROVAL, brand emailed, NO creator brief.
    await runtime.stepInstance(instA.id);
    assert.equal(await state(instA.id), "AWAITING_BRAND_APPROVAL", "gate should hold in AWAITING_BRAND_APPROVAL");
    console.log("  ✓ ACCEPTED → AWAITING_BRAND_APPROVAL (deal held for the brand)");

    const msgsA = await listMessagesByInstance(instA.id);
    const brandEmail = msgsA.find((m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("brand-approval:"));
    assert.ok(brandEmail, "a brand-approval email must be sent");
    assert.ok(/\/brand-approval\/approve\//.test(brandEmail!.body), "brand email must carry the approve link");
    assert.ok(/\/brand-approval\/reject\//.test(brandEmail!.body), "brand email must carry the reject link");
    assert.ok(brandEmail!.body.includes(`$${AGREED_RATE}`), "brand email must state the agreed fee");
    // NO content-brief email to the creator yet.
    assert.ok(!msgsA.some((m) => (m.idempotencyKey ?? "").startsWith("content-brief:")), "NO content brief before approval");
    console.log("  ✓ brand emailed approve/reject links + terms; creator got NO brief yet");

    // BrandApproval row exists, hash-only, AWAITING_APPROVAL.
    const rowA = await findBrandApprovalByInstance(instA.id);
    assert.ok(rowA, "a BrandApproval row must exist");
    assert.equal(rowA!.status, "AWAITING_APPROVAL");
    assert.match(rowA!.approveTokenHash, /^[0-9a-f]{64}$/, "only the sha256 hash is stored");
    const evA = await listEventsByInstance(instA.id);
    assert.ok(evA.some((e) => e.type === "BRAND_APPROVAL_REQUESTED"), "BRAND_APPROVAL_REQUESTED event recorded");

    // 2. GET interstitial renders and mutates nothing.
    const approvalId = approvalIdFromBody(brandEmail!.body);
    const rawApprove = tokenFromBody(brandEmail!.body, "approve");
    const before = await findBrandApprovalByInstance(instA.id);
    const getRes = await fetch(`${origin}/brand-approval/approve/${approvalId}?token=${rawApprove}`);
    assert.equal(getRes.status, 200, "GET interstitial should render 200");
    const getHtml = await getRes.text();
    assert.ok(/Approve this creator\?/.test(getHtml), "interstitial shows the approve prompt");
    const after = await findBrandApprovalByInstance(instA.id);
    assert.equal(after!.status, before!.status, "GET must NOT mutate the decision");
    assert.equal(await state(instA.id), "AWAITING_BRAND_APPROVAL", "GET must NOT advance the instance");
    console.log("  ✓ GET interstitial renders + mutates nothing (mail-prefetch safe)");

    // Tamper: wrong token 404s.
    const badRes = await fetch(`${origin}/brand-approval/approve/${approvalId}?token=deadbeef`);
    assert.equal(badRes.status, 404, "a tampered token must 404");
    console.log("  ✓ tampered token → 404");

    // 3. POST approve → content brief goes out, instance → PAYMENT_PENDING.
    const postRes = await fetch(`${origin}/brand-approval/approve/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${rawApprove}`,
    });
    assert.equal(postRes.status, 200, "POST approve should render 200");
    assert.equal(await state(instA.id), "PAYMENT_PENDING", "approve should release the brief → PAYMENT_PENDING");
    const msgsA2 = await listMessagesByInstance(instA.id);
    const brief = msgsA2.find((m) => (m.idempotencyKey ?? "").startsWith("content-brief:"));
    assert.ok(brief, "the content brief must be sent on approve");
    assert.ok(/\/payment\//.test(brief!.body), "brief must include the tokenized payout link");
    const rowA2 = await findBrandApprovalByInstance(instA.id);
    assert.equal(rowA2!.status, "APPROVED", "BrandApproval row marked APPROVED");
    const evA2 = await listEventsByInstance(instA.id);
    assert.ok(evA2.some((e) => e.type === "BRAND_APPROVED"), "BRAND_APPROVED event recorded");
    console.log("  ✓ POST approve → content brief + payout link sent, instance PAYMENT_PENDING");

    // Reuse: a re-POST of the now-decided link is a safe idempotent notice (no throw).
    const reRes = await fetch(`${origin}/brand-approval/approve/${approvalId}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${rawApprove}`,
    });
    assert.equal(reRes.status, 200, "re-POST of a decided link is a safe notice");
    assert.equal(await state(instA.id), "PAYMENT_PENDING", "re-POST must not re-advance");
    console.log("  ✓ re-POST of a decided approve link is idempotent");

    // 4. REJECT path (separate instance).
    await runtime.stepInstance(instR.id);
    assert.equal(await state(instR.id), "AWAITING_BRAND_APPROVAL");
    const msgsR = await listMessagesByInstance(instR.id);
    const brandEmailR = msgsR.find((m) => (m.idempotencyKey ?? "").startsWith("brand-approval:"))!;
    const rejectId = approvalIdFromBody(brandEmailR.body);
    const rawReject = tokenFromBody(brandEmailR.body, "reject");
    const rejRes = await fetch(`${origin}/brand-approval/reject/${rejectId}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${rawReject}`,
    });
    assert.equal(rejRes.status, 200, "POST reject should render 200");
    assert.equal(await state(instR.id), "MANUAL_REVIEW", "reject should halt to MANUAL_REVIEW");
    const msgsR2 = await listMessagesByInstance(instR.id);
    assert.ok(!msgsR2.some((m) => (m.idempotencyKey ?? "").startsWith("content-brief:")), "reject must NOT send a brief");
    const evR = await listEventsByInstance(instR.id);
    assert.ok(evR.some((e) => e.type === "BRAND_REJECTED"), "BRAND_REJECTED event recorded");
    // A courteous creator close email is RESERVED on reject (so the creator, who
    // had agreed terms, isn't left hanging). The row exists pre-flush; its body
    // must NOT leak the brand's decision, a rate, or any token/brief link.
    const closeMsg = msgsR2.find((m) => (m.idempotencyKey ?? "").startsWith("brand-reject-close:"));
    assert.ok(closeMsg, "reject reserves a creator close email (brand-reject-close:)");
    assert.equal(closeMsg!.direction, "OUTBOUND", "close email is OUTBOUND to the creator");
    assert.ok(!/\/brand-approval\//.test(closeMsg!.body), "close email must NOT carry an approve/reject link");
    assert.ok(!/\$\d/.test(closeMsg!.body), "close email must NOT state a rate");
    // No literal unresolved {{tokens}} leaked into the copy. (Note: the test
    // creator is named "Creator reject", so a naive /reject/ substring match would
    // false-positive on the greeting — the checks above target the real leak risks.)
    assert.ok(!/\{\{/.test(closeMsg!.body), "close email must have no unresolved template tokens");
    assert.ok(/not to move forward|stay in touch/i.test(closeMsg!.body), "close email reads as a warm close");
    console.log("  ✓ POST reject → MANUAL_REVIEW, no brief sent, creator close email reserved");

    // ── GATE OFF (control) ─────────────────────────────────────────────────────
    process.env["BRAND_APPROVAL_GATE_ENABLED"] = "false";
    await runtime.stepInstance(instC.id);
    assert.equal(await state(instC.id), "PAYMENT_PENDING", "gate OFF → straight to the content brief (unchanged)");
    const msgsC = await listMessagesByInstance(instC.id);
    assert.ok(msgsC.some((m) => (m.idempotencyKey ?? "").startsWith("content-brief:")), "gate OFF sends the brief immediately");
    assert.ok(!msgsC.some((m) => (m.idempotencyKey ?? "").startsWith("brand-approval:")), "gate OFF sends NO brand-approval email");
    console.log("  ✓ gate OFF: ACCEPTED → PAYMENT_PENDING directly (existing behavior preserved)");

    console.log("\n  All brand-approval-gate assertions passed.\n");
  } finally {
    if (prevFlag === undefined) delete process.env["BRAND_APPROVAL_GATE_ENABLED"];
    else process.env["BRAND_APPROVAL_GATE_ENABLED"] = prevFlag;
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nBrand Approval harness FAILED:", err);
    process.exit(1);
  });
