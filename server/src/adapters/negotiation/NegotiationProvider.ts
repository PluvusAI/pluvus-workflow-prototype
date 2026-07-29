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
  /** PLU-112: generate/refresh the rolling summary. OPTIONAL — the mock omits it, so
   *  the caller feature-detects and no-ops when absent (dark path). */
  summarize?(req: SummarizeRequest): Promise<SummarizeResponse>;
}
