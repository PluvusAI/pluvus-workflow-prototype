import type {
  NegotiationRequest,
  NegotiationResponse,
  DraftRequest,
  DraftResponse,
  SummarizeRequest,
  SummarizeResponse,
} from "./types.js";

export interface NegotiationProvider {
  negotiate(req: NegotiationRequest): Promise<NegotiationResponse>;
  draft(req: DraftRequest): Promise<DraftResponse>;
  // PLU-112: optional — only the LangGraph provider summarizes. Absent on mocks.
  summarize?(req: SummarizeRequest): Promise<SummarizeResponse>;
}
