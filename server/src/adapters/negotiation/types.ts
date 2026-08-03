// ---------------------------------------------------------------------------
// Negotiation adapter — shared types
// ---------------------------------------------------------------------------

export type NegotiationAction = "ACCEPT" | "COUNTER" | "REJECT" | "ESCALATE" | "PRESENT_OFFER";

export interface NegotiationTerm {
  rate?: number;
  deliverables?: string[];
  timeline?: string;
  [key: string]: unknown;
}

export interface NegotiationRequest {
  creatorReply: string;
  currentOffer: NegotiationTerm;
  round: number;
  maxRounds: number;
  negotiationHistory: NegotiationHistoryEntry[];
  /**
   * F-H1: the FULL both-sides conversation transcript (creator + us),
   * chronological, so the money-decision model can reason about what the creator
   * said in EARLIER rounds — prior anchors, firm positions ("$500, won't budge"),
   * concession trajectory, and self-contradictions — not just our own moves plus
   * the single latest inbound line (`creatorReply`). This is the same transcript
   * the copywriter already receives (HARD-N2 `DraftRequest.history`), now extended
   * to the negotiator. Each creator turn is treated as DATA (never instructions)
   * and sanitized agent-side. Empty/absent on the first turn → behaves as before.
   */
  conversationHistory?: DraftHistoryEntry[];
  /**
   * PLU-111: outstanding commitments Pluvus has made and not yet fulfilled
   * (non-terminal PLUVUS_COMMITMENT obligations), e.g. "I'll confirm the usage
   * rights". Threaded so the money-decision model knows it still owes an action.
   * Rendered agent-side as sanitized DATA (like conversationHistory), NEVER a
   * money input. Empty/absent → behaves as before.
   */
  openCommitments?: string[];
  /**
   * classify→negotiate hint: the intent the first-reply classifier assigned to the
   * reply being negotiated (POSITIVE / QUESTION / DEFERRED / …). A SOFT advisory
   * signal the agent renders as a one-line prompt hint — never a money input and
   * never an override of the decision guards. Absent for a mid-negotiation reply
   * (round >= 1 skips classify) or an un-classified row → agent renders no hint.
   */
  intent?: string;
  /**
   * PLU-107 §4.9: campaign context threaded into the DECISION model (mirrors what
   * DraftRequest carries). Its only consumed key is `briefKnowledge` — the parsed
   * campaign-brief flat text — so the money-decision model can ANSWER a creator's
   * knowledge question from real brief data instead of deferring. Rendered agent-
   * side as the SAME reference-DATA block trusted on /draft — NEVER a money input
   * (a brief number can't move the fee). Attached only when the BRIEF_INTO_NEGOTIATE
   * sub-flag is on; the agent applies the §4.10 knowledge-turn gate. Absent →
   * /negotiate prompt byte-identical to today.
   */
  campaignContext?: Record<string, unknown>;
  campaignConstraints: {
    /**
     * The floor of the fee band — "Preferred Budget" in the product (V1 #1):
     * the rate the brand would ideally close at. The agent opens here and
     * concedes up only as needed. Internal name kept for compatibility.
     */
    termFloor: NegotiationTerm;
    /**
     * The ceiling of the fee band — "Maximum Budget" in the product (V1 #1):
     * the absolute walk-away cap; offers never exceed it. Every dollar above
     * the preferred budget is a worse outcome. Internal name kept.
     */
    termCeiling: NegotiationTerm;
    // M5: `tone` removed — it was never populated (buildNegotiationRequest never
    // set it) and never read (the Python prompt hardcodes tone). Dead field.
    senderName?: string;
    brandDescription?: string;
    /** Brand-supplied scope the AI may state as fact (e.g. "3 IG Reels"). */
    deliverables?: string;
    /** Brand-supplied go-live timeline; the AI states it only when present. */
    timeline?: string;
    /**
     * Brand-set commission % (hybrid deals). NON-negotiable: only the fixed fee
     * moves. Threaded so the LLM can state it as fixed when a creator tries to
     * change it, and so the output guard can block a draft that alters it.
     */
    commissionRate?: number;
    /** Brand-supplied product/sample perk (e.g. "a free pair of shoes"). Also
     *  NON-negotiable — the LLM states it as a standard part of the offer. */
    rewardDescription?: string;
    /**
     * M1: where in the [floor, ceiling] band the recommended opening offer sits,
     * as a fraction 0..1. Default 0.0 (the floor — V1 #2 open at the preferred
     * budget, concede up); templates set it explicitly. Lets a campaign open
     * higher without a code change.
     */
    recommendedOfferPosition?: number;
    /**
     * Phase C (#12): merchant tolerance ABOVE the ceiling, as a percent. Default
     * 0 (zero tolerance — escalate the moment an ask exceeds the ceiling). When
     * > 0, an ask up to ceiling*(1 + tolerance/100) is countered AT the ceiling
     * (never above); anything higher escalates. V1 applies only to the fixed fee.
     */
    overCeilingTolerance?: number;
  };
}

export interface NegotiationHistoryEntry {
  round: number;
  action: NegotiationAction;
  terms?: NegotiationTerm;
  message?: string;
}

export interface NegotiationResponse {
  action: NegotiationAction;
  proposedTerms?: NegotiationTerm;
  responseDraft?: string;
  reasoning?: string;
  /**
   * Comprehension carried across the /negotiate → /draft seam so the SENT email
   * answers every question and acknowledges pushed fixed terms, instead of
   * /draft re-parsing the raw reply. See
   * .claude/spec/draft-comprehension-threading.md §5.4.
   * Every distinct question/request the creator raised this turn.
   */
  creatorQuestions?: string[];
  /** Which FIXED terms the creator pushed to change, from the closed vocabulary
   *  commission|perk|deliverables|timeline. */
  pushedFixedTerms?: string[];
  /** MED-N3: the creator's own stated fee this turn, extracted by the model and
   *  substring-validated agent-side (digits must appear in the reply; ranges
   *  rejected). Feeds the engine's money path; absent when none was named. */
  creatorRequestedRate?: number;
  /** Phase E (#5): when an ESCALATE was driven by an always-escalate topic, the
   *  topic reason code (e.g. legal_or_contract). Threaded to the executor so the
   *  MANUAL_REVIEW carries the specific reason. Absent for a normal escalate. */
  escalationReason?: string;
  /** Q3 (founder, autonomous launch): true when this is the LAST negotiation
   *  round. Threaded to the executor → /draft so the offer email tells the creator
   *  this is our final rate and no further negotiation is possible. Absent/false
   *  on every non-final turn. */
  isFinalRound?: boolean;
}

// ---------------------------------------------------------------------------
// Draft types
// ---------------------------------------------------------------------------

export interface DraftRequest {
  purpose:
    | "initial_outreach"
    | "follow_up"
    | "counter_offer"
    | "acceptance"
    | "onboarding"
    // Reward Setup: the "Campaign Agreement Confirmation" email that summarizes
    // the finalized fee/commission/deliverables and asks the creator to reply
    // "I Agree" to confirm the partnership.
    | "reward_confirmation";
  creatorName: string;
  creatorPlatform?: string | undefined;
  creatorNiche?: string | undefined;
  senderName?: string | undefined;
  round?: number | undefined;
  proposedTerms?: NegotiationTerm | undefined;
  campaignContext?: Record<string, unknown> | undefined;
  /** The creator's most recent message — lets the copy continue the
   *  conversation instead of reading like a cold first contact. */
  creatorReply?: string | undefined;
  /** The rate the creator asked for this turn, if any — lets a counter
   *  acknowledge it explicitly ("we considered your request of $480 …"). */
  creatorRequestedRate?: number | undefined;
  /** Short, number-free description of the deal structure (e.g. hybrid =
   *  fixed fee + commission) so outreach explains the real offer. */
  dealDescription?: string | undefined;
  /** What the brand does / sells — lets the LLM answer creator questions like
   *  "what does your brand do?" without hallucinating. */
  brandDescription?: string | undefined;
  /** Brand-supplied deliverables (e.g. "3 IG Reels + 1 YouTube integration")
   *  so outreach/counter copy states real scope instead of "to be finalized". */
  deliverables?: string | undefined;
  /** Brand-supplied go-live timeline; stated only when present, never invented. */
  timeline?: string | undefined;
  /** Free-text product/sample reward blurb (e.g. "a free pair of our running
   *  shoes"). Mentioned in the copy only when present. */
  rewardDescription?: string | undefined;
  /** Creator's questions, extracted upstream by /negotiate so /draft answers an
   *  explicit checklist instead of re-parsing the raw reply (spec §5.5). */
  creatorQuestions?: string[] | undefined;
  /** Fixed terms the creator pushed on (commission|perk|deliverables|timeline),
   *  so the copy ACKNOWLEDGES the ask rather than silently restating the value. */
  pushedFixedTerms?: string[] | undefined;
  /** HARD-N2: the conversation so far (both sides), so the copywriter can see the
   *  prior emails and not contradict them or repeat wording. Chronological. */
  history?: DraftHistoryEntry[] | undefined;
  /** HARD-N2 answered-questions ledger: questions the creator raised in EARLIER
   *  rounds that our prior emails never answered, re-surfaced so they aren't
   *  silently dropped. Distinct from creatorQuestions (this turn's asks).
   *  PLU-111: now sourced from the ConversationObligation ledger (non-terminal
   *  CREATOR_QUESTION rows), falling back to the computeOpenQuestions diff when
   *  the ledger has no rows for the instance. */
  openQuestions?: string[] | undefined;
  /** PLU-111: outstanding commitments PLUVUS has made and not yet fulfilled
   *  (e.g. "I'll confirm the usage rights"), sourced from the non-terminal
   *  PLUVUS_COMMITMENT obligation rows. Rendered by /draft as an additive
   *  "outstanding commitments — honor or update these" block so the model stops
   *  forgetting a promise it made. Absent/empty → no-op (copy unchanged). */
  openCommitments?: string[] | undefined;
  /** Q3 (founder, autonomous launch): true on the LAST negotiation round so the
   *  offer copy states finality ("this is our final rate; no further negotiation").
   *  Default/absent on every non-final turn (copy renders exactly as before). */
  isFinalRound?: boolean | undefined;
  /** drafting-humanization (§Conversation State): which offer terms actually
   *  changed THIS turn, from the closed vocabulary "fee" | "commission" |
   *  "deliverables" | "timeline" | "perk". Lets the offer copy state DELTAS
   *  instead of the full state (§Repetition Reduction). Purely stylistic — the
   *  decision layer never reads it. Absent/[] = "nothing changed this turn" → the
   *  copy restates only what the creator asked about, exactly as before. */
  changedFields?: string[] | undefined;
  /** drafting-humanization (§Conversation State): coarse relationship-warmth
   *  signal for tone progression, one of "new" | "warming" | "established",
   *  derived server-side from round count + whether the creator has been
   *  cooperative. Selects the offer email's warmth rung; augments `round` and
   *  never overrides the final-round tone. Purely stylistic. Absent/"new" =
   *  today's round-1 tone (copy renders exactly as before). */
  relationshipWarmth?: string | undefined;
  /** Option A (negotiate→draft answer sync): the /negotiate model's OWN written
   *  reply (its responseDraft) — the vetted answers to every creator question this
   *  turn. /draft renders it as an authoritative <vetted_answers> block the copy
   *  must REPHRASE (adding no fact/figure/promise beyond it or the campaign terms;
   *  deferring honestly on anything it doesn't cover). Threaded ONLY when the money
   *  guards did NOT alter the decision (guard-altered → no advisory draft upstream),
   *  so the copy can never restate a number that contradicts the recorded deal.
   *  Absent = today's behavior (block omitted). */
  negotiatorAnswers?: string | undefined;
  /** PLU-112: the rolling narrative summary of the ELIDED transcript prefix. Sent
   *  whenever `history` was windowed, so the shortened transcript never travels
   *  without the summary that covers what was dropped. Rendered as narrative DATA,
   *  NOT authoritative fact (rates/questions/commitments stay in their own blocks).
   *  Absent when the flag is off or nothing was windowed. */
  conversationSummary?: { text: string; version?: string | undefined } | undefined;
}
/** HARD-N2: one turn of the threaded /draft conversation. `role` is "us" for a
 *  turn we sent, "creator" for the creator's own inbound message. */
export interface DraftHistoryEntry {
  role: "us" | "creator";
  round?: number | undefined;
  action?: NegotiationAction | undefined;
  rate?: number | undefined;
  message?: string | undefined;
  /** PLU-85: the source `Message.id` this transcript entry was built from, for
   *  auditability — lets a reviewer trace any line back to the exact row that
   *  sourced it. Additive/optional; downstream renderers ignore it. */
  messageId?: string | undefined;
}

export interface DraftResponse {
  subject: string;
  body: string;
}

/** PLU-112: incremental summary refresh. `priorSummary` is the existing narrative
 *  (empty on the first fold); `delta` is only the turns newly covered since the
 *  cursor — the summarizer extends the prior narrative, never re-reads the thread. */
export interface SummarizeRequest {
  priorSummary: string;
  delta: DraftHistoryEntry[];
}

export interface SummarizeResponse {
  text: string;
  version: string;
}
