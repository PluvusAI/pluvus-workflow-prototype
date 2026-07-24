import type { Creator, ReplyIntent } from "../db/schema.js";
import type {
  EmailDraft,
  ClassifyResult,
  NegotiateResult,
  NegotiateOutcome,
  PriorNegotiationContext,
} from "./types.js";
import { MockNegotiationProvider } from "../adapters/negotiation/MockNegotiationProvider.js";
import type { NegotiationTerm, NegotiationHistoryEntry, DraftHistoryEntry } from "../adapters/negotiation/types.js";
import { resolveBand } from "./band.js";
import { resolveOutreachTemplate } from "./outreachVariables.js";

// ---------------------------------------------------------------------------
// IEmailProvider
// ---------------------------------------------------------------------------

// An explicit outbound recipient, used when the message goes to someone OTHER
// than the creator whose thread we're on — specifically the BRAND on an
// escalation email (CRITICAL-2). Previously brand outbound forged a Creator with
// the email swapped ("brandAsCreator"), which meant no clean seam to persist a
// Message row or set a decision-scoped reply-to. Passing this instead lets the
// provider address the brand AND lets the caller persist the outbound row so the
// brand's reply can correlate back by threadId.
export interface EmailRecipient {
  email: string;
  name: string;
  /** Optional Reply-To. When set, the message is sent with an explicit Reply-To
   *  header so a reply is directed to a specific address rather than the sender. */
  replyTo?: string;
  /**
   * Optional CC addresses (PLU-70). Used by the operator-handoff message so the
   * campaign's escalation contact is a real participant in the creator thread
   * from the handoff onward — a creator "reply all" then reaches the operator's
   * inbox AND our mailbox, so the recorded history stays complete.
   *
   * Set on NO other send. Absent → the provider omits the header entirely and
   * the request body is byte-for-byte what it was before.
   */
  cc?: string[];
}

// Transport-neutral threading options for a send (Email Threading — ADR-2).
// Deliberately provider-agnostic: it carries no Nylas concepts. Each provider
// maps it to its own mechanism (Nylas: the send reply field; Gmail: threadId +
// In-Reply-To; Graph: /reply; SES: raw In-Reply-To/References). Optional and
// last on `send()`, so every existing caller compiles and behaves unchanged.
export interface EmailSendOptions {
  /** External id (in the sending provider's namespace) of the message this send
   *  replies to. The provider attaches the send to that message's thread. This
   *  is the value we persist as `Message.externalMessageId` — hence "external
   *  id", this codebase's own term, rather than any provider's field name. */
  replyToExternalId?: string;
}

export interface IEmailProvider {
  draft(
    creator: Creator,
    template: string,
    config: Record<string, unknown>,
  ): Promise<EmailDraft>;
  /**
   * Send an email. By default it is addressed to `creator` (the thread owner).
   * When `recipient` is supplied the message is addressed there instead — the
   * brand-outbound path (escalation / brand-decision) uses this so the brand,
   * not the creator, receives the email while the returned threadId still lets
   * the reply correlate back to the instance.
   *
   * `options` (optional, last) carries transport-neutral threading intent
   * (`replyToExternalId`). When present, the provider attaches the send to the
   * referenced message's thread; when absent it opens a new thread exactly as
   * before. Backward-compatible by construction (ADR-2).
   */
  send(
    draft: EmailDraft,
    creator: Creator,
    recipient?: EmailRecipient,
    options?: EmailSendOptions,
  ): Promise<{ messageId: string; threadId: string }>;

  /**
   * Build a human-facing deep-link to the provider's hosted view of a thread, for
   * the escalation hand-off (Email Threading — E6). Given a stored `threadId`,
   * return a URL the operator can open to see the whole conversation in one place,
   * or `undefined` when this provider cannot build one (e.g. the mock, or a real
   * provider that isn't configured with a base URL).
   *
   * The URL shape is provider-specific (like the reply field, E4), so each
   * provider supplies its own; callers stay provider-agnostic and simply omit the
   * link when this returns `undefined` (graceful degradation — never a broken
   * link). Optional so existing providers/tests need no change, and pure — it
   * performs no I/O.
   */
  threadUrl?(threadId: string): string | undefined;

  /**
   * Resolve the RFC822 `Message-ID` header of a stored provider message, given its
   * provider message id (what we persist as `Message.externalMessageId`). Used to
   * build the escalation Gmail deep-link: Gmail's only cold-load-safe web URL is a
   * `#search/rfc822msgid:<id>` search, which keys off this header — NOT the hex
   * thread id (that `#all/<id>` alias only resolves when Gmail is already warm).
   *
   * Provider-specific and does real I/O (a message fetch), so it is async and
   * best-effort: returns `undefined` when the provider can't supply it (the mock,
   * an unconfigured provider, or a fetch failure) and callers omit the link
   * gracefully. Optional so existing providers/tests need no change.
   */
  rfc822MessageId?(externalMessageId: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// IThreadLabeler — optional label capability (Gmail Campaign Labels — §6.1)
// ---------------------------------------------------------------------------
// A transport-neutral seam for applying a human label to a conversation thread,
// mirroring how EmailSendOptions was added for threading (optional + feature-
// detected, so every existing caller/provider compiles and behaves unchanged).
//
// Providers that CAN label a thread implement this; callers feature-detect with
// the isThreadLabeler type guard. MockEmailProvider deliberately does NOT
// implement it, so the whole feature is a no-op under EMAIL_PROVIDER=mock and in
// every unit test that uses the mock — labeling only ever fires against a real
// Gmail grant. No Gmail/Nylas concept appears here: the engine only knows there
// is an optional "apply this string label to this threadId" capability.
export interface IThreadLabeler {
  /**
   * Ensure `label` exists (find-or-create) and apply it to the thread the given
   * provider threadId belongs to. Best-effort by contract: implementations MUST
   * NOT throw into the caller — a labeling failure never blocks or fails a send.
   */
  applyThreadLabel(threadId: string, label: string): Promise<void>;
}

/**
 * Type guard: true when a provider also implements IThreadLabeler. Lets the send
 * path apply a label only when the active provider supports it (NylasEmailProvider)
 * and skip it silently otherwise (MockEmailProvider, or any provider without
 * label support), so labeling is a pure no-op wherever it isn't available.
 */
export function isThreadLabeler(
  p: IEmailProvider,
): p is IEmailProvider & IThreadLabeler {
  return typeof (p as Partial<IThreadLabeler>).applyThreadLabel === "function";
}

// ---------------------------------------------------------------------------
// MockEmailProvider
// ---------------------------------------------------------------------------

export class MockEmailProvider implements IEmailProvider {
  async draft(
    creator: Creator,
    template: string,
    config: Record<string, unknown>,
  ): Promise<EmailDraft> {
    // senderName / platform are used by the generic fallback body below when no
    // template is supplied. All {{variable}} substitution in a supplied template
    // is done by resolveOutreachTemplate (the shared allow-list), not here. The
    // sender is the campaign brand (brandName or senderName) — NEVER the internal
    // "Pluvus Partnerships" name, which must not appear in a brand's outreach.
    const senderName =
      (typeof config["senderName"] === "string" && config["senderName"]) ||
      (typeof config["brandName"] === "string" && config["brandName"]) ||
      "our team";
    const platform =
      typeof creator.platform === "string" ? creator.platform : "social media";

    const subjectTemplate =
      typeof config["subjectTemplate"] === "string" ? config["subjectTemplate"] : "";

    // Variable substitution goes through the shared allow-list resolver
    // (outreachVariables.ts) so the renderer, graph validation, and the builder
    // palette can never disagree on which {{tokens}} exist. It resolves every
    // allow-listed variable and STRIPS any unknown token to "" — the send-time
    // net that keeps literal {{braces}} out of a creator's inbox even if a typo
    // slipped past publish validation.
    const resolve = (s: string) => resolveOutreachTemplate(s, creator, config);

    // Use node config template when provided; fall back to generic body.
    const body = template.trim()
      ? resolve(template)
      : [
          `Hi ${creator.name},`,
          ``,
          `We've been following your ${platform} content and think you'd be a perfect fit for our upcoming campaign.`,
          ``,
          `${senderName} works with top creators in your space, and we believe this partnership could be mutually beneficial.`,
          ``,
          `Would you be open to a quick conversation about the details?`,
          ``,
          `Best,`,
          `${senderName}`,
        ].join("\n");

    const subject = subjectTemplate.trim()
      ? resolve(subjectTemplate)
      : `Collaboration opportunity — ${creator.name}`;

    return { subject, body };
  }

  async send(
    _draft: EmailDraft,
    creator: Creator,
    recipient?: EmailRecipient,
    // Accepted for interface parity and ignored: the mock returns synthetic ids
    // and does not model real threads (ADR-3). No behaviour change vs. today.
    _options?: EmailSendOptions,
  ): Promise<{ messageId: string; threadId: string }> {
    // When addressed to a brand (recipient set), key the thread on the recipient
    // email so a simulated brand reply on that address correlates to a distinct
    // thread — mirroring how a real provider threads by recipient.
    const threadKey = recipient?.email ?? creator.id;
    // PLU-70: surface the CC in mock mode so a dev running EMAIL_PROVIDER=mock
    // can actually SEE that the operator was looped in, rather than having to
    // trust it. Logged only when set, so every other send's output is unchanged.
    if (recipient?.cc?.length) {
      console.log(
        `[email:mock] cc ${recipient.cc.join(", ")} on message to ${recipient.email}`,
      );
    }
    return {
      messageId: `mock-msg-${creator.id}-${Date.now()}`,
      threadId: `mock-thread-${threadKey}`,
    };
  }

  // E6: the mock models no real inbox, so it has no thread to deep-link to.
  // Returning undefined makes every caller omit the link gracefully (the
  // escalation email / Manual Queue row simply carry no thread link in mock mode).
  threadUrl(_threadId: string): string | undefined {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// IAgentProvider
// ---------------------------------------------------------------------------

export interface IAgentProvider {
  /**
   * True when this provider actually GENERATES email copy via an LLM (the real
   * LangGraph adapter). When true, a null from draftEmail() means "generation
   * failed after retries" — offer/counter turns escalate to a human rather than
   * send lower-quality fallback copy. When false/absent (the mock), null just
   * means "no AI copy — use the template" and executors fall back as before, so
   * mock-mode dev and seeded harnesses keep working unchanged.
   */
  readonly generatesDraftCopy?: boolean;
  classify(body: string, intent?: string): Promise<ClassifyResult>;
  negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply?: string,
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult>;
  /**
   * Generate email copy via the draft agent.
   * Phase 8: executors call this instead of the raw template when
   * NEGOTIATION_PROVIDER=langgraph (or mock with richer copy).
   * Returns null to signal "use the template fallback" (so old harnesses work).
   */
  draftEmail(
    purpose:
      | "initial_outreach"
      | "follow_up"
      | "counter_offer"
      | "acceptance"
      | "onboarding"
      | "reward_confirmation",
    creator: Creator,
    config: Record<string, unknown>,
    extra?: {
      round?: number;
      proposedTerms?: NegotiationTerm;
      creatorReply?: string;
      creatorRequestedRate?: number;
      dealDescription?: string;
      // Comprehension threaded from /negotiate so the SENT email answers an
      // explicit checklist and acknowledges pushed fixed terms (spec §6.2).
      creatorQuestions?: string[];
      pushedFixedTerms?: string[];
      // HARD-N2: the conversation so far (both sides) + the answered-questions
      // ledger, so the copy stays consistent across rounds and re-surfaces an
      // earlier unanswered question rather than dropping it.
      history?: DraftHistoryEntry[];
      openQuestions?: string[];
      // PLU-111: outstanding Pluvus commitments (non-terminal PLUVUS_COMMITMENT
      // obligations) so the copy honors or updates a promise we made earlier
      // (e.g. "I'll confirm the usage rights"). Additive — empty → copy unchanged.
      openCommitments?: string[];
      // Q3 (founder, autonomous launch): true on the LAST negotiation round so
      // the offer email states finality to the creator.
      isFinalRound?: boolean;
      // drafting-humanization (§Conversation State): style hints so the offer copy
      // states deltas (not full state) and warms up across the thread. Both purely
      // stylistic; absent = today's behavior.
      changedFields?: string[];
      relationshipWarmth?: string;
      // Option A (negotiate→draft answer sync): the /negotiate model's OWN written
      // reply for this turn (its responseDraft) — the vetted answers to every
      // creator question. The copy model rephrases THESE instead of re-deriving
      // answers from raw facts (which is where the cheaper copy model invents perk/
      // term details the campaign never specified). Threaded ONLY when the money
      // guards did NOT alter the decision (a guard-altered decision has no advisory
      // draft, so the copy can never restate a number that contradicts the recorded
      // deal). Absent = today's behavior exactly.
      negotiatorAnswers?: string;
    },
  ): Promise<EmailDraft | null>;
}

// ---------------------------------------------------------------------------
// MockAgentOptions
// ---------------------------------------------------------------------------

export interface MockAgentOptions {
  replyIntent?: ReplyIntent;
  negotiationOutcome?: NegotiateOutcome;
  negotiationCounterUntilRound?: number;
}

// ---------------------------------------------------------------------------
// MockAgentProvider
// ---------------------------------------------------------------------------

export class MockAgentProvider implements IAgentProvider {
  // The mock does NOT generate LLM copy: draftEmail() returns null to mean "no AI
  // copy — use the template", so the negotiation executor keeps its template
  // fallback (rather than escalating) on this path.
  readonly generatesDraftCopy = false;
  private readonly replyIntent: ReplyIntent;
  private readonly negotiationOutcome: NegotiateOutcome;
  private readonly negotiationCounterUntilRound: number;
  private readonly _negotiationProvider: MockNegotiationProvider;

  constructor(opts: MockAgentOptions = {}) {
    this.replyIntent = opts.replyIntent ?? "POSITIVE";
    this.negotiationOutcome = opts.negotiationOutcome ?? "accept";
    this.negotiationCounterUntilRound = opts.negotiationCounterUntilRound ?? 0;
    this._negotiationProvider = new MockNegotiationProvider({
      counterUntilRound: this.negotiationCounterUntilRound,
    });
  }

  async classify(_body: string, _intent?: string): Promise<ClassifyResult> {
    return {
      intent: this.replyIntent,
      confidence: 0.95,
    };
  }

  async negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply = "",
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult> {
    const resp = await this._negotiationProvider.negotiate(
      buildNegotiationRequest(round, config, creatorReply, priorContext),
    );
    return mapNegotiationResponse(resp, round);
  }

  async draftEmail(
    _purpose:
      | "initial_outreach"
      | "follow_up"
      | "counter_offer"
      | "acceptance"
      | "onboarding"
      | "reward_confirmation",
    _creator: Creator,
    _config: Record<string, unknown>,
  ): Promise<EmailDraft | null> {
    // Mock returns null — executors fall back to IEmailProvider.draft() template.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared negotiation request/response mapping
// ---------------------------------------------------------------------------
// Both the mock bridge above and the AgentProviderAdapter (providerFactory.ts)
// translate the engine's (round, config, creatorReply, priorContext) call into a
// NegotiationRequest and map the NegotiationResponse back to a NegotiateResult.
// Centralising it here keeps history threading (FIX-1) and current-offer
// tracking (FIX-2) wired identically on both paths.

/**
 * Build a NegotiationRequest from the engine call.
 * `priorContext` is assembled by the executor (the state authority): its
 * `history` becomes `negotiationHistory` and its `currentOffer` becomes the
 * `currentOffer.rate`. When absent (legacy callers), history is empty and the
 * current offer falls back to the floor — preserving prior behavior.
 */
export function buildNegotiationRequest(
  round: number,
  config: Record<string, unknown>,
  creatorReply: string,
  priorContext?: PriorNegotiationContext,
) {
  const maxRounds = typeof config["maxRounds"] === "number" ? config["maxRounds"] : 5;
  // Resolve the band from EITHER termFloor/termCeiling (seed snapshots) or
  // minBudget/maxBudget (Workflow Builder UI + templates). Without this, a
  // UI-built workflow sent an empty band → floor 0 / ceiling +inf → the
  // accept/counter/escalate logic was inert (see resolveBand).
  const { termFloor, termCeiling } = resolveBand(config);
  const senderName = typeof config["senderName"] === "string" ? config["senderName"] : undefined;
  const brandDescription = typeof config["brandDescription"] === "string" ? config["brandDescription"] : undefined;
  const deliverables = typeof config["deliverables"] === "string" ? config["deliverables"] : undefined;
  const timeline = typeof config["timeline"] === "string" ? config["timeline"] : undefined;
  // Non-fee terms the creator cannot negotiate: the commission % and any product
  // perk/reward are brand-set. Threaded so the LLM can state them as FIXED when a
  // creator tries to move them (and so the output guard can enforce it). Only the
  // fixed fee is negotiable.
  const commissionRate =
    typeof config["commissionRate"] === "number" && Number.isFinite(config["commissionRate"])
      ? config["commissionRate"]
      : undefined;
  const rewardDescription =
    typeof config["rewardDescription"] === "string" && config["rewardDescription"].trim().length > 0
      ? config["rewardDescription"]
      : undefined;
  // M1/HARD-N3: optional band position for the recommended opening offer (0..1).
  // Passed through only when a finite number; the agent clamps to [0,1] and falls
  // back to 0.0 (open at floor) when omitted. The shipped templates set 0.5 (band
  // midpoint) explicitly so a bare "I'm interested" opens mid-band, not at $0.
  const recommendedOfferPosition =
    typeof config["recommendedOfferPosition"] === "number" && Number.isFinite(config["recommendedOfferPosition"])
      ? config["recommendedOfferPosition"]
      : undefined;
  // Phase C (#12): merchant-configurable tolerance ABOVE the ceiling, as a
  // percent. Passed through only when a finite, non-negative number; the agent
  // defaults to 0 (zero tolerance = today's behavior: escalate the moment an ask
  // exceeds the ceiling). A negative value is dropped (treated as omitted → 0).
  const overCeilingTolerance =
    typeof config["overCeilingTolerance"] === "number" &&
    Number.isFinite(config["overCeilingTolerance"]) &&
    config["overCeilingTolerance"] >= 0
      ? config["overCeilingTolerance"]
      : undefined;

  // FIX-2: thread the last offer we actually proposed; fall back to the floor
  // only when there is no prior offer (round 0 / no history).
  const currentOffer: NegotiationTerm =
    priorContext?.currentOffer !== undefined
      ? { ...termFloor, rate: priorContext.currentOffer }
      : termFloor;

  // FIX-1: thread real prior turns instead of a hardcoded empty array.
  const negotiationHistory: NegotiationHistoryEntry[] = (priorContext?.history ?? []).map((h) => ({
    round: h.round,
    action: h.action,
    ...(h.rate !== undefined ? { terms: { rate: h.rate } } : {}),
    ...(h.message !== undefined ? { message: h.message } : {}),
  }));

  // F-H1: the full both-sides transcript, threaded only when the executor
  // supplied one (empty on the first turn). Passed through verbatim — the agent
  // renders it as a <conversation_history> DATA block and sanitizes each creator
  // turn. Kept off the request entirely when absent so first-contact behavior and
  // any legacy caller that doesn't build it are unchanged.
  const conversationHistory = priorContext?.conversationHistory;

  // PLU-111 (O6): outstanding Pluvus commitments — sanitized DATA, never a money
  // input. Attached only when non-empty so first-contact / no-commitment behavior
  // is unchanged.
  const openCommitments = priorContext?.openCommitments;

  // classify→negotiate hint: the first-reply classifier's intent, forwarded as a
  // SOFT advisory signal (agent renders a one-line hint). Never a money input.
  // Attached only when present so a mid-negotiation / un-classified turn is unchanged.
  const intent = priorContext?.intent;

  return {
    creatorReply,
    currentOffer,
    round,
    maxRounds,
    negotiationHistory,
    ...(conversationHistory && conversationHistory.length ? { conversationHistory } : {}),
    ...(openCommitments && openCommitments.length ? { openCommitments } : {}),
    ...(intent ? { intent } : {}),
    campaignConstraints: {
      termFloor,
      termCeiling,
      ...(senderName ? { senderName } : {}),
      ...(brandDescription ? { brandDescription } : {}),
      ...(deliverables ? { deliverables } : {}),
      ...(timeline ? { timeline } : {}),
      ...(commissionRate !== undefined ? { commissionRate } : {}),
      ...(rewardDescription ? { rewardDescription } : {}),
      ...(recommendedOfferPosition !== undefined ? { recommendedOfferPosition } : {}),
      ...(overCeilingTolerance !== undefined ? { overCeilingTolerance } : {}),
    },
  };
}

/**
 * Map a NegotiationResponse to the engine's legacy NegotiateResult, surfacing
 * the proposed rate (FIX-2) so the executor can persist it and thread it back
 * next turn. ESCALATE maps to the "escalate" outcome (executor owns the
 * MANUAL_REVIEW transition).
 */
export function mapNegotiationResponse(
  resp: {
    action: NegotiateOutcome | string;
    proposedTerms?: NegotiationTerm;
    responseDraft?: string;
    reasoning?: string;
    creatorQuestions?: string[];
    pushedFixedTerms?: string[];
    creatorRequestedRate?: number;
    escalationReason?: string;
    isFinalRound?: boolean;
  },
  round: number,
): NegotiateResult {
  const proposedRate =
    typeof resp.proposedTerms?.["rate"] === "number" ? (resp.proposedTerms["rate"] as number) : undefined;

  // Comprehension threaded across the seam (spec §6.1). Only spread when
  // non-empty so an absent/empty producer (rules mode) leaves the field
  // undefined and the executor's `?? []` handling stays a no-op.
  //
  // creatorRequestedRate (MED-N3) rides along on EVERY outcome — the escalate
  // path needs it most (it becomes the ask quoted to the brand, and the deal
  // rate on a brand APPROVE).
  const comprehension = {
    ...(resp.creatorQuestions?.length ? { creatorQuestions: resp.creatorQuestions } : {}),
    ...(resp.pushedFixedTerms?.length ? { pushedFixedTerms: resp.pushedFixedTerms } : {}),
    ...(typeof resp.creatorRequestedRate === "number" && Number.isFinite(resp.creatorRequestedRate)
      ? { creatorRequestedRate: resp.creatorRequestedRate }
      : {}),
    // Q3 (founder, autonomous launch): the final-round flag rides along on every
    // outcome so the offer branches (accept/counter/present_offer) can thread it
    // into /draft. Only spread when true so non-final turns leave it undefined.
    ...(resp.isFinalRound === true ? { isFinalRound: true as const } : {}),
    // Option A (negotiate→draft answer sync): carry the GENUINE advisory draft
    // (responseDraft) distinctly from `message` (which has a fallback). Set only
    // when the agent returned a real, non-empty draft — i.e. the LLM strategy ran
    // and the guards did NOT null it. The offer branches thread this into /draft as
    // negotiatorAnswers so the copy rephrases approved answers instead of inventing.
    ...(typeof resp.responseDraft === "string" && resp.responseDraft.trim()
      ? { negotiatorAnswers: resp.responseDraft }
      : {}),
  };

  switch (resp.action) {
    case "ACCEPT":
      return {
        outcome: "accept",
        message: resp.responseDraft ?? "Partnership confirmed.",
        ...(proposedRate !== undefined ? { proposedRate } : {}),
        ...comprehension,
      };
    case "COUNTER":
      return {
        outcome: "counter",
        message: resp.responseDraft ?? `Counter-offer for round ${round + 1}.`,
        ...(proposedRate !== undefined ? { proposedRate } : {}),
        ...comprehension,
      };
    case "PRESENT_OFFER":
      return {
        outcome: "present_offer",
        message: resp.responseDraft ?? "Here are the details of our offer.",
        ...(proposedRate !== undefined ? { proposedRate } : {}),
        ...comprehension,
      };
    case "REJECT":
      return {
        outcome: "reject",
        message: resp.responseDraft ?? "Unable to reach agreement.",
        ...comprehension,
      };
    case "ESCALATE":
      return {
        outcome: "escalate",
        message: resp.reasoning ?? "Escalated for human review.",
        ...comprehension,
        // Phase E (#5): carry the always-escalate topic reason so the executor
        // records the specific reason on MANUAL_REVIEW.
        ...(resp.escalationReason ? { escalationReason: resp.escalationReason } : {}),
      };
    default:
      // Defensive: an unknown action escalates to a human rather than guessing.
      return { outcome: "escalate", message: resp.reasoning ?? "Unrecognized negotiation action." };
  }
}
