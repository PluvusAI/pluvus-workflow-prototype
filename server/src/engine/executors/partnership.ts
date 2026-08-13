import { isUniqueViolation } from "../../db/errors.js";
import {
  db,
  appendEvent,
  findPartnershipByInstance,
  createPartnership,
  createObligation,
  generateReferralCode,
  listEventsByInstance,
  listObligationsByPartnership,
} from "../../db/index.js";
import type { ExecutionContext } from "../types.js";
import type { IEmailProvider } from "../providers.js";
import type { Partnership } from "../../db/schema.js";
import { sendOnce } from "./idempotentSend.js";
import { renderPartnershipWelcomeEmail } from "./partnershipWelcomeEmail.js";
import { resolveAgreedFee, firstNumber } from "./agreedFee.js";
import { resolveBrandName } from "../campaignContext.js";
import { paymentBaseUrl } from "./paymentEmail.js";
import { isSafeRedirectUrl } from "../../validation/targetUrl.js";

// ---------------------------------------------------------------------------
// Partnership minting (Phase 1)
// ---------------------------------------------------------------------------
// Called from both completion executors after the workflow reaches a terminal
// state. Idempotent: a BullMQ retry or re-submit must not mint a second row.
// Failures are swallowed — a failed mint never fails the payout submission.
// ---------------------------------------------------------------------------

const MAX_CODE_ATTEMPTS = 5;

/**
 * Build the tracking link for a referral code and campaign target URL.
 * Returns null when the campaign has no targetUrl.
 */
export function buildTrackingLink(
  targetUrl: string | null | undefined,
  hiddenParamKey: string,
  referralCode: string,
): string | null {
  if (!targetUrl) return null;
  // BUG-SEC5 defense-in-depth: even though campaign create/update now validates
  // the scheme, re-check here so a legacy row (stored before validation existed)
  // or a non-http(s) value can never produce a trackingLink the /t redirect would
  // 302 to. A rejected URL yields null → the redirect 404s instead of bouncing.
  if (!isSafeRedirectUrl(targetUrl)) return null;
  try {
    const url = new URL(targetUrl);
    url.searchParams.set(hiddenParamKey, referralCode);
    return url.toString();
  } catch {
    return null;
  }
}

/** Human-readable description stamped on the auto-minted fixed-fee obligation. */
export const FEE_OBLIGATION_DESCRIPTION = "Agreed collaboration fee";

/**
 * Mint the fixed-fee Obligation for a partnership, at most once.
 *
 * A partnership has at most one auto-minted fee obligation (manual extras are
 * Phase-4+ future work), so we check for any existing obligation first and no-op
 * if one is present. A null/absent agreed fee mints nothing. Returns true when a
 * row was created, false when it was a no-op (already present, or no fee).
 * Shared by resolvePartnership (mint-time) and the backfill script.
 */
export async function mintFeeObligation(
  partnershipId: string,
  agreedFeeCents: number | null | undefined,
): Promise<boolean> {
  // No fee, or a zero/negative fee, owes nothing — mint no obligation. Guarding
  // > 0 (not just null/undefined) stops a commission-only deal whose fixed fee
  // resolved to 0 from minting a $0.00 payable obligation, which would later
  // become a spurious "you've been paid $0.00" payout the creator must action.
  if (agreedFeeCents === null || agreedFeeCents === undefined) return false;
  if (!Number.isFinite(agreedFeeCents) || agreedFeeCents <= 0) return false;
  const existing = await listObligationsByPartnership(partnershipId);
  if (existing.length > 0) return false;
  // BUG-D1: the check above is advisory only — two concurrent mints (a BullMQ
  // retry racing the reconciliation sweep) can both read zero and both reach
  // this insert. The partial unique index Obligation_partnershipId_fee_key is
  // the real backstop: the loser's INSERT raises a unique violation, which we
  // swallow to a safe no-op here (the fee obligation already exists, so there is
  // nothing to do and nothing was double-created). Any other error propagates.
  try {
    await createObligation({
      partnershipId,
      description: FEE_OBLIGATION_DESCRIPTION,
      amountCents: agreedFeeCents,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  return true;
}

/**
 * Resolve (or reuse) the Partnership for this instance. Idempotent.
 *
 * Returns the partnership row (existing or newly minted), or null on failure
 * (callers log and continue — I-8 posture: attribution failures never break
 * the product path).
 */
export async function resolvePartnership(
  ctx: ExecutionContext,
  email: IEmailProvider,
): Promise<Partnership | null> {
  const { instance, creator, nodeGraph, campaign } = ctx;

  // Step 1: already minted? Return it (idempotency).
  const existing = await findPartnershipByInstance(instance.id);
  if (existing) return existing;

  // Step 2: resolve money terms from the persisted PAYMENT_INFO_SENT event (I-2).
  // That event carries fixedFee + commission, stamped by executeContentBrief /
  // executePaymentInfo at send time. Fall back to re-deriving only when absent
  // (direct-created test instances, legacy graphs).
  let fixedFee: number | undefined;
  let commissionRate: number | undefined;

  const paymentInfoEvents = await listEventsByInstance(instance.id, {
    type: "PAYMENT_INFO_SENT",
  });
  const piEvent = paymentInfoEvents[0];
  if (piEvent?.payload && typeof piEvent.payload === "object" && !Array.isArray(piEvent.payload)) {
    const p = piEvent.payload as Record<string, unknown>;
    if (typeof p["fixedFee"] === "number") fixedFee = p["fixedFee"] as number;
    if (typeof p["commission"] === "number") commissionRate = p["commission"] as number;
  }

  if (fixedFee === undefined) {
    // Fallback: re-derive from NEGOTIATION_TURN history + config.
    const negotiationConfig =
      nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const events = await listEventsByInstance(instance.id, {
      type: "NEGOTIATION_TURN",
    });
    fixedFee = resolveAgreedFee(events, negotiationConfig, {});
  }
  if (commissionRate === undefined) {
    const negotiationConfig =
      nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const cbConfig =
      nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ?? {};
    commissionRate = firstNumber(
      cbConfig["commissionRate"],
      negotiationConfig["commissionRate"],
    );
  }

  const agreedFeeCents =
    fixedFee !== undefined ? Math.round(fixedFee * 100) : null;

  // Step 3: resolve campaign tracking params.
  const targetUrl = campaign?.targetUrl ?? null;
  const hiddenParamKey = campaign?.hiddenParamKey ?? "_from";

  // Step 4: mint (with collision retry) or re-read on concurrent unique violation (I-3).
  // BUG-D-events: the winning mint attempt inserts the Partnership row AND appends
  // its PARTNERSHIP_ACTIVATED audit event in ONE transaction (inside mintWithRetry),
  // so the partnership and its ledger event commit or roll back together. A
  // concurrent reread (the losing path) does NOT re-append the event — the winner
  // already did, atomically — which also fixes the prior double-event on that path.
  let partnership: Partnership;
  try {
    partnership = await mintWithRetry(
      creator.name,
      instance.id,
      campaign?.id ?? null,
      creator.id,
      targetUrl,
      hiddenParamKey,
      commissionRate ?? null,
      agreedFeeCents,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A concurrent path already created the row (instanceId unique) — re-read.
      // The event was appended by that winning path's transaction, so we do not
      // append it again here.
      const reread = await findPartnershipByInstance(instance.id);
      if (reread) {
        partnership = reread;
      } else {
        console.error("[partnership] resolvePartnership: concurrent insert conflict, re-read returned null", err);
        return null;
      }
    } else {
      console.error("[partnership] resolvePartnership: mint failed", err);
      return null;
    }
  }

  // Step 5: mint the fixed-fee Obligation (Phase 3). A partnership with an
  // agreed fee owes it; the Obligation is the ledger row the brand later pays as
  // a FIXED_FEE payout. Idempotent (re-runs never create a second row — BUG-D1's
  // partial unique index is the backstop).
  //
  // BUG-E2: when the partnership HAS an agreed fee, the Obligation IS the money
  // the brand owes — so a failure to mint it must NOT return a "successful"
  // partnership. Returning null routes the caller (the terminal-hop submission
  // executors) to MANUAL_REVIEW instead of the success terminal, so the deal is
  // never marked complete with the fee ledger row missing. A partnership with no
  // agreed fee owes no obligation, so a no-op mint is success.
  try {
    await mintFeeObligation(partnership.id, partnership.agreedFeeCents);
  } catch (err) {
    console.error("[partnership] fee obligation mint failed — treating as mint failure", err);
    return null;
  }

  // Step 6: send the welcome email (idempotent, I-6).
  try {
    const brandName = resolveBrandName(
      nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ??
        nodeGraph.find((n) => n.type === "PAYMENT_INFO")?.config ??
        {},
      campaign,
    ) ?? (campaign?.brand ?? "Your brand");

    const cbConfig =
      nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ??
      nodeGraph.find((n) => n.type === "PAYMENT_INFO")?.config ??
      {};
    const senderName =
      typeof cbConfig["senderName"] === "string"
        ? (cbConfig["senderName"] as string)
        : brandName;

    const draft = renderPartnershipWelcomeEmail({
      creatorName: creator.name,
      brandName,
      senderName,
      trackingLink: partnership.trackingLink,
      agreedFeeCents: partnership.agreedFeeCents,
      commissionRate: partnership.commissionRate,
    });

    await sendOnce(
      email,
      instance.id,
      creator,
      draft,
      `partnership:welcome:${instance.id}`,
    );
  } catch (err) {
    console.error("[partnership] welcome email failed (non-fatal)", err);
  }

  return partnership;
}

// Internal helper that does the full retry loop building the tracking link
// per attempt (code changes each attempt so the link must change too).
//
// BUG-D-events: each attempt inserts the Partnership row AND appends its
// PARTNERSHIP_ACTIVATED audit event inside ONE db.transaction, so the row and its
// ledger event commit or roll back together. A unique violation (duplicate
// referral code) rolls the whole attempt back — event included — and the loop
// retries with a fresh code; a duplicate instanceId rolls back and propagates so
// the caller re-reads the concurrent winner (which appended its own event).
async function mintWithRetry(
  creatorName: string,
  instanceId: string,
  campaignId: string | null,
  creatorId: string,
  targetUrl: string | null,
  hiddenParamKey: string,
  commissionRate: number | null,
  agreedFeeCents: number | null,
): Promise<Partnership> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateReferralCode(creatorName);
    const trackingLink = buildTrackingLink(targetUrl, hiddenParamKey, code);
    try {
      return await db.transaction(async (tx) => {
        const partnership = await createPartnership(
          {
            instanceId,
            campaignId,
            creatorId,
            referralCode: code,
            trackingLink,
            commissionRate,
            agreedFeeCents,
          },
          tx,
        );
        await appendEvent(
          {
            instanceId,
            type: "PARTNERSHIP_ACTIVATED",
            payload: {
              referralCode: partnership.referralCode,
              trackingLink: partnership.trackingLink ?? null,
              commissionRate: partnership.commissionRate ?? null,
              agreedFeeCents: partnership.agreedFeeCents ?? null,
            },
          },
          tx,
        );
        return partnership;
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_CODE_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  throw new Error("exhausted referral code attempts");
}
