import type { ExecutionContext } from "../types.js";
import type { IEmailProvider } from "../providers.js";
import { reserveOutbound } from "./idempotentSend.js";
import { randomSendDelayMs } from "../sendDelay.js";
import { resolveBrandName } from "../campaignContext.js";

// ---------------------------------------------------------------------------
// Creator close email on brand REJECT (brand-approval gate)
// ---------------------------------------------------------------------------
// When the brand clicks Reject on the approval magic link, the deal halts to
// MANUAL_REVIEW and the creator — who had already agreed terms — would otherwise
// hear nothing. This sends the creator a brief, courteous close so they aren't
// left hanging.
//
// Deliberately mirrors the max-rounds auto-close (negotiation.ts reserveCloseEmail):
//   - rendered from a FIXED template through the provider's own draft() seam, so it
//     works with mock + real providers WITHOUT an LLM call (a close note must never
//     fail-and-escalate, and must not gate the MANUAL_REVIEW transition);
//   - says NOTHING about the brand's decision, budget, rate, or internal bounds —
//     no {{rate}}/{{floor}}/{{ceiling}} tokens, so there is nothing for the output
//     guard to leak. It reads as a warm "we won't be moving forward this time",
//     never "the brand rejected you";
//   - RESERVES the row (no inline send) and returns its deferredSend so the caller
//     enqueues the delayed flush AFTER the OCC commit — a rolled-back reject never
//     emails the creator;
//   - idempotent (keyed per instance) so a double-click / BullMQ retry can't
//     double-email;
//   - best-effort: a reserve failure is swallowed so the run still reaches
//     MANUAL_REVIEW.

// The idempotency key for the reject close email. One per instance — the reject is
// a terminal, one-time event, so keying on the instance (not a round) is correct
// and makes a retry a no-op.
export function brandRejectCloseKey(instanceId: string): string {
  return `brand-reject-close:${instanceId}`;
}

export function renderBrandRejectCloseTemplate(args: {
  senderName: string;
  brandName: string;
}): string {
  const { senderName, brandName } = args;
  // No mention of the brand's decision — just a warm, non-committal close, so a
  // creator never reads "the brand said no". Same tone as the max-rounds auto-close.
  return [
    `Hi {{creatorName}},`,
    ``,
    `Thank you so much for taking the time to work through a partnership with ${brandName} — we really enjoyed the conversation and appreciated your interest.`,
    ``,
    `After a final review on our end, we've decided not to move forward with this particular collaboration. That's no reflection on you at all — these decisions come down to fit and timing for the campaign, and we'd genuinely love to stay in touch for future opportunities where things line up better.`,
    ``,
    `Thank you again, and we hope to have the chance to work together down the line.`,
    ``,
    `Warmly,`,
    `${senderName}`,
  ].join("\n");
}

/**
 * Reserve (do NOT send) the courteous creator close email for a brand reject.
 * Returns the deferredSend the caller flushes post-commit, or undefined when the
 * reserve failed (swallowed) or the send was already delivered on a prior attempt.
 * Never throws — a close-email failure must not block the MANUAL_REVIEW transition.
 */
export async function reserveBrandRejectCloseEmail(
  ctx: ExecutionContext,
  email: IEmailProvider,
): Promise<{ messageId: string; delayMs: number } | undefined> {
  const { instance, node, creator, campaign } = ctx;
  const config = node?.config ?? {};

  const senderName =
    typeof config["senderName"] === "string" && config["senderName"].trim().length > 0
      ? config["senderName"]
      : "Pluvus Partnerships";
  // Brand name for the body: node config → campaign.brand → the sender name as a
  // safe, generic fallback (never leaves a literal "{{brandName}}" in the copy).
  const brandName = resolveBrandName(config, campaign) ?? senderName;

  const template = renderBrandRejectCloseTemplate({ senderName, brandName });

  try {
    const draft = await email.draft(creator, template, config);
    const reserved = await reserveOutbound(
      instance.id,
      draft,
      brandRejectCloseKey(instance.id),
    );
    if (reserved.alreadySent) {
      // Already delivered on a prior attempt — no re-enqueue, no re-draw.
      return undefined;
    }
    return { messageId: reserved.messageId, delayMs: randomSendDelayMs() };
  } catch (err) {
    // Best-effort: never let a close-email reserve failure block the reject.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[brandApproval] reject close email reserve failed for instance ${instance.id}: ${message}`,
    );
    return undefined;
  }
}
