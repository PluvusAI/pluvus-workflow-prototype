import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Brand-approval gate — the BRAND-facing "approve this creator?" email
// ---------------------------------------------------------------------------
// Sent to the brand (campaign.notifyEmail chain) after a creator ACCEPTS on a
// local_payment execution and BEFORE the creator receives anything. It restates
// the closed deal — who the creator is + the agreed terms — and asks the brand to
// Approve or Reject via two magic links. On Approve the content brief + payout
// link go out; on Reject the run halts to manual review.
//
// v1 (hardcoded): the only two responses are the Approve / Reject links. There is
// no free-text negotiation of terms in this loop — that stays with the operator.
//
// Pure builder (like contentBriefEmail.ts / operatorHandoffEmail.ts) so the copy
// is unit-testable without a DB, a mailbox, or the token layer.

export interface BrandApprovalEmailInput {
  brandName: string;
  creatorName: string;
  creatorHandle?: string | null;
  creatorPlatform?: string | null;
  campaignName?: string | null;
  fixedFee?: number | null;
  commissionRate?: number | null;
  negotiationFloor?: number | null;
  negotiationCeiling?: number | null;
  deliverables?: string | null;
  timeline?: string | null;
  paymentTerms?: string | null;
  rewardDescription?: string | null;
  /** Absolute Approve link (carries the raw token). */
  approveLink: string;
  /** Absolute Reject link (carries the raw token). */
  rejectLink: string;
}

const SENDER_NAME = "Pluvus";

/** Whole numbers read as "$450", not "$450.00"; cents kept when present. */
function formatDollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Trim a trailing ".0" so a whole number reads as "10", not "10.0". */
function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** "$450 (your range: $200–$500)" — the range clause only when a band exists. */
function formatFeeLine(input: BrandApprovalEmailInput): string | null {
  const { fixedFee, negotiationFloor, negotiationCeiling } = input;
  if (typeof fixedFee !== "number" || !Number.isFinite(fixedFee)) return null;
  const hasRange =
    typeof negotiationFloor === "number" &&
    Number.isFinite(negotiationFloor) &&
    typeof negotiationCeiling === "number" &&
    Number.isFinite(negotiationCeiling);
  const range = hasRange
    ? ` (your range: ${formatDollars(negotiationFloor!)}–${formatDollars(negotiationCeiling!)})`
    : "";
  return `${formatDollars(fixedFee)}${range}`;
}

/**
 * Render the brand-approval request email.
 *
 * The subject is a direct question so it reads as an action item in the brand's
 * inbox. The body leads with the creator profile, then the agreed terms, then the
 * two links, then a one-line note that Approve releases the brief and Reject holds
 * the deal.
 */
export function renderBrandApprovalEmail(input: BrandApprovalEmailInput): EmailDraft {
  const {
    brandName,
    creatorName,
    creatorHandle,
    creatorPlatform,
    campaignName,
    commissionRate,
    deliverables,
    timeline,
    paymentTerms,
    rewardDescription,
    approveLink,
    rejectLink,
  } = input;

  const creatorLine = creatorHandle
    ? `${creatorName} (@${creatorHandle})`
    : creatorName;
  const campaignPhrase = campaignName ? ` for the ${campaignName} campaign` : "";

  const subject = `Approve ${creatorName}${
    campaignName ? ` for ${campaignName}` : ""
  }?`;

  const feeLine = formatFeeLine(input);
  const hasCommission =
    typeof commissionRate === "number" &&
    Number.isFinite(commissionRate) &&
    commissionRate > 0;

  const lines = [
    `Hi ${brandName},`,
    ``,
    `${creatorName} has agreed to terms${campaignPhrase}. Before we send them the content brief and payout link, we'd like your sign-off.`,
    ``,
    `Creator`,
    `Name: ${creatorLine}${creatorPlatform ? ` on ${creatorPlatform}` : ""}`,
    ``,
    `Agreed terms`,
    ...(feeLine ? [`Fee: ${feeLine}`] : []),
    ...(hasCommission
      ? [`Commission: ${formatAmount(commissionRate!)}% on sales through the referral link`]
      : []),
    ...(deliverables ? [`Deliverables: ${deliverables}`] : []),
    ...(timeline ? [`Timeline: ${timeline}`] : []),
    ...(paymentTerms ? [`Payment terms: ${paymentTerms}`] : []),
    ...(rewardDescription ? [`Perk: ${rewardDescription}`] : []),
    ``,
    `Approve — send ${creatorName} the content brief + payout link:`,
    approveLink,
    ``,
    `Reject — hold this deal for a human to review:`,
    rejectLink,
    ``,
    `Clicking Approve releases the content brief and payout link to the creator. Clicking Reject pauses the deal — nothing is sent to the creator and our team will follow up. The creator is holding until you decide.`,
    ``,
    `Best,`,
    SENDER_NAME,
  ];

  return { subject, body: lines.join("\n") };
}
