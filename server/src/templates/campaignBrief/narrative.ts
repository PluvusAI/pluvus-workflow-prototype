// PLU-139 §3: optional AI-assisted intro/summary prose for a rendered
// CampaignBrief. Two providers behind one shape — a deterministic default
// that always works, and a network call to a narrow agent-service endpoint
// that may fail or be rejected. The caller (renderCampaignBrief(), §6/§9)
// always has a NarrativeSlots to interpolate either way; nothing about
// generation ever blocks on this.
import { agentBaseUrl, agentPostJson } from "../../adapters/agentServiceClient.js";
import { recordAgentLlmUsage } from "../../observability/llmUsage.js";
import type { CampaignBriefInput, CompensationProjection } from "../../db/campaignBriefRender.js";

export interface NarrativeSlots {
  introduction: string;
  summary: string;
}

const CAMPAIGN_TYPE_LABELS: Record<CompensationProjection["kind"], string> = {
  GIFT_ONLY: "a gifted product collaboration",
  AFFILIATE: "an affiliate partnership",
  PAID: "a paid partnership",
  HYBRID: "a paid partnership with an affiliate commission",
};

/**
 * Template-string composition from input fields only — always available,
 * zero dependencies, zero network calls. The fallback for aiNarrative()
 * failure/rejection, and the only path when AI narrative is disabled.
 */
export function defaultNarrative(input: CampaignBriefInput): NarrativeSlots {
  const typeLabel = CAMPAIGN_TYPE_LABELS[input.compensation.kind];
  const introduction = input.objective
    ? `${input.brand} is inviting you to collaborate on ${input.campaignName} — ${typeLabel}. ${input.objective}`
    : `${input.brand} is inviting you to collaborate on ${input.campaignName} — ${typeLabel}.`;
  const summary = `${input.campaignName}: ${typeLabel} with ${input.brand}.`;
  return { introduction, summary };
}

// Same blunt, conservative filter as the agent-service route's own guard
// (agent/app/routes/brief_narrative.py's _MONEY_RE/_OBLIGATION_RE) — kept
// here too as an independent second check on whatever crosses the HTTP
// seam, rather than trusting the remote service's guard alone for content
// that ends up in a brand-facing document. Deliberately not an attempt at
// semantic validation; matches the ticket's own framing ("omit... when it
// cannot be validated safely").
const MONEY_RE = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)/;
const OBLIGATION_RE = /\b(guarantee[sd]?|promise[sd]?|will pay|must|shall|commit(?:s|ted)?)\b/i;

function looksUnsafe(text: string): boolean {
  return MONEY_RE.test(text) || OBLIGATION_RE.test(text);
}

interface BriefNarrativeAgentResponse {
  ok?: unknown;
  introduction?: unknown;
  summary?: unknown;
}

/**
 * Calls the narrow agent-service endpoint (POST /brief-narrative) with an
 * explicitly scoped request — tone/framing fields only, never a number, a
 * date, or an obligation. Returns null on ANY failure: timeout, non-2xx,
 * breaker-open, malformed response body, or a response that fails the
 * client-side safety check above. The caller falls back to
 * defaultNarrative() in every one of those cases — never blocks the render.
 */
export async function aiNarrative(input: CampaignBriefInput): Promise<NarrativeSlots | null> {
  try {
    const data = (await agentPostJson(agentBaseUrl(), "/brief-narrative", {
      campaignName: input.campaignName,
      brand: input.brand,
      campaignTypeLabel: CAMPAIGN_TYPE_LABELS[input.compensation.kind],
      objective: input.objective,
      productOrOffer: input.productOrOffer,
      keyMessages: input.keyMessages,
    })) as BriefNarrativeAgentResponse;

    recordAgentLlmUsage("brief_narrative", data as Record<string, unknown>);

    if (data.ok !== true || typeof data.introduction !== "string" || typeof data.summary !== "string") {
      return null;
    }
    if (looksUnsafe(data.introduction) || looksUnsafe(data.summary)) {
      return null;
    }
    return { introduction: data.introduction, summary: data.summary };
  } catch {
    return null;
  }
}
