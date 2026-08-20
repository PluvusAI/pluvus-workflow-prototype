import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Content Brief — "Your Campaign Brief" email copy (merged post-negotiation email)
// ---------------------------------------------------------------------------
// This is now the SINGLE email sent after a successful negotiation. It merges what
// used to be three separate emails (Reward Setup confirmation + Payment Info
// request + Content Brief) into one:
//   1. the finalized offer terms (fee / commission / deliverables / timeline),
//   2. a secure tokenized payout-form link the creator completes, and
//   3. the campaign brief itself (PDF attached by the executor) + optional
//      brand notes.
// NOTE: no manual referral link is rendered here — attribution mints a UNIQUE
// per-creator tracking link (partnership.ts) delivered in the welcome email, so a
// static brand-typed link would be redundant and track nothing.
// Kept as a pure builder (like rewardEmail.ts / paymentEmail.ts) so it is the
// single source of truth for the body and is unit-testable without a DB or the
// file system. The PDF attachment is loaded + attached by the executor; this only
// renders the text.

export interface ContentBriefInput {
  creatorName: string;
  brandName: string;
  /** Secure tokenized payout-form link the creator must complete. Required. */
  formLink: string;
  /** Final agreed fee. Rendered as "$<n>", or "the agreed fee" when undefined. */
  fixedFee?: number | undefined;
  /** Commission %. Rendered as "<n>%", or "None" when absent/zero. */
  commissionRate?: number | undefined;
  /** Pre-formatted, creator-readable deliverable lines (PLU-143:
   *  formatDeliverablesForCreator), rendered as bullets verbatim. */
  deliverableLines?: string[] | undefined;
  /** Optional go-live timeline; stated only when present. */
  timeline?: string | undefined;
  /** Optional brand-authored notes, shown in the body. Empty string when none. */
  creatorNotes: string;
  /** Optional product/sample reward blurb. Empty string for cash-only deals. */
  rewardDescription?: string;
}

/** Render the merged "Your Campaign Brief" email body + subject. */
export function renderContentBriefEmail(input: ContentBriefInput): EmailDraft {
  const notes = input.creatorNotes.trim();
  const reward = (input.rewardDescription ?? "").trim();
  const formLink = input.formLink.trim();

  // Finalized-terms block — mirrors renderRewardConfirmationEmail's formatting so
  // the offer reads identically to the old confirmation email.
  const feeLine = input.fixedFee !== undefined ? `$${input.fixedFee}` : `the agreed fee`;
  const commissionLine =
    input.commissionRate && input.commissionRate > 0 ? `${input.commissionRate}%` : `None`;
  const items = input.deliverableLines ?? [];
  const deliverablesBlock =
    items.length > 0 ? items.map((d) => `    - ${d}`).join("\n") : `    - To be finalized`;
  const timeline =
    typeof input.timeline === "string" && input.timeline.trim() ? input.timeline.trim() : undefined;

  const lines: string[] = [
    `Hi ${input.creatorName},`,
    ``,
    `Wonderful — now that we've agreed on the details, welcome aboard! We're really glad to have you and can't wait to get started.`,
    ``,
    `Just so we're both on the same page, here are the terms we settled on:`,
    ``,
    `• Fixed Fee: ${feeLine}`,
    `• Commission: ${commissionLine}`,
    `• Deliverables:`,
    deliverablesBlock,
    // Reward + Timeline are optional lines, appended only when supplied.
    ...(reward ? [`• Reward: ${reward}`] : []),
    ...(timeline ? [`• Timeline: ${timeline}`] : []),
    ``,
    `Before we begin, please complete your secure payout information here:`,
    ``,
    formLink,
    ``,
    `Attached is your campaign brief containing all campaign requirements, deliverables, timelines, and content guidelines.`,
  ];

  // Optional creator notes — appended verbatim as their own paragraph.
  if (notes) {
    lines.push(``, notes);
  }

  lines.push(
    ``,
    `Please review the attached document carefully before creating your content.`,
    ``,
    // Content-links request: the close of the funnel. Once the creator's content
    // is live, we ask them to reply IN THIS SAME THREAD with the link(s) — no new
    // form or login. The instance parks on CONTENT_LINKS_PENDING to receive it.
    `Once your content is live, just reply to this email with the link(s) to your posted content so we can take a look.`,
    ``,
    `And if anything is unclear along the way, simply reply to this email — we're happy to help.`,
    ``,
    `Looking forward to working with you!`,
    ``,
    `Best,`,
    `${input.brandName}`,
  );

  return { subject: `Your Campaign Brief`, body: lines.join("\n") };
}
