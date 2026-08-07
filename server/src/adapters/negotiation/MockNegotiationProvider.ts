import type { NegotiationProvider } from "./NegotiationProvider.js";
import type {
  NegotiationRequest,
  NegotiationResponse,
  NegotiationAction,
  DraftRequest,
  DraftResponse,
  NegotiationTerm,
} from "./types.js";
import { renderRewardConfirmationEmail } from "../../engine/executors/rewardEmail.js";

// ---------------------------------------------------------------------------
// MockNegotiationProvider
// ---------------------------------------------------------------------------
// Deterministic rule-based negotiation. No LLM required.
// Used when NEGOTIATION_PROVIDER=mock (default) or when the agent service is
// unreachable. Behaviour is configured via constructor options so harness
// scenarios can force specific outcomes.

export interface MockNegotiationOptions {
  // Force a specific action regardless of input. When undefined, rules apply.
  forceAction?: NegotiationAction;
  // Counter until this round, then accept. Ignored when forceAction is set.
  counterUntilRound?: number;
}

function withinRange(rate: number, floor: NegotiationTerm, ceiling: NegotiationTerm): boolean {
  const lo = typeof floor["rate"] === "number" ? floor["rate"] : 0;
  const hi = typeof ceiling["rate"] === "number" ? ceiling["rate"] : Infinity;
  return rate >= lo && rate <= hi;
}

export class MockNegotiationProvider implements NegotiationProvider {
  private readonly forceAction: NegotiationAction | undefined;
  private readonly counterUntilRound: number;

  constructor(opts: MockNegotiationOptions = {}) {
    this.forceAction = opts.forceAction;
    this.counterUntilRound = opts.counterUntilRound ?? 1;
  }

  async negotiate(req: NegotiationRequest): Promise<NegotiationResponse> {
    const { round, maxRounds, campaignConstraints } = req;

    // Hard stop — never exceed maxRounds.
    if (round >= maxRounds) {
      return {
        action: "REJECT",
        reasoning: `Max rounds (${maxRounds}) reached — terminating negotiation`,
      };
    }

    if (this.forceAction !== undefined) {
      return this._buildResponse(this.forceAction, round, campaignConstraints.termFloor);
    }

    // Check if the creator's reply contains unreasonable terms (above ceiling).
    const ceilingRate = typeof campaignConstraints.termCeiling["rate"] === "number"
      ? campaignConstraints.termCeiling["rate"]
      : Infinity;

    const replyUpper = this._extractRate(req.creatorReply);
    if (replyUpper !== null && replyUpper > ceilingRate) {
      return {
        action: "ESCALATE",
        reasoning: `Creator demands $${replyUpper} which exceeds ceiling $${ceilingRate}`,
        proposedTerms: req.currentOffer,
      };
    }

    if (round < this.counterUntilRound) {
      return this._buildResponse("COUNTER", round, campaignConstraints.termFloor);
    }

    return this._buildResponse("ACCEPT", round, campaignConstraints.termFloor);
  }

  private _extractRate(text: string): number | null {
    const match = text.match(/\$\s*(\d[\d,]*)/);
    if (!match) return null;
    return parseInt(match[1]!.replace(/,/g, ""), 10);
  }

  private _buildResponse(
    action: NegotiationAction,
    round: number,
    currentOffer: NegotiationTerm,
  ): NegotiationResponse {
    switch (action) {
      case "ACCEPT":
        return {
          action: "ACCEPT",
          proposedTerms: currentOffer,
          responseDraft: `We're pleased to confirm the collaboration. Welcome aboard! Our team will follow up with the formal agreement.`,
          reasoning: "Terms are acceptable",
        };
      case "COUNTER":
        return {
          action: "COUNTER",
          proposedTerms: { ...currentOffer, rate: (currentOffer["rate"] as number ?? 1000) + 100 * (round + 1) },
          responseDraft: `Thank you for your interest! We'd like to propose a slightly adjusted rate for round ${round + 1}. Here's our counter-offer.`,
          reasoning: `Counter-offer round ${round + 1}`,
        };
      case "REJECT":
        return {
          action: "REJECT",
          reasoning: "Unable to reach mutually agreeable terms",
          responseDraft: `Thank you for considering the partnership. Unfortunately we're unable to reach mutually agreeable terms at this time. We hope to work together in the future.`,
        };
      case "ESCALATE":
        return {
          action: "ESCALATE",
          reasoning: "Terms require human review",
        };
      case "PRESENT_OFFER":
        return {
          action: "PRESENT_OFFER",
          proposedTerms: currentOffer,
          responseDraft: `Thanks for your interest! Here are the details of our offer.`,
          reasoning: "Presenting offer in response to a terms question",
        };
    }
  }

  async draft(req: DraftRequest): Promise<DraftResponse> {
    const name = req.creatorName;
    const platform = req.creatorPlatform ?? "social media";
    const niche = req.creatorNiche ?? "your niche";
    const sender = req.senderName ?? "Pluvus Partnerships";
    const ctx = (req.campaignContext ?? {}) as Record<string, unknown>;
    const brand = typeof ctx["brandName"] === "string" ? ctx["brandName"] : sender;
    const minBudget = typeof ctx["minBudget"] === "number" ? ctx["minBudget"] : null;
    const maxBudget = typeof ctx["maxBudget"] === "number" ? ctx["maxBudget"] : null;
    const commissionRate = typeof ctx["commissionRate"] === "number" ? ctx["commissionRate"] : null;
    // Brand-supplied deliverables (free text). Threaded through campaignContext /
    // top-level DraftRequest so the reward-confirmation email can state real scope.
    const deliverables =
      typeof req.deliverables === "string" && req.deliverables.trim()
        ? req.deliverables.trim()
        : typeof ctx["deliverables"] === "string" && (ctx["deliverables"] as string).trim()
          ? (ctx["deliverables"] as string).trim()
          : null;
    const timeline =
      typeof req.timeline === "string" && req.timeline.trim()
        ? req.timeline.trim()
        : typeof ctx["timeline"] === "string" && (ctx["timeline"] as string).trim()
          ? (ctx["timeline"] as string).trim()
          : null;
    // Product/sample reward blurb — same threading as deliverables/timeline.
    // Mentioned in the copy only when the campaign supplied one.
    const reward =
      typeof req.rewardDescription === "string" && req.rewardDescription.trim()
        ? req.rewardDescription.trim()
        : typeof ctx["rewardDescription"] === "string" && (ctx["rewardDescription"] as string).trim()
          ? (ctx["rewardDescription"] as string).trim()
          : null;

    const budgetRange = minBudget !== null && maxBudget !== null
      ? `$${minBudget}–$${maxBudget}`
      : maxBudget !== null ? `up to $${maxBudget}` : null;

    switch (req.purpose) {
      case "initial_outreach":
        return {
          subject: `${brand} partnership opportunity — ${name}`,
          body: [
            `Hi ${name},`,
            ``,
            `We've been following your ${platform} ${niche} content and love what you're building.`,
            ``,
            `${brand} is looking for creators like you for an upcoming campaign${budgetRange ? ` — we're offering ${budgetRange}${commissionRate ? ` + ${commissionRate}% commission` : ""}` : ""}.`,
            ...(reward ? [``, `We'd also love to send you ${reward} to feature.`] : []),
            ``,
            `Would you be open to a quick conversation about the details?`,
            ``,
            `Best,`,
            `${brand} Team`,
          ].join("\n"),
        };

      // PLU-110: a negotiation nudge reads like a plain follow-up in the mock.
      case "negotiation_follow_up":
      case "follow_up": {
        const n = req.round ?? 1;
        return {
          subject: `Following up — ${brand} partnership`,
          body: [
            `Hi ${name},`,
            ``,
            `Just following up on our ${brand} partnership offer${n > 1 ? ` (note #${n})` : ""}.`,
            ``,
            budgetRange ? `We have ${budgetRange} budgeted for the right creator in the ${niche} space — we think that's you.` : `We'd love to hear from you when you have a moment.`,
            ...(reward ? [``, `You'd also receive ${reward} as part of the collaboration.`] : []),
            ``,
            `Best,`,
            `${brand} Team`,
          ].join("\n"),
        };
      }

      case "counter_offer": {
        const round = req.round ?? 1;
        const proposedRate = req.proposedTerms?.["rate"];
        const offerAmount = proposedRate !== undefined
          ? `$${proposedRate}`
          : budgetRange ?? "a competitive fee";
        return {
          subject: `${brand} × ${name} — updated offer`,
          body: [
            `Hi ${name},`,
            ``,
            `Thanks for getting back to us! We've reviewed your request and here's our revised offer:`,
            ``,
            `• Fee: ${offerAmount}${commissionRate ? `\n• Commission: ${commissionRate}% on all sales driven by your content` : ""}${reward ? `\n• Reward: ${reward}` : ""}`,
            ``,
            `This is for a dedicated ${platform} post showcasing ${brand}. Our team handles the brief and creative direction — we just need your authentic voice.`,
            ``,
            round > 1 ? `We're keen to make this work and hope we can reach an agreement. Please let us know your thoughts.` : `Let us know if this works for you or if you'd like to discuss further.`,
            ``,
            `Best,`,
            `${brand} Team`,
          ].join("\n"),
        };
      }

      case "acceptance":
        return {
          subject: `You're in! ${brand} × ${name} partnership confirmed`,
          body: [
            `Hi ${name},`,
            ``,
            `Fantastic — we're thrilled to confirm your partnership with ${brand}!`,
            ``,
            [
              budgetRange ? `• Compensation: ${budgetRange}` : null,
              commissionRate ? `• Commission: ${commissionRate}% on sales` : null,
              reward ? `• Reward: ${reward}` : null,
              `• Platform: ${platform}`,
            ].filter(Boolean).join("\n"),
            ``,
            `Our team will reach out shortly with the campaign brief, content guidelines, and contract. Excited to work with you!`,
            ``,
            `Welcome to the ${brand} family,`,
            `${brand} Partnerships Team`,
          ].join("\n"),
        };

      case "onboarding": {
        // Sent only after the deal is closed at an agreed rate. Confirms that
        // specific rate and lays out next steps — and references ONLY the agreed
        // rate, never the budget range (mirrors the real onboarding email).
        const agreedRate = req.proposedTerms?.["rate"];
        const rateLine = agreedRate !== undefined ? `$${agreedRate}` : `the agreed rate`;
        return {
          subject: `Welcome aboard! Next steps for your ${brand} partnership`,
          body: [
            `Hi ${name},`,
            ``,
            `Congratulations — we're delighted to officially welcome you to the ${brand} partnership at a confirmed rate of ${rateLine}!`,
            ``,
            `Here's what happens next to get you started:`,
            `• Agreement: we'll send a short partnership agreement for you to review and sign.`,
            `• Deliverables & timeline: we'll finalize the content and posting schedule together so it fits your workflow.`,
            `• Payment: ${rateLine} will be processed per the agreement once your deliverables are approved.`,
            ...(reward ? [`• Reward: you'll receive ${reward}.`] : []),
            ``,
            `Reply to this email with any questions — we're here to help and excited to create something great together.`,
            ``,
            `Best,`,
            `${sender}`,
          ].join("\n"),
        };
      }

      case "reward_confirmation": {
        // Reward Setup — the "Campaign Agreement Confirmation" email. Delegates to
        // the shared renderer so the executor's template fallback and this provider
        // emit identical copy. References only the agreed rate, never the band.
        const agreedRate =
          typeof req.proposedTerms?.["rate"] === "number"
            ? (req.proposedTerms["rate"] as number)
            : undefined;
        return renderRewardConfirmationEmail({
          creatorName: name,
          brandName: brand,
          senderName: sender,
          fixedFee: agreedRate,
          commissionRate: commissionRate ?? undefined,
          deliverables: deliverables ?? undefined,
          timeline: timeline ?? undefined,
          rewardDescription: reward ?? undefined,
        });
      }
    }
  }
}
