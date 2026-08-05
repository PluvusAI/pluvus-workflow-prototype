import type { NegotiationProvider } from "./NegotiationProvider.js";
import type {
  NegotiationRequest,
  NegotiationResponse,
  NegotiationAction,
  DraftRequest,
  DraftResponse,
  SummarizeRequest,
  SummarizeResponse,
} from "./types.js";
import { agentBaseUrl, agentPostJson } from "../agentServiceClient.js";
import { recordAgentLlmUsage } from "../../observability/llmUsage.js";

// ---------------------------------------------------------------------------
// LangGraph negotiation provider
// ---------------------------------------------------------------------------
// Calls POST /negotiate and POST /draft on the Python agent service.
// Throws on any failure — no silent mock fallback in prod.
//
// Base URL, auth header (FIX-12), and timeout are handled by agentPostJson.

const VALID_ACTIONS = new Set<NegotiationAction>(["ACCEPT", "COUNTER", "REJECT", "ESCALATE", "PRESENT_OFFER"]);

function isValidAction(v: unknown): v is NegotiationAction {
  return typeof v === "string" && VALID_ACTIONS.has(v as NegotiationAction);
}

export class LangGraphNegotiationProvider implements NegotiationProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = agentBaseUrl(baseUrl);
  }

  async negotiate(req: NegotiationRequest): Promise<NegotiationResponse> {
    const data = await agentPostJson(this.baseUrl, "/negotiate", req);

    // HARD-O1: persist the token/latency/cost telemetry this response carries
    // (fire-and-forget; attributed to the instance via the runtime's ALS scope).
    // Before the malformed-response check on purpose — a rejected response still
    // consumed tokens.
    recordAgentLlmUsage("negotiate", data);

    if (!isValidAction(data["action"])) {
      throw new Error(
        `[LangGraphNegotiationProvider] malformed negotiate response: ${JSON.stringify(data)}`,
      );
    }

    const response: NegotiationResponse = { action: data["action"] };
    if (data["proposedTerms"] && typeof data["proposedTerms"] === "object") {
      const terms = data["proposedTerms"] as NonNullable<NegotiationResponse["proposedTerms"]>;
      // H7: `rate` is a money value crossing an HTTP seam — validate it is a
      // FINITE number before it can reach the executor's money path. A string
      // ("480"), NaN, or Infinity from a misbehaving agent would otherwise pass
      // through untyped (`as`-cast) and downstream `typeof rate === "number"`
      // checks in mapNegotiationResponse treat NaN/Infinity as valid numbers.
      // Drop a non-finite/non-number rate so the turn is treated as "no rate
      // proposed" rather than acting on garbage. Non-rate fields are preserved.
      if ("rate" in terms && !(typeof terms.rate === "number" && Number.isFinite(terms.rate))) {
        const { rate: _dropped, ...rest } = terms;
        response.proposedTerms = rest;
      } else {
        response.proposedTerms = terms;
      }
    }
    if (typeof data["responseDraft"] === "string") {
      response.responseDraft = data["responseDraft"];
    }
    if (typeof data["reasoning"] === "string") {
      response.reasoning = data["reasoning"];
    }
    // Carry the comprehension fields across the seam (spec §5.4). This adapter
    // reconstructs the response field-by-field from the raw HTTP JSON, so these
    // MUST be copied explicitly or they are silently dropped before the executor
    // ever sees them. Keep only clean string arrays; anything else → omitted.
    const asStringArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    const creatorQuestions = asStringArray(data["creatorQuestions"]);
    if (creatorQuestions) {
      response.creatorQuestions = creatorQuestions;
    }
    const pushedFixedTerms = asStringArray(data["pushedFixedTerms"]);
    if (pushedFixedTerms) {
      response.pushedFixedTerms = pushedFixedTerms;
    }
    // MED-N3: the creator's own validated ask — copied explicitly (this adapter
    // reconstructs the response field-by-field, so an uncopied field is silently
    // dropped before the executor's money path ever sees it).
    if (typeof data["creatorRequestedRate"] === "number" && Number.isFinite(data["creatorRequestedRate"])) {
      response.creatorRequestedRate = data["creatorRequestedRate"];
    }
    // Phase E (#5): carry the always-escalate topic reason across the seam (this
    // adapter reconstructs the response field-by-field, so an uncopied field is
    // silently dropped before the executor's escalate path ever sees it).
    if (typeof data["escalationReason"] === "string" && data["escalationReason"]) {
      response.escalationReason = data["escalationReason"];
    }
    // Q3 (founder, autonomous launch): carry the final-round flag across the seam.
    // Same field-by-field caveat — uncopied means the offer email never learns it
    // is the last round and can't state finality to the creator.
    if (data["isFinalRound"] === true) {
      response.isFinalRound = true;
    }
    return response;
  }

  async draft(req: DraftRequest): Promise<DraftResponse> {
    const data = await agentPostJson(this.baseUrl, "/draft", req);

    // HARD-O1: persist this response's LLM telemetry (see negotiate above).
    recordAgentLlmUsage("draft", data);

    if (typeof data["subject"] !== "string" || typeof data["body"] !== "string") {
      throw new Error(
        `[LangGraphNegotiationProvider] malformed draft response: ${JSON.stringify(data)}`,
      );
    }

    return { subject: data["subject"], body: data["body"] };
  }

  async summarize(req: SummarizeRequest): Promise<SummarizeResponse> {
    const data = await agentPostJson(this.baseUrl, "/summarize", req);
    recordAgentLlmUsage("summarize", data);
    if (typeof data["text"] !== "string" || typeof data["version"] !== "string") {
      throw new Error(
        `[LangGraphNegotiationProvider] malformed summarize response: ${JSON.stringify(data)}`,
      );
    }
    return { text: data["text"], version: data["version"] };
  }
}
