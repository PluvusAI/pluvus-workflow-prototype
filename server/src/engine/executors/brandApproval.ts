import type { JsonObject } from "../../db/schema.js";
import {
  createBrandApprovalOnce,
  rotateBrandApprovalToken,
  findMessageByIdempotencyKey,
  listEventsByInstance,
  listMessagesByInstance,
} from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { renderBrandApprovalEmail } from "./brandApprovalEmail.js";
import {
  mintBrandApprovalToken,
  brandApproveLink,
  brandRejectLink,
} from "./brandApprovalToken.js";
import { resolveAgreedFee, firstNumber, firstString } from "./agreedFee.js";
import { resolveBand } from "../band.js";
import { resolveBrandName, type CampaignBrandFields } from "../campaignContext.js";
import { blockedByMissingBrand } from "./guardEscalation.js";
import { resolveBrandRecipient } from "../../notifications/escalation.js";

// ---------------------------------------------------------------------------
// Brand-approval executor (brand-approval gate)
// ---------------------------------------------------------------------------
// The post-acceptance path for a local_payment execution when the brand-approval
// gate is ON (BRAND_APPROVAL_GATE_ENABLED). It runs on ACCEPTED, INSTEAD of the
// merged Content Brief SEND phase, and holds the deal for the brand's sign-off:
//
//   1. Snapshot the agreed terms + creator profile into BrandApproval (idempotent
//      on instanceId), minting a magic-link token (only its hash is stored).
//   2. Email the BRAND (campaign.notifyEmail chain) the "approve this creator?"
//      email with Approve / Reject magic links. Nothing is sent to the creator.
//   3. Park the execution in AWAITING_BRAND_APPROVAL.
//
// On the brand clicking Approve, the route advances the instance to PAYMENT_PENDING
// via the Content Brief SEND phase (the brief + payout link finally go out). On
// Reject the route halts to MANUAL_REVIEW. Neither the money ledger nor any
// creator-facing email happens in this executor — it is a pure gate.
//
// Idempotency: the BrandApproval insert is UNIQUE on instanceId, and the send is
// keyed by sendOnce. A BullMQ retry re-runs the whole function. Token consistency
// across retries (PLU-118, Calvin review §1) is handled in step 3b: on a retry
// that finds an existing row whose email never went out, the token is ROTATED to
// the one we are about to send (hash + expiry together) so the emailed links match
// the stored hash; on a retry where the email already reserved/sent, the original
// token stays and the send dedupes. Either way the brand always receives links
// that validate against the stored hash.

export async function executeBrandApproval(
  ctx: ExecutionContext,
  email: IEmailProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator, campaign } = ctx;
  const config = node.config;
  // PLU-135 (1a): deliverables/timeline/paymentTerms/rewardDescription moved
  // off Campaign onto CampaignDetails — see campaignContext.ts's
  // CampaignBrandFields doc comment.
  const campaignFields: CampaignBrandFields | null = campaign ?? null;

  if (instance.currentState !== "ACCEPTED") {
    throw new Error(
      `Brand approval expects ACCEPTED state, got ${instance.currentState}`,
    );
  }

  // 1. Resolve the brand name. Same L4 contract as every other post-acceptance
  //    executor: with no resolvable brand name we escalate rather than proceed.
  const brandName = resolveBrandName(config, campaign);
  if (brandName === undefined) {
    return blockedByMissingBrand(node.type);
  }

  // 2. Resolve the agreed terms from the same sources the local flow uses.
  const negotiationConfig =
    nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
  const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });

  // CRITICAL-3 parity: the brand-approval email states the agreed fee to the
  // brand, so a missing agreed rate would mean asking the brand to approve a
  // fabricated figure. Escalate to a human instead. (Commission-only deals are
  // handled below — an absent fee with a real commission is legitimate, so we
  // only escalate when BOTH the fee AND the commission are absent.)
  const fixedFee = resolveAgreedFee(events, negotiationConfig, config);
  const commissionRate = firstNumber(
    config["commissionRate"],
    negotiationConfig["commissionRate"],
  );
  if (fixedFee === undefined && commissionRate === undefined) {
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "MANUAL_REVIEW_FLAGGED",
      eventPayload: { outcome: "ESCALATE", reason: "no_agreed_terms", node: node.type },
    };
  }

  const deliverables = firstString(
    config["deliverables"],
    negotiationConfig["deliverables"],
    campaignFields?.deliverables,
  );
  const timeline = firstString(
    config["timeline"],
    negotiationConfig["timeline"],
    campaignFields?.timeline,
  );
  const paymentTerms = firstString(config["paymentTerms"], campaignFields?.paymentTerms);
  const rewardDescription = firstString(
    config["rewardDescription"],
    negotiationConfig["rewardDescription"],
    campaignFields?.rewardDescription,
  );
  const { floor: negotiationFloor, ceiling: negotiationCeiling } =
    resolveBand(negotiationConfig);

  // Accepting turn's timestamp — the moment the deal closed (for the snapshot).
  const acceptEvent = [...events].reverse().find((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return typeof p?.["outcome"] === "string" && p["outcome"].toLowerCase() === "accept";
  });
  const acceptedAt = acceptEvent?.occurredAt ?? new Date();

  // Thread pointer, best-effort (a missing thread must not block the gate).
  let threadId: string | undefined;
  try {
    const messages = await listMessagesByInstance(instance.id);
    threadId = [...messages].reverse().find((m) => m.threadId)?.threadId ?? undefined;
  } catch (err) {
    console.error(
      `[brandApproval] could not resolve threadId for ${instance.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 3. Mint a candidate token + persist the snapshot. `created` tells us whether
  //    THIS attempt inserted the row (so the minted token's hash is what we stored)
  //    or whether a prior attempt's row already existed (so the stored hash is from
  //    an EARLIER mint — see the token-reconciliation step below, which decides
  //    whether the freshly minted token is safe to email or must be rotated in).
  const minted = mintBrandApprovalToken();
  const { approval, created } = await createBrandApprovalOnce({
    instanceId: instance.id,
    creatorName: creator.name,
    creatorEmail: creator.email,
    campaignName: campaign?.name ?? null,
    brandName,
    fixedFee: fixedFee ?? null,
    commissionRate: commissionRate ?? null,
    negotiationFloor: negotiationFloor ?? null,
    negotiationCeiling: negotiationCeiling ?? null,
    deliverables: deliverables ?? null,
    timeline: timeline ?? null,
    paymentTerms: paymentTerms ?? null,
    rewardDescription: rewardDescription ?? null,
    creatorHandle: creator.handle ?? null,
    creatorPlatform: creator.platform ?? null,
    threadId: threadId ?? null,
    acceptedAt,
    approveTokenHash: minted.tokenHash,
    tokenExpiresAt: minted.expiresAt,
  });

  // 3b. Reconcile the token with the persisted row (PLU-118, Calvin review §1).
  //     The failure window: a prior attempt INSERTED the row but crashed BEFORE the
  //     email reserved/sent. On retry `created` is false and `approval` carries the
  //     PRIOR attempt's token hash — but `minted` is a brand-new raw token whose
  //     hash does NOT match. Emailing links built from `minted` would be unusable
  //     (the route hashes the presented token and compares to the stored hash).
  //
  //     We resolve it by the send state of the brand-approval message:
  //       - FRESH insert (created)            → the stored hash IS minted's hash;
  //                                             email `minted`. (rawToken = minted)
  //       - retry, NO brand email row yet     → the stored-hash token never went
  //                                             out; ROTATE the row to `minted`
  //                                             (hash + expiry together) so the
  //                                             links we send match. (rawToken = minted)
  //       - retry, brand email already reserved/sent → the ORIGINAL token is already
  //                                             in the brand's inbox and matches the
  //                                             stored hash; do NOT rotate and do NOT
  //                                             resend a link we can't reproduce.
  //                                             sendOnce dedupes the send below.
  const sendKey = `brand-approval:${instance.id}`;
  let rawToken = minted.rawToken;
  let approvalRow = approval;
  if (!created) {
    const priorSend = await findMessageByIdempotencyKey(sendKey);
    if (!priorSend) {
      // Row exists but the email never reserved — rotate to the token we will send.
      const rotated = await rotateBrandApprovalToken(approval.id, {
        approveTokenHash: minted.tokenHash,
        tokenExpiresAt: minted.expiresAt,
      });
      if (rotated) {
        approvalRow = rotated;
        rawToken = minted.rawToken;
      } else {
        // Rotation matched nothing → the row is no longer AWAITING_APPROVAL (already
        // decided/PROCESSING). Nothing to (re)send; fall through to park.
        rawToken = "";
      }
    } else {
      // The original token is already emailed and matches the stored hash. We can't
      // reproduce it here (only its hash persisted), so we MUST NOT build fresh
      // links — sendOnce will dedupe the send. Signal "no fresh token" with "".
      rawToken = "";
    }
  }

  // 4. Email the BRAND. Recipient is the campaign.notifyEmail → BRAND_NOTIFY_EMAIL
  //    → operator fallback chain (resolveBrandRecipient). The brand is an explicit
  //    recipient (unlike creator-facing sends); if none resolves we still park in
  //    AWAITING_BRAND_APPROVAL — the row is visible and the notice can be re-sent
  //    via the manual-queue resend action (POST …/brand-approval/resend), which
  //    rotates the token and sends. We only build + send fresh links when we hold a
  //    token that matches the stored hash (rawToken !== ""); on an already-sent
  //    retry rawToken is "" and sendOnce would dedupe anyway, so we skip the send.
  const recipient = resolveBrandRecipient(campaign?.notifyEmail);
  if (recipient && rawToken) {
    const draft = renderBrandApprovalEmail({
      brandName,
      creatorName: creator.name,
      creatorHandle: creator.handle,
      creatorPlatform: creator.platform,
      campaignName: campaign?.name ?? null,
      fixedFee: fixedFee ?? null,
      commissionRate: commissionRate ?? null,
      negotiationFloor: negotiationFloor ?? null,
      negotiationCeiling: negotiationCeiling ?? null,
      deliverables: deliverables ?? null,
      timeline: timeline ?? null,
      paymentTerms: paymentTerms ?? null,
      rewardDescription: rewardDescription ?? null,
      approveLink: brandApproveLink(approvalRow.id, rawToken),
      rejectLink: brandRejectLink(approvalRow.id, rawToken),
    });
    await sendOnce(
      email,
      instance.id,
      creator,
      draft,
      sendKey,
      undefined, // deps — default
      { email: recipient, name: brandName },
      campaign?.name, // Gmail Campaign Labels (§6.3)
    );
  } else if (!recipient) {
    console.error(
      `[brandApproval] no brand recipient for ${instance.id} — parked in ` +
        `AWAITING_BRAND_APPROVAL without a sent request (re-send via the manual queue).`,
    );
  }

  // 5. Park. NOT terminal and NOT completed — waiting on the brand. nextNodeId is
  //    the Content Brief node so a direct step / reply resolves the right node; the
  //    brand's Approve/Reject action resumes it from the route.
  return {
    nextState: "AWAITING_BRAND_APPROVAL",
    nextNodeId: node.id,
    eventType: "BRAND_APPROVAL_REQUESTED",
    eventPayload: {
      approvalId: approvalRow.id,
      ...(fixedFee !== undefined ? { fixedFee } : {}),
      ...(commissionRate !== undefined ? { commissionRate } : {}),
      recipient: recipient ?? null,
      acceptedAt: acceptedAt.toISOString(),
    } as JsonObject,
  };
}
