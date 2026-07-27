import {
  findBrandApprovalByInstance,
  rotateBrandApprovalToken,
  findInstanceById,
  findVersionById,
} from "../../db/index.js";
import { findWorkflowById } from "../../db/workflows.js";
import { findCampaignById } from "../../db/campaigns.js";
import type { Campaign, Creator } from "../../db/schema.js";
import type { IEmailProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { renderBrandApprovalEmail } from "./brandApprovalEmail.js";
import {
  mintBrandApprovalToken,
  brandApproveLink,
  brandRejectLink,
} from "./brandApprovalToken.js";
import { resolveBrandRecipient } from "../../notifications/escalation.js";

// ---------------------------------------------------------------------------
// Brand-approval RESEND / recovery (PLU-118, Calvin review — "additional things")
// ---------------------------------------------------------------------------
// Two dead-ends the original gate had no exit from:
//   - no brand recipient resolved at gate time → the execution parked in
//     AWAITING_BRAND_APPROVAL with NO email ever sent, and
//   - the token expired (14 days) before the brand clicked → the link is dead and
//     there was no way to issue a fresh one.
//
// Both are recovered the same way: ROTATE the token (a fresh hash + expiry, written
// together) and re-send the brand-approval email from the persisted snapshot, under
// a NEW idempotency key so sendOnce does not dedupe against the (possibly never
// sent) original. Only valid while the row is still AWAITING_APPROVAL and the
// instance is still parked in AWAITING_BRAND_APPROVAL — a decided/in-flight row is
// left untouched (rotateBrandApprovalToken is predicate-guarded on AWAITING_APPROVAL
// and returns null otherwise).
//
// Driven from the operator manual-queue route, NOT the executor: it is a human
// recovery action, like the existing escalation re-notify.

export type BrandApprovalResendOutcome =
  | { ok: true; recipient: string }
  | {
      ok: false;
      reason:
        | "no_approval_row"
        | "not_awaiting"
        | "instance_not_parked"
        | "no_recipient";
    };

/** Best-effort campaign lookup for an instance (version → workflow → campaign).
 *  Mirrors the runtime's loadContext fallback; any missing link → null. */
async function resolveCampaign(
  workflowVersionId: string,
): Promise<Campaign | null> {
  try {
    const version = await findVersionById(workflowVersionId);
    if (!version) return null;
    const workflow = await findWorkflowById(version.workflowId);
    if (!workflow?.campaignId) return null;
    return await findCampaignById(workflow.campaignId);
  } catch {
    return null;
  }
}

/**
 * Re-issue and re-send a brand-approval request for one instance. Returns a
 * structured outcome (never throws for the expected "can't resend" cases) so the
 * route can map it to a clean HTTP status.
 */
export async function resendBrandApprovalRequest(
  email: IEmailProvider,
  instanceId: string,
): Promise<BrandApprovalResendOutcome> {
  const instance = await findInstanceById(instanceId);
  if (!instance || instance.currentState !== "AWAITING_BRAND_APPROVAL") {
    return { ok: false, reason: "instance_not_parked" };
  }

  const row = await findBrandApprovalByInstance(instanceId);
  if (!row) return { ok: false, reason: "no_approval_row" };
  if (row.status !== "AWAITING_APPROVAL") return { ok: false, reason: "not_awaiting" };

  const campaign = await resolveCampaign(instance.workflowVersionId);
  const recipient = resolveBrandRecipient(campaign?.notifyEmail ?? null);
  if (!recipient) return { ok: false, reason: "no_recipient" };

  // Rotate the token (hash + expiry together) so the resent links are valid and the
  // clock restarts. Predicate-guarded: a row that left AWAITING_APPROVAL between our
  // read and here rotates 0 rows → treat as not-awaiting rather than send a link
  // against a stale hash.
  const minted = mintBrandApprovalToken();
  const rotated = await rotateBrandApprovalToken(row.id, {
    approveTokenHash: minted.tokenHash,
    tokenExpiresAt: minted.expiresAt,
  });
  if (!rotated) return { ok: false, reason: "not_awaiting" };

  // The brand's display name: prefer the persisted brandName; fall back to the
  // campaign brand / name (legacy rows). Never the literal filler.
  const brandName =
    rotated.brandName ??
    campaign?.brand ??
    rotated.campaignName ??
    campaign?.name ??
    "your brand";

  const draft = renderBrandApprovalEmail({
    brandName,
    creatorName: rotated.creatorName,
    creatorHandle: rotated.creatorHandle,
    creatorPlatform: rotated.creatorPlatform,
    campaignName: rotated.campaignName,
    fixedFee: rotated.fixedFee,
    commissionRate: rotated.commissionRate,
    negotiationFloor: rotated.negotiationFloor,
    negotiationCeiling: rotated.negotiationCeiling,
    deliverables: rotated.deliverables,
    timeline: rotated.timeline,
    paymentTerms: rotated.paymentTerms,
    rewardDescription: rotated.rewardDescription,
    approveLink: brandApproveLink(rotated.id, minted.rawToken),
    rejectLink: brandRejectLink(rotated.id, minted.rawToken),
  });

  // A DISTINCT idempotency key per resend (keyed on the new token hash) so sendOnce
  // treats this as a fresh send rather than deduping against the original attempt —
  // whether or not that original ever actually went out.
  const attemptKey = `brand-approval-resend:${instanceId}:${minted.tokenHash.slice(0, 16)}`;
  const creatorAddr = {
    id: "",
    name: rotated.creatorName,
    email: rotated.creatorEmail,
  } as unknown as Creator;
  await sendOnce(
    email,
    instanceId,
    creatorAddr,
    draft,
    attemptKey,
    undefined,
    { email: recipient, name: brandName },
    campaign?.name,
  );

  return { ok: true, recipient };
}
