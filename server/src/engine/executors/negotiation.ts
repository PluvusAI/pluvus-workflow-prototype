import {
  listMessagesByInstance,
  listEventsByInstance,
  listOpenObligationsByInstance,
} from "../../db/index.js";
import type { ConversationObligation, Message } from "../../db/schema.js";
import type { ExecutionContext, NodeResult, NegotiationHistoryEntryLite, PriorNegotiationContext, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import {
  buildPriorContextFromEvents,
  buildDraftHistory,
  computeOpenQuestions,
  buildOpenObligations,
  buildStructuredObligations,
  buildQuestionObligationPlan,
  type QuestionObligationPlanItem,
  computeChangedFields,
  computeRelationshipWarmth,
} from "./negotiationHistory.js";
import {
  resolveBriefKnowledge,
  deriveBriefAvailability,
  type ResolvedBrief,
  type BriefFieldConflict,
} from "./briefKnowledge.js";
import { scanOutboundDraft, guardConstraintsFromConfig } from "../guards/outputGuard.js";
import { reserveOutbound } from "./idempotentSend.js";
import { randomSendDelayMs } from "../sendDelay.js";
import { describeDeal } from "../dealDescription.js";
import { extractReplyText } from "./replyText.js";
import { mergeCampaignFallback } from "../campaignContext.js";
import { resolveBand } from "../band.js";
// HARD-A2: the output-guard-blocked MANUAL_REVIEW result is the SAME shape used
// by other executors, so it lives in one place (guardEscalation.ts) rather than
// being duplicated inline here. Previously negotiation.ts and guardEscalation.ts
// each carried a byte-identical copy — a drift hazard on a safety path.
import { blockedByGuard } from "./guardEscalation.js";

// PLU-107 §4.9/§6: the /negotiate wiring carries its OWN sub-flag (separate from
// the agent-side STRUCTURED_BRIEF_PARSING_ENABLED) so structured parsing can ship
// and be validated before the decision-prompt change flips on. Default OFF → the
// brief is threaded into /draft exactly as today but NOT into /negotiate, so the
// negotiate prompt is byte-identical to today. When on, the brief flat text is made
// available to /negotiate via campaignContext; the AGENT still applies the §4.10
// knowledge-turn cost gate (it renders the block only on knowledge questions).
function briefIntoNegotiateEnabled(): boolean {
  return process.env["BRIEF_INTO_NEGOTIATE"] === "true";
}

// PLU-114 §4.2: the agent's flat-brief safety net (_has_flat_brief) reads
// ctx["briefKnowledge"] to avoid a false defer when a matched section is
// unavailable but the answer may sit in the blob. That net fires only when the
// blob is threaded — so it must reach /negotiate whenever RETRIEVAL is on, not
// just when the separate BRIEF_INTO_NEGOTIATE sub-flag is on. Byte-identical when
// retrieval is OFF (blob still not threaded → invariant #9).
function knowledgeRetrievalEnabled(): boolean {
  return process.env["KNOWLEDGE_RETRIEVAL_ENABLED"] === "true";
}

// PLU-82 §4.5 / §6: gates ONLY the material-conflict escalation DECISION (not the
// detection or observability surfacing, which ship unconditionally). Default OFF
// → today's behavior (console.warn + the observability record), byte-identical on
// every real deal. Orthogonal to the two brief-into-prompt flags above; has a
// HIDDEN dependency on the agent's STRUCTURED_BRIEF_PARSING_ENABLED (no structured
// sections → resolvedBrief.conflicts is always empty → this path is inert
// regardless of its own flag, invariant #9 / §8-f).
function materialConflictEscalationEnabled(): boolean {
  return process.env["MATERIAL_CONFLICT_ESCALATION_ENABLED"] === "true";
}

// PLU-114 (§4.9): project ResolvedBrief.sections ({key: CampaignBriefSection}) to
// the {key: text} map the agent's AvailableSections.brief consumes. Returns
// undefined when there are no sections (no brief / structured parse off / parse
// failed) so the caller omits the wire key entirely (the router then resolves
// from the flat fields, or defers). Only the text crosses the wire — page/source
// provenance stays server-side (the observability record is built agent-side from
// keys/rules, not values).
function projectBriefSections(
  sections: ResolvedBrief["sections"],
): Record<string, string> | undefined {
  if (!sections) return undefined;
  const out: Record<string, string> = {};
  for (const [key, section] of Object.entries(sections)) {
    const text = section?.text;
    if (typeof text === "string" && text.trim()) {
      out[key] = text;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// PLU-114 REVIEW #1 (Calvin follow-up W1): the four authoritative flat knowledge
// fields (usageRights / exclusivity / paymentTerms / attributionWindow) live on
// `config` and reach /draft (via draftConfig = {...config}) but were NEVER placed
// on the negotiate campaignContext — so the negotiate router resolved a configured
// term to requested_but_unavailable and steered the model to defer a KNOWN answer,
// an asymmetry with /draft. Project them (trimmed, non-empty only) so they can be
// spread onto the negotiate knowledgeContext the same additive way as briefSections.
// These are REFERENCE DATA only — campaignContext is documented "NEVER a money
// input"; adding four string fields does not change that (guards + fee path
// untouched). Exported for the request-shape unit test.
export const FLAT_KNOWLEDGE_KEYS = [
  "usageRights",
  "exclusivity",
  "paymentTerms",
  "attributionWindow",
] as const;

export function projectFlatKnowledge(
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FLAT_KNOWLEDGE_KEYS) {
    const v = config[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

// FIX-11 + Randomized Send Delay (§4.1, §4.3a): outbound AI replies use the
// reserve-before-send helper, keyed on negotiation:<purpose>:<instance>:<round>,
// so a crash between email.send() and the row write cannot double-send a turn on
// a BullMQ retry. Under the send-delay split the negotiation executor RESERVES the
// row (reserveOutbound — no send) and returns a `deferredSend` on the NodeResult;
// runtime.ts enqueues the delayed flush ONLY after the OCC transaction commits, so
// a rolled-back turn (StaleInstanceError) never sends a phantom email.

// Reserve an AI reply and produce the NodeResult.deferredSend for it (§4.3a).
// Returns { deferredSend, sendScheduledInMs } on a fresh reserve, or undefined
// deferredSend when reserveOutbound found the send already delivered (P2002 case
// a) — in which case the caller must NOT enqueue a flush (it would resend). The
// draw happens here (once, at reserve time); flush reads no timing config (§4.5).
async function reserveAiReply(
  instanceId: string,
  draft: EmailDraft,
  idempotencyKey: string,
): Promise<{ deferredSend?: { messageId: string; delayMs: number }; sendScheduledInMs: number }> {
  const reserved = await reserveOutbound(instanceId, draft, idempotencyKey);
  if (reserved.alreadySent) {
    // Already delivered on a prior attempt — no re-enqueue, no re-draw.
    return { sendScheduledInMs: 0 };
  }
  const delayMs = randomSendDelayMs();
  return {
    deferredSend: { messageId: reserved.messageId, delayMs },
    sendScheduledInMs: delayMs,
  };
}

// Build the MANUAL_REVIEW NodeResult emitted when AI copy generation for an
// OFFER turn (present_offer / accept / counter) fails after retries. These turns
// PRESENT concrete terms (fee, commission, deliverables) and must read as a
// proper, well-formatted reply. The old behavior silently fell back to the
// sparse `negotiate` responseDraft — a one-line "$350.0" note that ignored the
// creator's questions. Rather than send that, route the turn to a human (the
// draftEmail path already retried before returning null). No email is sent.
function draftUnavailable(round: number, purpose: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "draft_generation_failed",
      purpose,
      round,
    },
  };
}

// The creator's most recent inbound message, EXCLUDING any inbound rows tagged as
// brand replies. LEGACY: the removed brand-decision loop (#14) used to persist a
// brand's escalation reply INBOUND on the instance, tagged on the
// INBOUND_REPLY_RECEIVED event with `brandDecisionReply: true`; those had to be
// dropped so the agent didn't read the brand's "approve" as the creator's words.
// No new such rows are written now (escalation is a clean terminal MANUAL_REVIEW),
// so `brandReplyMsgIds` is empty for any fresh instance — the filter is retained
// only to keep any historical rows out of the transcript. (Normal creator replies
// have no such tag.)
//
// Returns the full Message row (MED-W2 needs its id to key the present-offer
// send per-reply, not per-round).
// HARD-N2: the executor needs not just the LATEST creator message but the whole
// set (to thread the conversation into /draft), plus the brand-reply id set. This
// loads all three in one place so the latest-reply read and the draft-history
// builder agree on exactly which inbound rows count as "the creator".
async function loadCreatorInbounds(instanceId: string): Promise<{
  messages: Message[];
  brandReplyMsgIds: Set<string>;
  latest: Message | undefined;
}> {
  const messages = await listMessagesByInstance(instanceId);
  const events = await listEventsByInstance(instanceId, { type: "INBOUND_REPLY_RECEIVED" });
  const brandReplyMsgIds = new Set(
    events
      .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
      .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
      .filter((id): id is string => typeof id === "string"),
  );
  const latest = messages
    .filter((m) => m.direction === "INBOUND")
    .filter((m) => !(m.externalMessageId && brandReplyMsgIds.has(m.externalMessageId)))
    .at(-1);
  return { messages, brandReplyMsgIds, latest };
}

// Best-effort REGEX extraction of a dollar amount the creator named in their
// reply (e.g. "I charge $480" / "480 dollars" / "my rate is 480").
//
// MED-N3 role note: the comprehension source of truth for the creator's ask is
// the /negotiate LLM's `creatorRequestedRate` (validated in the agent so its
// digits provably appear in the reply). This regex remains for two narrower
// jobs: (a) acknowledgment copy / guard allowlisting when the agent didn't
// return a rate, and (b) the pre-agent max-rounds entry stop, which by design
// never calls the model. By construction every number it returns appears
// verbatim in the reply; a RANGE ("480-500") is rejected below rather than
// half-read.
export function extractRequestedRate(text: string | undefined): number | undefined {
  if (!text) return undefined;
  // MED-N3: blank out RANGE expressions ("480-500", "400 to 500", "between 400
  // and 500") before scanning. A range is not a single ask — matching one side
  // of it would record a price the creator never named alone. Stripping (rather
  // than bailing) keeps a genuine single ask elsewhere in the reply readable.
  text = text
    .replace(/\bbetween\s+\$?\s*\d[\d,]*(?:\.\d+)?\s+and\s+\$?\s*\d[\d,]*(?:\.\d+)?/gi, " ")
    .replace(/\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:[-–—]|\bto\b)\s*\$?\s*\d[\d,]*(?:\.\d+)?/gi, " ");
  // Priority 1: an explicit "$" amount. Priority 2: a number tagged "dollars"/
  // "usd". Priority 3: a BARE number adjacent to a rate-signalling word — this
  // catches the common "my rate is 900" / "I need 900" / "can you do 900" phrasing
  // that carries no currency marker, WITHOUT grabbing incidental counts like
  // "3 reels" (no rate word nearby → not matched).
  const dollar = text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  const worded = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars|usd)\b/i);
  // An explicit "$" or "dollars" marker makes ANY number a rate (even "$3").
  const markedRaw = dollar?.[1] ?? worded?.[1];
  if (markedRaw) {
    const n = Number(markedRaw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  // No currency marker: fall back to a BARE number adjacent to a rate-signalling
  // word — catches "my rate is 900" / "I need 900" / "can you do 900" WITHOUT a
  // "$". A rate word before the number ("rate is 900", "do 900") or after it
  // ("900 is my rate", "900 flat"). To avoid grabbing incidental counts that
  // happen to sit next to a generic word (e.g. "do 3 stories"), a bare number
  // must be money-plausible (>= MIN_BARE_RATE); real creator asks are never $3.
  const MIN_BARE_RATE = 50;
  const rateWord = "(?:rate|charge|charging|fee|price|priced|budget|ask(?:ing)?|need|want|pay|do|flat)";
  const bareBefore = text.match(
    new RegExp(`\\b${rateWord}\\b[^\\d]{0,12}(\\d[\\d,]*(?:\\.\\d+)?)`, "i"),
  );
  const bareAfter = text.match(
    new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[^\\d]{0,12}\\b${rateWord}\\b`, "i"),
  );
  const bareRaw = bareBefore?.[1] ?? bareAfter?.[1];
  if (!bareRaw) return undefined;
  const bare = Number(bareRaw.replace(/,/g, ""));
  if (!Number.isFinite(bare) || bare < MIN_BARE_RATE) return undefined;
  return bare;
}

// MED-W3: how many CONSECUTIVE present-offer turns are "free" (don't consume a
// negotiation round). PRESENT_OFFER deliberately doesn't burn the round budget —
// a curious creator's questions shouldn't exhaust it — but with no cap a
// persistently curious creator (or a model mislabeling proposals) loops forever,
// each turn an LLM call. Past this many consecutive presents without progress,
// each further present COUNTS as a round, so the max-rounds machinery (B9 brand
// decision) bounds the loop.
const MAX_FREE_PRESENT_OFFERS = 3;

// Trailing run of PRESENT_OFFER turns at the end of the (chronological) history.
// Any other action (counter/accept/…) is "progress" and resets the run.
function countTrailingPresentOffers(history: NegotiationHistoryEntryLite[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.action !== "PRESENT_OFFER") break;
    n++;
  }
  return n;
}

// V1 (#15): a negotiation that fails to reach agreement WITHIN the configured
// round limit auto-CLOSES rather than paging a human. At the founder's volume a
// brand can't field thousands of "we couldn't agree" decisions, and #14 makes
// escalation a clean one-way handoff — there is no brand counter-offer loop to
// resume into. So both max-rounds sites send the creator a brief, courteous
// close email and transition to REJECTED (terminal). This is the only failure
// mode that auto-rejects: judgment/legal/dispute paths still go to MANUAL_REVIEW.
//
// Shared by BOTH callers that can reach the ceiling:
//   1. the hard stop at entry (instance re-enters already at negotiationRound >=
//      maxRounds), and
//   2. the counter path's secondary guard (a counter that WOULD push the round to
//      maxRounds — that round can't be sent, so this IS the max-rounds moment).
//
// Q2 (locked): reserve a courteous close email BEFORE rejecting (the delayed
// flush is enqueued by the runtime post-commit — §4.3a). Best-effort: a reserve
// failure must NOT block the transition, so the run still reaches REJECTED. It's
// idempotent (keyed on the round via reserveOutbound) so a BullMQ retry of this
// step can't double-email the creator.
// Exported for the T1 escalation-trap tests (routing assertions). Visibility
// only — behavior unchanged. See readme_docs/testing/.
export async function maxRoundsReject(
  ctx: ExecutionContext,
  email: IEmailProvider,
  config: Record<string, unknown>,
  args: {
    maxRounds: number;
    round: number;
    /** The creator's latest stated ask, for the audit payload only (no longer a
     *  money-path input now that there's no brand APPROVE to record a deal rate).
     *  MED-N3: post-agent callers pass the /negotiate LLM's validated extraction;
     *  the pre-agent entry stop falls back to the deterministic regex read. */
    creatorRate: number | undefined;
  },
): Promise<NodeResult> {
  const { maxRounds, round, creatorRate } = args;

  // Reserve the courteous close email (§4.1). Best-effort: a reserve failure must
  // NOT block the REJECTED transition, so it's swallowed and the run still
  // terminates cleanly (Q2). The actual send is a deferred flush enqueued by the
  // runtime after this turn's OCC commit (§4.3a) — so a rolled-back auto-close
  // never emails the creator.
  const reserve = await reserveCloseEmail(ctx, email, config);

  return {
    nextState: "REJECTED",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    ...(reserve?.deferredSend ? { deferredSend: reserve.deferredSend } : {}),
    eventPayload: {
      outcome: "REJECT",
      reason: "max_rounds_no_agreement",
      round,
      maxRounds,
      ...(creatorRate !== undefined ? { creatorRate } : {}),
      ...(reserve ? { sendScheduledInMs: reserve.sendScheduledInMs } : {}),
    },
  };
}

// Best-effort courteous close email for the max-rounds auto-reject (#15, Q2).
// Rendered from a plain template through the provider's own draft() seam, so it
// works with both the mock and a real provider WITHOUT an LLM call (an offer/
// counter draft could fail-and-escalate; a fixed close note must not, and must
// not gate the REJECTED transition). Idempotent + best-effort: a reserve failure
// is swallowed so the run still reaches REJECTED.
//
// Randomized Send Delay (§4.1): RESERVES the close email (no inline send) and
// returns its deferredSend so maxRoundsReject can put it on the NodeResult; the
// runtime enqueues the delayed flush after the OCC commit. Returns undefined when
// reserve fails (swallowed) or the send was already delivered on a prior attempt.
async function reserveCloseEmail(
  ctx: ExecutionContext,
  email: IEmailProvider,
  config: Record<string, unknown>,
): Promise<{ deferredSend?: { messageId: string; delayMs: number }; sendScheduledInMs: number } | undefined> {
  const { instance, creator } = ctx;
  const senderName =
    typeof config["senderName"] === "string" ? config["senderName"] : "Pluvus Partnerships";
  const brandName =
    typeof config["brandName"] === "string" ? config["brandName"] : senderName;
  // Deliberately says nothing about budget/rounds/internal bounds — just a warm,
  // non-committal close. No {{rate}}/{{floor}}/{{ceiling}} tokens, so there is
  // nothing for the output guard to leak.
  const template = [
    `Hi {{creatorName}},`,
    ``,
    `Thank you so much for taking the time to talk through a partnership with ${brandName} — we genuinely enjoyed the conversation.`,
    ``,
    `We weren't quite able to land on terms that worked for both of us on this particular campaign, so we'll close this one out for now. That's entirely okay — these things come down to fit and timing, and we'd love to stay in touch for future campaigns where the numbers line up better. If something changes on your end, our door is always open too.`,
    ``,
    `Wishing you all the best, and hopefully we'll work together down the line.`,
    ``,
    `Warmly,`,
    `${senderName}`,
  ].join("\n");

  try {
    const draft = await email.draft(creator, template, config);
    // Reserve the row (no send). The delayed flush is enqueued by the runtime
    // post-commit; the campaign label is applied at flush time (flushOutbound
    // reloads the campaign name from the instance).
    return await reserveAiReply(
      instance.id,
      draft,
      `negotiation:close:${instance.id}:${instance.negotiationRound}`,
    );
  } catch (err) {
    // Best-effort (#15, Q2): never let a close-email reserve failure block the
    // REJECTED transition — the run must still terminate cleanly.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[negotiation] close email reserve failed for instance ${instance.id} (auto-reject): ${message}`,
    );
    return undefined;
  }
}

// V1 (#14): the agent escalated because the creator's ask is above the internal
// ceiling (or the rate was unreadable). Escalation is now a clean one-way handoff
// — route straight to MANUAL_REVIEW (terminal). The brand is emailed an FYI by
// runtime.notifyBrandOfEscalation (keyed on this reason) and the conversation is
// surfaced in the Manual Queue for a human to take over out-of-band. No magic
// links, no brand-decision round-trip, no auto-resume.
//
// The reason defaults to `escalated` (preserved so the existing REASON_LABELS +
// Manual Queue render it), but a Phase E always-escalate topic (legal/dispute/
// pricing-exception/undefined-terms/usage-rights) overrides it with the specific
// topic reason so the Manual Queue shows WHY. `creatorRate` is recorded on the
// audit payload only (there is no brand APPROVE to turn it into a deal rate).
// Exported for the T1 escalation-trap tests (routing assertions). Visibility
// only — behavior unchanged. See readme_docs/testing/.
export function escalateOverCeiling(args: {
  round: number;
  message: string;
  /** MED-N3: the /negotiate LLM's validated extraction of the creator's ask,
   *  for the audit payload / Manual Queue context only. */
  creatorRate: number | undefined;
  /** Phase E (#5): the always-escalate topic reason, when this escalate was
   *  driven by a topic rather than an over-ceiling ask. Overrides "escalated". */
  escalationReason?: string | undefined;
}): NodeResult {
  const { round, message, creatorRate, escalationReason } = args;
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: escalationReason ?? "escalated",
      round,
      message,
      ...(escalationReason ? { alwaysEscalateTopic: true } : {}),
      ...(creatorRate !== undefined ? { creatorRate } : {}),
    },
  };
}

// H1: the campaign defines a floor but no ceiling (maxBudget/termCeiling.rate is
// null/absent), so `ceiling = +inf` and the agent's over-ceiling ACCEPT guard is
// a NO-OP — nothing can exceed infinity, so the model's prompt would be the ONLY
// thing standing between the creator and an unbounded agree. Rather than
// negotiate against an infinite cap on the money path, hand the conversation to a
// human (terminal MANUAL_REVIEW) with a reason that tells the brand exactly what
// to fix: set a maximum budget. This is the runtime backstop for the same
// invariant the parent enforces at campaign-publish time ("derive the band from
// campaigns.fixedPaymentAmount, validate at creation"). Exported for the T1
// routing test. NB: an uncapped campaign with NO floor is unconfigured anyway
// (the band logic was already inert) — only a floor-but-no-ceiling campaign is
// the dangerous "looks capped, isn't" case, so that is what this guards.
export function escalateNoCeiling(args: { round: number }): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "no_ceiling_configured",
      round: args.round,
      message:
        "Negotiation cannot run: this campaign has a preferred budget but no maximum budget, " +
        "so there is no ceiling to negotiate within. Set a maximum budget to enable auto-negotiation.",
    },
  };
}

// PLU-111 (§4.4 / O5): a light, best-effort category bucket for a creator
// question, keyword-detected from the text. Optional metadata only (never a
// control-flow input) — an unmatched question gets `undefined`, which is fine.
// Kept deliberately small; the robust taxonomy is a flagged follow-up.
const OBLIGATION_CATEGORY_PATTERNS: { category: string; re: RegExp }[] = [
  { category: "usage_rights", re: /\busage rights?\b|\blicens|\bexclusiv|\bwhitelist|\busage of\b/i },
  { category: "shipping", re: /\bship|\bshipping\b|\baddress\b|\bdeliver(?:y|ed)\b|\btracking\b/i },
  { category: "timeline", re: /\bdeadline\b|\btimeline\b|\bwhen\b.*\b(?:live|due|post|deliver)|\bhow long\b|\bturnaround\b/i },
  { category: "payment", re: /\bpay(?:ment|out)?\b|\binvoice\b|\bnet ?\d+\b|\bwhen.*paid\b|\bpaypal\b|\bbank\b/i },
  { category: "deliverables", re: /\bdeliverabl|\bhow many\b|\breels?\b|\bstories\b|\bposts?\b|\bvideos?\b/i },
];

function detectObligationCategory(question: string): string | undefined {
  for (const { category, re } of OBLIGATION_CATEGORY_PATTERNS) {
    if (re.test(question)) return category;
  }
  return undefined;
}

// PLU-82 §4.5: the four authoritative conflict fields, mapped to the COARSE
// obligation category detectObligationCategory emits. This is the FALLBACK axis:
// an open obligation from a prior round only carries the coarse category (it was
// stored via detectObligationCategory), so usageRights and exclusivity are
// indistinguishable there and share `usage_rights`. This-turn matching uses the
// field-specific detector below instead — see conflictAffectsCreatorCommitment.
const CONFLICT_FIELD_TO_CATEGORY: Record<string, string | undefined> = {
  usageRights: "usage_rights",
  exclusivity: "usage_rights",
  paymentTerms: "payment",
  // review §5 (Calvin): attributionWindow is now a first-class conflict field — it
  // has its own field-specific pattern below, and the coarse category axis is left
  // undefined only because detectObligationCategory has no attribution keyword (so
  // an OLD open obligation can't back-fill it; a this-turn ask still matches).
  attributionWindow: undefined,
};

// review §5 (Calvin): FIELD-SPECIFIC detection for the conflict keys, so a creator
// asking about usage rights does NOT match an exclusivity-only conflict (the two
// used to share the coarse `usage_rights` bucket and cross-triggered). Each pattern
// matches the ONE field; a question is tested against the field of the conflict at
// hand. attributionWindow gets its own pattern here (Calvin: it was detected but
// unable to escalate — now it can, when the creator actually asks about it).
const CONFLICT_FIELD_PATTERNS: Record<string, RegExp> = {
  usageRights: /\busage rights?\b|\busage of\b|\blicens|\bwhitelist|\bwhitelabel|\bpaid ads?\b|\bboost(?:ing|ed)?\b/i,
  exclusivity: /\bexclusiv|\bnon-?compete\b|\bcompeting brands?\b|\bcategory exclusiv/i,
  paymentTerms: /\bpay(?:ment|out)?\b|\binvoice\b|\bnet ?\d+\b|\bwhen.*paid\b|\bpaypal\b|\bbank\b|\bterms of payment\b/i,
  attributionWindow:
    /\battribution window\b|\battribution period\b|\bcookie window\b|\bconversion window\b|\btracking window\b|\battribution\b/i,
};

/** True when the creator text is specifically ABOUT `field` (not a sibling that
 *  merely shares a coarse category). Used for this-turn matching in §4.5. */
function questionMentionsField(field: string, texts: string[]): boolean {
  const re = CONFLICT_FIELD_PATTERNS[field];
  if (!re) return false;
  return texts.some((t) => re.test(t));
}

/** True when more than one conflict field maps to `coarse` (e.g. usageRights +
 *  exclusivity → usage_rights). A coarse-only open obligation in a SHARED category
 *  is ambiguous — it cannot tell which sibling the creator meant — so we do NOT let
 *  it back-fill either field (conservative; a this-turn field-specific ask still
 *  matches). Computed from CONFLICT_FIELD_TO_CATEGORY so it stays in sync. */
function coarseCategoryIsShared(coarse: string): boolean {
  let count = 0;
  for (const cat of Object.values(CONFLICT_FIELD_TO_CATEGORY)) {
    if (cat === coarse) count += 1;
  }
  return count > 1;
}

/**
 * PLU-82 §4.5 / invariant #7 — the gate that stops false-positive escalation. A
 * brief-vs-Campaign conflict exists on EVERY turn from round 0, independent of the
 * creator; escalating on conflict-existence alone would dump the deal to
 * MANUAL_REVIEW on "yes I'm interested". So a conflict escalates ONLY when it would
 * produce an unsupported AUTOMATED ANSWER — i.e. the creator asked about that exact
 * field this turn, or has a non-terminal open obligation on it.
 *
 * Returns the list of conflict fields that are BOTH material (∈ the four conflict
 * keys) AND asked-about; an empty list means NO escalation (the common case).
 * Pure — the caller adds the flag + `outcome !== "escalate"` guards.
 *
 * The `outcome !== "escalate"` clause is applied by the CALLER (defer to the topic
 * gate's reason, never race it — invariant #8).
 */
export function conflictAffectsCreatorCommitment(
  conflicts: ReadonlyArray<{ campaignField: string }>,
  creatorQuestions: string[] | undefined,
  pushedFixedTerms: string[] | undefined,
  openObligations: ReadonlyArray<Pick<ConversationObligation, "category">>,
): string[] {
  if (!conflicts.length) return [];

  // review §5 (Calvin): match FIELD-SPECIFICALLY, not through a shared coarse
  // bucket. Two axes:
  //
  //   (1) THIS-TURN text (creator questions + pushed terms) — matched by the
  //       field's OWN pattern (CONFLICT_FIELD_PATTERNS), so an ask about usage
  //       rights matches ONLY a usageRights conflict, never an exclusivity-only
  //       one. attributionWindow now matches here too.
  //
  //   (2) OPEN OBLIGATIONS from prior rounds — these carry only the COARSE category
  //       (they were stored via detectObligationCategory, which cannot tell
  //       usageRights from exclusivity). Used as a CONSERVATIVE FALLBACK: a
  //       coarse-category open obligation re-surfaces a field only when the field
  //       has no less-ambiguous signal. This is the "conservative fallback is fine
  //       when genuinely ambiguous" case Calvin called out.
  const thisTurnText = [...(creatorQuestions ?? []), ...(pushedFixedTerms ?? [])];
  const openCoarseCategories = new Set<string>();
  for (const o of openObligations) {
    if (o.category) openCoarseCategories.add(o.category);
  }

  const matched: string[] = [];
  const seen = new Set<string>();
  for (const c of conflicts) {
    const field = c.campaignField;
    // (a) the field must be one of the four creator-commitment conflict keys.
    if (!(field in CONFLICT_FIELD_TO_CATEGORY)) continue;
    if (seen.has(field)) continue;

    // (b) FIELD-SPECIFIC this-turn match — the strong signal.
    const askedThisTurn = questionMentionsField(field, thisTurnText);

    // (c) FALLBACK: a prior open obligation in this field's coarse category. Only
    //     applied when this-turn text did not already resolve the field, and only
    //     for fields whose coarse category is unambiguous OR where no sibling field
    //     shares the category (so exclusivity/usageRights don't cross-trigger off a
    //     coarse open obligation alone — that stays conservative-silent unless a
    //     this-turn ask names the field).
    const coarse = CONFLICT_FIELD_TO_CATEGORY[field];
    const fallbackMatch =
      !askedThisTurn &&
      coarse !== undefined &&
      openCoarseCategories.has(coarse) &&
      !coarseCategoryIsShared(coarse);

    if (askedThisTurn || fallbackMatch) {
      seen.add(field);
      matched.push(field);
    }
  }
  return matched;
}

/**
 * PLU-82 §4.5 — route a turn to MANUAL_REVIEW because a MATERIAL brief-vs-Campaign
 * conflict on a field the creator asked about would otherwise let the AI give an
 * unsupported automated answer. Mirrors escalateOverCeiling's NodeResult shape so
 * the existing MANUAL_REVIEW machinery (Manual Queue + brand FYI keyed on
 * eventPayload.reason) picks it up with no runtime change. Exported for the
 * escalation-routing test.
 *
 * The section VALUES ride the payload (persisted, operator-only via the
 * /observability gate) so the inspector can show both disagreeing sources; they
 * are NEVER logged to stdout (the caller keeps the keys/reason-only console.warn).
 */
export function escalateMaterialConflict(args: {
  round: number;
  message: string;
  /** The material fields in conflict AND asked-about (from the gate). */
  conflictFields: string[];
  /** The full conflict rows for the observability record (values shown only in
   *  the operator-gated inspector). */
  conflicts: ReadonlyArray<BriefFieldConflict>;
}): NodeResult {
  const { round, message, conflictFields, conflicts } = args;
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "material_knowledge_conflict",
      round,
      message,
      conflictFields,
      // The full conflict rows so the inspector's Knowledge panel shows both
      // sources. Same masking posture as the observability record (§4.6): values
      // are in the payload (operator-gated), never in stdout.
      conflicts: conflicts as unknown as BriefFieldConflict[],
    },
  };
}

export async function executeNegotiation(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  // H5: overlay the parent campaign's brand context onto the node config for any
  // brand field the config is missing (unstamped/legacy nodes), so the
  // negotiation + offer-copy LLM gets the real sender/brand/scope instead of
  // signing as "Pluvus Partnerships" with no scope. Node config always wins.
  const config = mergeCampaignFallback(node.config, ctx.campaign);

  if (instance.currentState !== "NEGOTIATING") {
    throw new Error(
      `NEGOTIATION expects NEGOTIATING state, got ${instance.currentState}`,
    );
  }

  // H1: a money-path campaign MUST have a ceiling. Resolve the band from the same
  // config the agent would see; if there's a floor but no ceiling, the over-ceiling
  // ACCEPT guard downstream is a no-op (nothing exceeds +inf) — the model's prompt
  // would be the ONLY cap between the creator and an unbounded agree. Escalate to a
  // human here, as a pure-config PRECONDITION (before any DB load or agent call),
  // rather than risk it. (No floor + no ceiling = an unconfigured band; the
  // accept/counter logic is already inert there and there's no money exposure to
  // guard, so that case falls through unchanged.) This is the runtime backstop for
  // the invariant the parent enforces at campaign-publish time.
  const { floor, ceiling } = resolveBand(config);
  if (floor !== undefined && ceiling === undefined) {
    return escalateNoCeiling({ round: instance.negotiationRound });
  }

  // When a downstream node owns the post-acceptance email, the negotiation ACCEPT
  // must NOT also send its own onboarding/acceptance email, or the creator gets
  // two overlapping emails. In the merged flow the CONTENT_BRIEF node sends the
  // single "Your Campaign Brief" email (finalized terms + payout link + PDF);
  // legacy graphs let the REWARD_SETUP node send the "Campaign Agreement
  // Confirmation" ("I Agree") email. Legacy workflows with neither node keep
  // sending the onboarding email here as the final touch.
  //
  // PLU-70: operator handoff owns the post-acceptance email too — it sends the
  // "looping in our campaign manager" note. Counting it here is what stops a
  // handoff execution on a graph with NEITHER node from sending an onboarding
  // email AND the handoff note. (Graphs that have a CONTENT_BRIEF/REWARD_SETUP
  // node were already covered by the first clause, so nothing changes for them.)
  const hasPostAcceptEmailNode =
    nodeGraph.some((n) => n.type === "REWARD_SETUP" || n.type === "CONTENT_BRIEF") ||
    instance.postAcceptanceMode === "operator_handoff";

  const maxRounds = typeof config["maxRounds"] === "number" ? config["maxRounds"] : 5;

  // Describe the deal structure (fixed fee / commission / both) from THIS
  // (NEGOTIATION) node's config, exactly as outreach/follow-up do. Threading it
  // into the offer/counter copy lets the email explain WHAT KIND of deal this is
  // (e.g. "hybrid — fixed fee plus commission") instead of only quoting a fee.
  const dealDescription = describeDeal(config);

  // Latest creator reply, skipping brand escalation replies (see helper). H1:
  // strip quoted thread + signature so the negotiation agent reasons about (and
  // the counter copy acknowledges) the creator's ACTUAL words, not our own quoted
  // outreach. Also feeds extractRequestedRate below — a "$500" in our quoted
  // history must not be mistaken for the creator's ask.
  const { messages: allInboundSource, brandReplyMsgIds, latest: latestInbound } =
    await loadCreatorInbounds(instance.id);
  const creatorReply = latestInbound?.body ? extractReplyText(latestInbound.body) : "";

  // Hard stop — enforce maxRounds before calling the agent.
  // This prevents the agent from even being consulted past the ceiling.
  //
  // V1 (#15): a negotiation that never reached agreement within maxRounds
  // auto-CLOSES — a courteous close email to the creator, then REJECTED. No human
  // is paged (the founder's volume can't field that), and #14 removed the brand
  // counter-offer loop that used to resume here. See maxRoundsReject.
  //
  // EASY-W1: `maxRounds <= 0` means UNLIMITED — the same semantic the agent uses
  // (_rounds_exhausted / is_final_round in negotiate.py). Without the `> 0` guard
  // a `maxRounds: 0` config would auto-reject on round 0 here while the agent
  // treats 0 as unlimited — the split semantic this guard removes.
  if (maxRounds > 0 && instance.negotiationRound >= maxRounds) {
    return maxRoundsReject(ctx, email, config, {
      maxRounds,
      round: instance.negotiationRound,
      // Pre-agent by design (never consult the model past the round ceiling), so
      // the LLM extraction isn't available here — the deterministic regex read
      // (range-rejecting; digits provably in the reply) is the documented
      // fallback for this one caller (MED-N3), used for the audit payload only.
      creatorRate: extractRequestedRate(creatorReply),
    });
  }

  // FIX-1/FIX-2: assemble the conversation so far from persisted NEGOTIATION_TURN
  // events and thread it into the (stateless) agent so it can reason about the
  // trajectory and knows its own last offer.
  const priorEvents = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const priorContext = buildPriorContextFromEvents(priorEvents);

  // HARD-N2 / PLU-85: the full conversation transcript (both sides) + the
  // answered-questions ledger, threaded into /draft so the SENT email stays
  // consistent with prior emails, doesn't repeat wording, and re-surfaces any
  // earlier unanswered question. `draftHistory` interleaves our SENT outbound
  // messages and the creator's inbound messages chronologically.
  //
  // PLU-85: the transcript is now sourced from `Message` rows (what was actually
  // communicated), not from `NEGOTIATION_TURN` event payloads (the AI's decision-
  // step drafts). `allInboundSource` already holds BOTH directions (it's the full
  // message list for the instance), so no new query is needed. `priorEvents` is
  // passed only to ENRICH each sent outbound entry with round/action/rate — the
  // events themselves remain the separate decision history (priorContext above).
  // Empty on the first negotiation turn, so first-contact copy is unchanged.
  const draftHistory = buildDraftHistory(allInboundSource, brandReplyMsgIds, priorEvents);

  // PLU-111: load this instance's NON-TERMINAL obligations ONCE, up front. The
  // outstanding Pluvus commitments feed BOTH /negotiate (below) and /draft (§4.7,
  // O6); the open questions + the write-plan are derived after the model returns
  // (they depend on this turn's creatorQuestions). Empty for pre-existing / fresh
  // instances → every downstream use no-ops and falls back to today's behavior.
  const openObligationRows = await listOpenObligationsByInstance(instance.id);
  const ledgerSplit = buildOpenObligations(openObligationRows);
  const openCommitments = ledgerSplit.openCommitments;

  // F-H1: thread that SAME full both-sides transcript into the money-decision
  // model (not just the copywriter). The negotiator previously saw only our-side
  // moves (`priorContext.history`) + the single latest inbound line, so it was
  // blind to the creator's EARLIER words — prior anchors, firm positions,
  // concession trajectory. Reusing `draftHistory` (already assembled above) gives
  // it the creator's own turns too. Empty on the first turn → no change to
  // first-contact behavior. `buildNegotiationRequest` only attaches it when
  // non-empty, and the agent renders it as a sanitized <conversation_history>
  // DATA block, so the money guards and injection defenses are unaffected.
  //
  // PLU-111 (O6): openCommitments ride along as sanitized DATA so the negotiator
  // knows it owes an action — NEVER a money input. Attached only when non-empty.
  //
  // classify→negotiate hint: the first-reply classifier's intent for the reply
  // being negotiated (persisted on the inbound Message row). Threaded as a SOFT
  // advisory signal only — never a money input, never an override of the guards. A
  // mid-negotiation reply (round >= 1) skips classify so replyIntent is null there;
  // NEGATIVE/OPT_OUT never reach negotiation (routed terminal upstream). Attached
  // only when present so the prompt renders exactly as before otherwise.
  const classifiedIntent =
    typeof latestInbound?.replyIntent === "string" ? latestInbound.replyIntent : undefined;

  // HARD-K1 / PLU-107: parse the campaign brief PDF (once per run, cached by
  // ref::parserVersion) into text the models can consult to answer a creator's
  // question from real campaign data instead of inventing it.
  //
  // ORDERING FIX (§3): resolve the brief BEFORE agent.negotiate so its text can be
  // threaded into the DECISION model too (not only the copywriter). The resolver
  // never throws; a no-brief/unreadable brief degrades to flatText "" + a status.
  //
  // Conflict detection (§4.5): the four authoritative Campaign knowledge columns
  // are already merged onto `config` (mergeCampaignFallback / BRAND_KEYS), so we
  // hand them to the resolver to surface any material brief-vs-Campaign conflict.
  const resolvedBrief = await resolveBriefKnowledge(nodeGraph, {
    usageRights: typeof config["usageRights"] === "string" ? config["usageRights"] : undefined,
    exclusivity: typeof config["exclusivity"] === "string" ? config["exclusivity"] : undefined,
    paymentTerms: typeof config["paymentTerms"] === "string" ? config["paymentTerms"] : undefined,
    attributionWindow:
      typeof config["attributionWindow"] === "string" ? config["attributionWindow"] : undefined,
  });
  const briefKnowledge = resolvedBrief.flatText;

  // §4.9 / §4.10: thread the brief into the DECISION model as source-of-truth for
  // knowledge answers. Made available when EITHER the BRIEF_INTO_NEGOTIATE sub-flag
  // is on (the PLU-107 whole-blob interim, de-risked independently §6) OR retrieval
  // is on (PLU-114). The retrieval case is why: the agent's §4.2 flat-brief safety
  // net (_has_flat_brief) reads ctx["briefKnowledge"] to fall back to the blob
  // instead of emitting a false defer when a matched section is unavailable — so the
  // blob must reach the router regardless of that separate sub-flag, exactly as the
  // flat FIELDS / briefSections / obligations below already do. The agent still
  // applies the §4.10 knowledge-turn cost gate (renders the block only on knowledge
  // questions) AND, with retrieval on, only surfaces the blob on the FALLBACK path
  // (a confident match renders selected sections, never the blob). Both flags off →
  // /negotiate prompt byte-identical to today (invariant #9). The brief is reference
  // DATA on this endpoint too — NEVER a money input (guards unchanged; a brief
  // number can't move the fee).
  const negotiateBrief =
    (briefIntoNegotiateEnabled() || knowledgeRetrievalEnabled()) && briefKnowledge
      ? briefKnowledge
      : undefined;

  // PLU-114 (§4.9 / §5, REVIEW #1+#2): the two structured INPUTS the agent-side
  // knowledge router needs but which do NOT reach it today — the parsed brief
  // SECTIONS (not just the flat blob) and the open obligations WITH their category.
  // Both are threaded as ADDITIVE campaignContext keys (old callers ignore them),
  // and the agent applies KNOWLEDGE_RETRIEVAL_ENABLED itself — so with the agent
  // flag OFF these keys are inert (the new selected-knowledge block never renders)
  // and both prompts are byte-identical to today. Threaded independently of
  // BRIEF_INTO_NEGOTIATE: the router resolves values from the flat FIELDS too, so
  // it must see sections/obligations regardless of that separate sub-flag.
  //
  //   briefSections — resolvedBrief.sections projected to {sectionKey: text}. The
  //     router resolves a brief-sourced value from this; only present when the
  //     structured parse produced sections (STRUCTURED_BRIEF_PARSING_ENABLED on +
  //     an ok parse), else omitted → the router falls back to flat fields.
  //   structuredObligations — {id, originalText, category} per non-terminal row,
  //     so an open obligation pulls in the section it's on the hook to answer even
  //     when this turn's message is silent on it (invariant #5).
  const briefSections = projectBriefSections(resolvedBrief.sections);
  const structuredObligations = buildStructuredObligations(openObligationRows);

  // PLU-114 REVIEW #1 (Calvin follow-up W1): the four authoritative flat knowledge
  // fields must reach the negotiate router too. Today they only feed conflict
  // detection above (resolveBriefKnowledge :590-594) and reach /draft (via
  // draftConfig = {...config}) but are NEVER placed on the negotiate campaignContext
  // — so the negotiate router resolves a *configured* term to
  // requested_but_unavailable and steers the model to defer a known answer, an
  // asymmetry with /draft. Resolve them from `config` the same way /draft does and
  // spread them onto knowledgeContext as additive string keys. Inert with the agent
  // flag OFF (the selected-knowledge block never renders), and threaded
  // independently of BRIEF_INTO_NEGOTIATE (the router resolves from the flat FIELDS,
  // not the brief blob, so it must see them regardless of that sub-flag).
  //
  // Guardrail: these are REFERENCE DATA only. campaignContext is documented as
  // "NEVER a money input" (providers.ts) — adding four string fields does not change
  // that; the guards and fee path are untouched. Kept on campaignContext (alongside
  // the other knowledge keys), NOT campaignConstraints (which feeds band/decision).
  const flatKnowledge = projectFlatKnowledge(config);

  const knowledgeContext: Record<string, unknown> = {
    ...flatKnowledge,
    ...(negotiateBrief ? { briefKnowledge: negotiateBrief } : {}),
    ...(briefSections ? { briefSections } : {}),
    ...(structuredObligations.length ? { structuredObligations } : {}),
  };

  const negotiationContext: PriorNegotiationContext = {
    ...priorContext,
    ...(draftHistory.length ? { conversationHistory: draftHistory } : {}),
    ...(openCommitments.length ? { openCommitments } : {}),
    ...(classifiedIntent ? { intent: classifiedIntent } : {}),
    ...(Object.keys(knowledgeContext).length ? { campaignContext: knowledgeContext } : {}),
  };

  // creatorQuestions / pushedFixedTerms: the comprehension /negotiate already did
  // (the creator's questions + which fixed terms they pushed), threaded across
  // the seam so /draft answers an explicit checklist instead of re-parsing the
  // raw reply (spec §6.1). Undefined in rules mode → the `?? []` spreads below
  // become no-ops, preserving current behavior.
  //
  // creatorRequestedRate (MED-N3): the creator's own stated ask as COMPREHENDED
  // by the /negotiate model and substring-validated in the agent (digits must
  // appear in the reply; ranges rejected). This — not the local regex — is what
  // feeds the MONEY path (context.creatorRate on a brand decision, which a brand
  // APPROVE records as the deal rate). The regex remains a fallback for copy
  // acknowledgment and guard allowlisting only.
  const { outcome, message, proposedRate, creatorQuestions, pushedFixedTerms, creatorRequestedRate, escalationReason, isFinalRound, negotiatorAnswers } =
    await agent.negotiate(instance.negotiationRound, config, creatorReply, negotiationContext);

  // For acknowledgment copy + the output-guard allowlist (NOT the money path):
  // prefer the agent's validated comprehension, fall back to the regex read.
  const ackRequestedRate = creatorRequestedRate ?? extractRequestedRate(creatorReply);

  // HARD-K1: the SAME brief flat text is threaded into the draft's campaignContext
  // as `briefKnowledge` (the /draft FALLBACK role, §4.9) — kept exactly as today so
  // rules-mode / guard-nulled turns still answer from the brief. "" when there's no
  // brief or it can't be read (soft-degrade).
  //
  // PLU-114 (§5): the SAME two structured inputs threaded into /negotiate above are
  // added to draftConfig so the agent's knowledge router runs identically on the
  // /draft endpoint (the whole draftConfig becomes DraftRequest.campaignContext via
  // stripBandFromContext). Added as keys (not a nested object) so they survive the
  // band strip untouched. Inert with the agent flag OFF — the DraftRequest ignores
  // unknown campaignContext keys and the selected-knowledge block never renders, so
  // /draft is byte-identical to today.
  const draftConfig: Record<string, unknown> = {
    ...config,
    ...(briefKnowledge ? { briefKnowledge } : {}),
    ...(briefSections ? { briefSections } : {}),
    ...(structuredObligations.length ? { structuredObligations } : {}),
  };

  // PLU-107 observability (§4.8): a material brief-vs-Campaign conflict is surfaced
  // (not resolved) so PLU-82 / a human can act on it. Log a compact record; the
  // section VALUES are not logged (keys/pages/reason only) — the operator sees the
  // values in the inspector's operator-gated Knowledge panel, never in stdout
  // (§4.6 / §8-j).
  if (resolvedBrief.conflicts && resolvedBrief.conflicts.length) {
    console.warn(
      `[briefKnowledge] material brief-vs-Campaign conflict(s) on instance ${instance.id}: ` +
        resolvedBrief.conflicts
          .map((c) => `${c.section}(${c.reason}${c.pageStart ? `, p${c.pageStart}` : ""})`)
          .join("; "),
    );
  }

  // PLU-82 §4.6: the compact KNOWLEDGE observability record folded onto THIS turn's
  // NEGOTIATION_TURN payload (one per round — a BullMQ retry recomputes the same
  // record under OCC, so the audit log never bloats, §8-e). Ships UNFLAGGED: it is
  // pure surfacing (invariant #9 / §6) — the escalation FLAG gates only the routing
  // decision (§4.5). No new EventType/table (invariant #10); it rides the existing
  // payload. Byte-identical to a real DEAL — this adds only debug keys.
  //
  //   briefAvailability — the four-state result (§4.4). expectedSections = the
  //     authoritative Campaign knowledge fields the campaign actually declared
  //     (∩ the conflict keys) so a term the campaign never set never makes the
  //     brief read PARTIAL forever.
  //   knowledgeConflicts — the FULL conflict rows (field/reason/page + the
  //     campaignValue/briefExcerpt) so the operator-gated panel can show both
  //     disagreeing sources. Values ride the payload (persisted, operator-only via
  //     the /observability gate) but are NEVER logged to stdout (above).
  const CONFLICT_KEYS = ["usageRights", "exclusivity", "paymentTerms", "attributionWindow"] as const;
  const expectedSections = CONFLICT_KEYS.filter(
    (k) => typeof config[k] === "string" && (config[k] as string).trim(),
  );
  const briefAvailability = deriveBriefAvailability(resolvedBrief, expectedSections);
  const knowledgeConflicts: BriefFieldConflict[] = resolvedBrief.conflicts ?? [];
  // Fold onto the turn payload only when there is something to report — a fully
  // available brief with no conflicts adds nothing (keeps the payload minimal and
  // "byte-identical when nothing to say"). AVAILABLE + no conflicts ⇒ omitted.
  const knowledgeRecord: Record<string, unknown> =
    knowledgeConflicts.length || briefAvailability.status !== "AVAILABLE"
      ? {
          knowledge: {
            briefAvailability,
            ...(knowledgeConflicts.length ? { conflicts: knowledgeConflicts } : {}),
          },
        }
      : {};

  // PLU-111: the durable obligation ledger (loaded above) supersedes the event-
  // diff as the source of "what creator questions are still open". FALLBACK
  // (invariant #6, §4.7): when the ledger has NO rows for this instance (a
  // pre-existing/old instance created before this feature, or a genuinely empty
  // table), fall back to computeOpenQuestions so behavior is byte-identical to
  // today. The ledger's ANSWERED rows have already dropped out, so a still-open
  // question surfaces here and an answered one does not.
  let openQuestions: string[];
  if (openObligationRows.length > 0) {
    const seen = new Set<string>();
    openQuestions = [];
    for (const q of ledgerSplit.openQuestions) {
      const k = q.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      openQuestions.push(q);
    }
  } else {
    // Empty ledger → today's HARD-N2 event-diff behavior, byte-identical.
    openQuestions = computeOpenQuestions(priorEvents, creatorQuestions);
  }

  // PLU-111 (§4.4): the create/update plan for THIS turn's creator questions
  // against the existing open rows (pure; applied in-tx by the runtime, §4.6).
  // Built even when the ledger was previously empty — this is what starts
  // populating it. The reserve-time resolution link is attached per-branch below,
  // once we know the reserved outbound messageId.
  const questionPlan = buildQuestionObligationPlan(
    creatorQuestions,
    openObligationRows,
    detectObligationCategory,
  );

  // drafting-humanization (§Conversation State): the two STYLE hints threaded into
  // /draft so the offer copy states deltas (not full state) and warms up across the
  // thread. Both are purely stylistic — the money decision above already ran and
  // never reads them — and both default so an unset value renders as today.
  //   changedFields — "fee" when the rate we're presenting is new/changed vs our
  //     last offer; [] when unchanged (agent then omits the delta hint). Uses
  //     proposedRate, the number this turn actually puts on the table.
  //   relationshipWarmth — from the round + a cheap cooperativeness read. The
  //     creator "moved toward us" when their current ask is at or below the rate we
  //     last offered (they've met us or come under). ackRequestedRate is the
  //     agent's validated read of their ask (regex fallback), and currentOffer is
  //     our last standing number — both already computed above, no extra work.
  const changedFields = computeChangedFields(priorContext, proposedRate);
  const creatorMovedToward =
    ackRequestedRate !== undefined &&
    priorContext.currentOffer !== undefined &&
    ackRequestedRate <= priorContext.currentOffer;
  const relationshipWarmth = computeRelationshipWarmth({
    round: instance.negotiationRound,
    maxRounds,
    priorTurnCount: priorContext.history.length,
    creatorMovedToward,
  });

  // Shared HARD-N2 / PLU-111 + humanization draft context threaded into every
  // draftEmail call this turn. openCommitments is additive (PLU-111);
  // changedFields/relationshipWarmth are the humanization style hints, only
  // meaningful on the offer purposes (counter/accept/present) — the branches
  // below spread this into exactly those. Empty changedFields is omitted so the
  // request stays minimal; every field defaults so the copy is unchanged when unset.
  const draftHistoryExtra = {
    ...(draftHistory.length ? { history: draftHistory } : {}),
    ...(openQuestions.length ? { openQuestions } : {}),
    ...(openCommitments.length ? { openCommitments } : {}),
    ...(changedFields.length ? { changedFields } : {}),
    relationshipWarmth,
    // Option A (negotiate→draft answer sync): thread the negotiator's OWN vetted
    // answers into the copy so it rephrases them instead of re-deriving (and
    // hallucinating) answers from raw facts. Present ONLY when the agent returned a
    // genuine advisory draft — the mapper sets negotiatorAnswers only when the LLM
    // strategy ran AND the guards did NOT null responseDraft, so a guard-altered
    // decision (or rules mode) threads nothing and the copy renders exactly as
    // before. Spread only when non-empty to keep the request minimal. Renders in the
    // offer/onboarding prompts (the answer-bearing purposes); a no-op elsewhere.
    ...(negotiatorAnswers && negotiatorAnswers.trim() ? { negotiatorAnswers } : {}),
  };

  // The reserve-time obligation writes shared across the send branches. The
  // runtime applies these in-tx; `reservedResolutionMessageId` is filled from the
  // branch's reserved outbound messageId. sourceMessageId is the inbound row that
  // raised the questions. Escalation ids are attached only on the escalate path.
  const buildObligationWrites = (
    reservedMessageId: string | undefined,
  ): NonNullable<NodeResult["obligationWrites"]> => ({
    questionPlan,
    ...(latestInbound?.id ? { sourceMessageId: latestInbound.id } : {}),
    ...(reservedMessageId ? { reservedResolutionMessageId: reservedMessageId } : {}),
  });

  // PLU-82 §4.5 — MATERIAL-CONFLICT ESCALATION (flag-gated, POST-model).
  //
  // Placed HERE (after the model, before switch(outcome)) because the gate needs
  // this turn's creatorQuestions / pushedFixedTerms — a brief-vs-Campaign conflict
  // exists on every turn from round 0 regardless of the creator, so we can only
  // escalate the "unsupported automated answer" case once we know what the creator
  // actually asked (invariant #7, §8-b). All of:
  //   - the flag is on (default OFF → today's behavior);
  //   - a conflict was detected (inert unless STRUCTURED_BRIEF_PARSING is on
  //     agent-side → resolvedBrief.conflicts non-empty, invariant #9);
  //   - the agent did NOT itself escalate (defer to the topic gate's reason —
  //     usage_rights_or_licensing / undefined_terms already always-escalate with a
  //     specific reason BEFORE any conflict logic, invariant #8);
  //   - the conflict is on a creator-commitment field the creator asked about this
  //     turn or has an open obligation on (the gate, invariant #7).
  // On a match → MANUAL_REVIEW with reason material_knowledge_conflict; the open
  // obligations move to ESCALATED (escalateAfterWrite) so a later silent turn does
  // not re-escalate on the same stale obligation (no-loop, §8-g). Detection +
  // observability already ran above (unflagged) — this is only the routing decision.
  if (materialConflictEscalationEnabled() && outcome !== "escalate") {
    const matchedFields = conflictAffectsCreatorCommitment(
      resolvedBrief.conflicts ?? [],
      creatorQuestions,
      pushedFixedTerms,
      openObligationRows,
    );
    if (matchedFields.length) {
      return {
        ...escalateMaterialConflict({
          round: instance.negotiationRound,
          message: creatorReply,
          conflictFields: matchedFields,
          conflicts: resolvedBrief.conflicts ?? [],
        }),
        // Parity with the escalate case: record this turn's questions AND move every
        // open obligation to ESCALATED (non-terminal, stays in AI context + visible
        // to the operator). No send happens → no resolution link. This is also the
        // no-loop mechanism (§8-g).
        obligationWrites: {
          ...buildObligationWrites(undefined),
          escalateAfterWrite: true,
        },
      };
    }
  }

  switch (outcome) {
    case "present_offer": {
      // The creator ASKED about terms (no number proposed). Present the fee
      // (+ commission) as information and wait for their actual response —
      // normally WITHOUT consuming a negotiation round. A curious creator's
      // questions must not exhaust the negotiation budget. We reuse the
      // offer-presenting draft (counter_offer purpose) so the email states the
      // fixed fee and, for a hybrid deal, the commission.
      //
      // MED-W3: but "free" present_offers cannot be UNBOUNDED — a persistently
      // curious creator (or a model mislabeling proposals) would loop forever,
      // each turn an LLM call (cost + abuse vector). After
      // MAX_FREE_PRESENT_OFFERS consecutive present-offer turns without
      // progress, each further one COUNTS toward the round budget, so the
      // existing max-rounds machinery (B9 brand decision) bounds the loop.
      const trailingPresents = countTrailingPresentOffers(priorContext.history);
      const presentConsumesRound = trailingPresents >= MAX_FREE_PRESENT_OFFERS;
      const presentRound = presentConsumesRound
        ? instance.negotiationRound + 1
        : instance.negotiationRound;
      const aiDraft = await agent.draftEmail("counter_offer", creator, draftConfig, {
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(ackRequestedRate !== undefined ? { creatorRequestedRate: ackRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
        // §6.2: thread the comprehension into /draft so the SENT email answers
        // every question and acknowledges any pushed fixed term.
        ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
        // HARD-N2: conversation transcript + earlier-round unanswered questions.
        ...draftHistoryExtra,
      });
      // A present-offer email PRESENTS concrete terms. When the REAL AI copy
      // generator returns null it means generation failed after retries — escalate
      // to a human rather than send the sparse negotiate responseDraft that only
      // quotes a fee. (For the mock provider, null just means "use the template";
      // that path keeps the existing fallback so mock-mode dev/harnesses work.)
      if (aiDraft === null && agent.generatesDraftCopy) {
        // PLU-111: record this turn's questions (open, unresolved) but attach NO
        // resolution link — a failed draft must not mark a question answered.
        return { ...draftUnavailable(instance.negotiationRound, "present_offer"), obligationWrites: buildObligationWrites(undefined) };
      }
      const body = aiDraft?.body ?? message;
      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: the presented fee is allowlisted; still scan for floor/ceiling leak.
      // The creator's own stated ask is allowlisted too (echoing their number is
      // not a leak even if it coincides with a bound).
      const guard = scanOutboundDraft(
        draft,
        guardConstraintsFromConfig(config, proposedRate, ackRequestedRate),
      );
      if (!guard.ok) {
        return { ...blockedByGuard(instance.negotiationRound, guard.hits), obligationWrites: buildObligationWrites(undefined) };
      }

      // Idempotent send keyed on (instance, present, round, inbound message id).
      // MED-W2: PRESENT_OFFER deliberately doesn't consume a round, so a
      // creator's SECOND question at the same round is a distinct reply that
      // must get its own email — keying on the round alone deduped it into
      // silence. The message id is unique per reply, so each question gets an
      // answer while a worker retry of the SAME reply still cannot double-send.
      const presentKey = latestInbound
        ? `negotiation:present:${instance.id}:${instance.negotiationRound}:${latestInbound.id}`
        : `negotiation:present:${instance.id}:${instance.negotiationRound}`;
      // Reserve now, defer the send (§4.1, §4.3a): the runtime enqueues the
      // delayed flush after this turn's OCC commit.
      const present = await reserveAiReply(instance.id, draft, presentKey);

      // Back to AWAITING_REPLY at the SAME node. The round is unchanged on a
      // "free" present turn; past the MED-W3 cap it advances so the loop is
      // bounded by max-rounds.
      return {
        nextState: "AWAITING_REPLY",
        nextNodeId: node.id,
        ...(presentConsumesRound ? { negotiationRound: presentRound } : {}),
        ...(present.deferredSend ? { deferredSend: present.deferredSend } : {}),
        // PLU-111: create/update this turn's question obligations and LINK the
        // reserved reply as their intended resolver (§4.5 step 1). The ANSWERED
        // transition fires later, at flush, only if the row actually sends.
        obligationWrites: buildObligationWrites(present.deferredSend?.messageId),
        eventType: "NEGOTIATION_TURN",
        eventPayload: {
          outcome: "present_offer",
          round: presentRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
          // Randomized Send Delay (§9): the drawn delay, labeled *scheduled* not
          // *sent* — delivery proof is Message.externalMessageId/sentAt.
          sendScheduledInMs: present.sendScheduledInMs,
          // HARD-N2: persist this turn's creator questions so a future turn's
          // answered-questions ledger can tell what was asked earlier.
          ...(creatorQuestions?.length ? { creatorQuestions } : {}),
          ...(presentConsumesRound
            ? { consumedRound: true, consecutivePresentOffers: trailingPresents + 1 }
            : {}),
          // PLU-82 §4.6: fold the knowledge observability record onto this turn.
          ...knowledgeRecord,
        },
      };
    }

    case "accept": {
      // A post-acceptance email node (Content Brief in the merged flow, or legacy
      // Reward Setup) owns the post-acceptance email. Skip the negotiation's own
      // onboarding/acceptance send entirely and just transition to ACCEPTED; the
      // downstream node then sends the single, properly formatted email (merged
      // brief, or the "Campaign Agreement Confirmation" for legacy graphs). The
      // agreed rate is persisted on the NEGOTIATION_TURN payload so resolveAgreedFee
      // can recover it as the finalized offer.
      if (hasPostAcceptEmailNode) {
        return {
          nextState: "ACCEPTED",
          nextNodeId: null,
          completedAt: new Date(),
          eventType: "NEGOTIATION_TURN",
          // PLU-111: still record this turn's questions on the ledger. No email is
          // sent from this branch (a downstream node owns it), so there is no
          // resolution link — the questions stay OPEN until a later sent reply
          // answers them (or the downstream node's send does, once it too is
          // wired). Conservative: never resolve without a real send.
          obligationWrites: buildObligationWrites(undefined),
          eventPayload: {
            outcome,
            round: instance.negotiationRound,
            message,
            ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
            // PLU-82 §4.6: fold the knowledge observability record onto this turn.
            ...knowledgeRecord,
          },
        };
      }

      // An ACCEPT now always carries a real agreed rate (the agent only
      // returns accept when a concrete number is on the table — a bare "I'm
      // interested" with no number counters instead). On a genuine, money-
      // confirmed acceptance we send the ONBOARDING email — it confirms the
      // agreed rate and lays out next steps (contract, deliverables, timeline,
      // payment) — rather than a generic "we accept" note. proposedTerms.rate
      // gives the onboarding copy the exact agreed figure.
      // Defensive fallback: if (somehow) no rate is present, fall back to the
      // plain acceptance copy so we never send onboarding with a blank rate.
      const purpose = proposedRate !== undefined ? "onboarding" : "acceptance";
      // §6.3 parity: same creatorRequestedRate the counter branch has (also used
      // by the guard below), so an acceptance can acknowledge the creator's own
      // number where relevant.
      const extra = {
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(ackRequestedRate !== undefined ? { creatorRequestedRate: ackRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
        // §6.2: thread the comprehension into /draft (this branch runs only on
        // legacy graphs without a post-accept email node; on merged flows the
        // downstream Content Brief node owns the email and this is skipped).
        ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
        // HARD-N2: conversation transcript + earlier-round unanswered questions.
        ...draftHistoryExtra,
      };
      const aiDraft = await agent.draftEmail(purpose, creator, draftConfig, extra);
      // The acceptance/onboarding email confirms the agreed rate and lays out
      // next steps — too important to degrade to the sparse fallback. When the
      // REAL AI generator returns null (retries exhausted), escalate to a human.
      // (Mock null → keep the template fallback so harnesses still close deals.)
      if (aiDraft === null && agent.generatesDraftCopy) {
        return { ...draftUnavailable(instance.negotiationRound, purpose), obligationWrites: buildObligationWrites(undefined) };
      }
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: scan the rendered draft for leaked floor/ceiling before sending.
      // The agreed rate is allowlisted (it is the offer we mean to present), and
      // so is the creator's own stated ask — an acceptance at the ceiling/floor
      // (their number == a bound) must be able to state that number.
      const guard = scanOutboundDraft(
        draft,
        guardConstraintsFromConfig(config, proposedRate, ackRequestedRate),
      );
      if (!guard.ok) {
        return { ...blockedByGuard(instance.negotiationRound, guard.hits), obligationWrites: buildObligationWrites(undefined) };
      }

      // FIX-11 + §4.1: reserve the acceptance/onboarding email keyed on
      // (instance, acceptance, round); the runtime defers the send post-commit.
      const accept = await reserveAiReply(
        instance.id,
        draft,
        `negotiation:acceptance:${instance.id}:${instance.negotiationRound}`,
      );

      return {
        nextState: "ACCEPTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        ...(accept.deferredSend ? { deferredSend: accept.deferredSend } : {}),
        // PLU-111: the onboarding/acceptance email answers this turn's questions —
        // link it so they resolve on send (§4.5).
        obligationWrites: buildObligationWrites(accept.deferredSend?.messageId),
        // Persist the agreed rate (FIX-2) so it is recoverable for audit and
        // for threading as currentOffer on any subsequent turn.
        eventPayload: {
          outcome,
          round: instance.negotiationRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
          // §9: drawn delay, *scheduled* not *sent*.
          sendScheduledInMs: accept.sendScheduledInMs,
          // PLU-82 §4.6: fold the knowledge observability record onto this turn.
          ...knowledgeRecord,
        },
      };
    }

    case "reject": {
      return {
        nextState: "REJECTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: {
          outcome,
          round: instance.negotiationRound,
          message,
          // PLU-82 §4.6: fold the knowledge observability record onto this turn.
          ...knowledgeRecord,
        },
      };
    }

    case "escalate": {
      // V1 (#14): the agent escalated — either because the creator's ask is above
      // the internal ceiling / unreadable (reason "escalated"), OR because a
      // Phase E always-escalate topic fired (reason = the topic, threaded here).
      // Either way escalation is a clean one-way handoff — route to MANUAL_REVIEW
      // (terminal). runtime emails the brand an FYI and the conversation surfaces
      // in the Manual Queue; a human takes over out-of-band. MED-N3: the creator's
      // ask recorded for Manual Queue context is the model's validated extraction.
      const escalateResult = escalateOverCeiling({
        round: instance.negotiationRound,
        message,
        creatorRate: creatorRequestedRate,
        escalationReason,
      });
      // PLU-111 (§4.2): record this turn's questions AND move every open
      // obligation for this instance to ESCALATED (non-terminal) — nothing is
      // lost, they stay in the AI context and are visible to the operator. No
      // send happens on an escalate, so there's no resolution link.
      return {
        ...escalateResult,
        obligationWrites: {
          ...buildObligationWrites(undefined),
          escalateAfterWrite: true,
        },
      };
    }

    case "counter": {
      const newRound = instance.negotiationRound + 1;

      // Secondary guard: incrementing would hit or exceed maxRounds. We can't send
      // another counter that can't be replied to within the allowed window — so
      // this IS the max-rounds moment (#15): the negotiation failed to converge
      // within the round budget, so auto-CLOSE (courteous close email → REJECTED),
      // same as the entry hard stop above. Previously this paged the brand; #14
      // removed that loop. EASY-W1: `maxRounds <= 0` = unlimited (consistent with
      // the entry hard stop).
      if (maxRounds > 0 && newRound >= maxRounds) {
        const rejectResult = await maxRoundsReject(ctx, email, config, {
          maxRounds,
          // Report the ceiling round we've reached, not a half-advanced counter.
          round: maxRounds,
          // MED-N3: post-agent, so the audit payload records the model's validated
          // extraction of the creator's ask (never the regex).
          creatorRate: creatorRequestedRate,
        });
        // PLU-111: record this turn's questions (open). The courteous close email
        // is a REJECT — it does NOT answer questions — so no resolution link. They
        // remain visible to a human even though the run auto-closes.
        return { ...rejectResult, obligationWrites: buildObligationWrites(undefined) };
      }

      // Try AI-generated counter copy; fall back to agent-provided message.
      // Pass the concrete rate we're countering with so the draft anchors on
      // THAT number ($350) instead of reaching for the budget range — which the
      // output guard would (correctly) block as a floor/ceiling leak. Also
      // thread the creator's reply + the rate they asked for so the counter
      // acknowledges their request ("we considered your $480 …") and reads like
      // an ongoing conversation rather than a cold first contact.
      const counterExtra = {
        round: newRound,
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(ackRequestedRate !== undefined ? { creatorRequestedRate: ackRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
        // §6.2: thread the comprehension into /draft so the counter email answers
        // every question and acknowledges any pushed fixed term (Case-10 gap).
        ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
        // Q3 (founder, autonomous launch): on the LAST round the counter email
        // states finality ("this is our final rate; no further negotiation"). A
        // counter IS the offer the creator can accept or decline; a decline/no-
        // reply then leads to the auto-close the executor already does, so telling
        // them it's final is essential — otherwise they expect another round.
        ...(isFinalRound ? { isFinalRound: true } : {}),
        // HARD-N2: conversation transcript + earlier-round unanswered questions.
        ...draftHistoryExtra,
      };
      const aiDraft = await agent.draftEmail("counter_offer", creator, draftConfig, counterExtra);
      // The counter email presents the fee + commission + deliverables and
      // should answer the creator's questions. When the REAL AI generator returns
      // null (retries exhausted), escalate to a human — do NOT send the sparse
      // negotiate responseDraft (the "$350.0" one-liner that ignored the
      // creator's questions). The round was NOT yet advanced (that only happens
      // on a successful send below), so a human picks up at the same point.
      // (Mock null → keep the template fallback so mock-mode counters still send.)
      if (aiDraft === null && agent.generatesDraftCopy) {
        return { ...draftUnavailable(newRound, "counter_offer"), obligationWrites: buildObligationWrites(undefined) };
      }
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: scan the rendered counter draft for leaked floor/ceiling before
      // sending. The rate we are countering with is allowlisted, AND so is the
      // creator's own stated ask — echoing a number they gave us (even one that
      // coincides with a bound, e.g. their $500 ask == the $500 ceiling) is not
      // a leak, so a legitimate at-bound negotiation isn't forced to MANUAL_REVIEW.
      const guard = scanOutboundDraft(
        draft,
        guardConstraintsFromConfig(config, proposedRate, ackRequestedRate),
      );
      if (!guard.ok) {
        return { ...blockedByGuard(newRound, guard.hits), obligationWrites: buildObligationWrites(undefined) };
      }

      // FIX-11 + §4.1: reserve the counter email keyed on (instance,
      // counter_offer, newRound); the runtime defers the send post-commit.
      const counter = await reserveAiReply(
        instance.id,
        draft,
        `negotiation:counter_offer:${instance.id}:${newRound}`,
      );

      return {
        nextState: "AWAITING_REPLY",
        nextNodeId: node.id,
        negotiationRound: newRound,
        ...(counter.deferredSend ? { deferredSend: counter.deferredSend } : {}),
        // PLU-111: the counter email answers this turn's questions — link it as
        // their intended resolver; they resolve to ANSWERED only on send (§4.5).
        obligationWrites: buildObligationWrites(counter.deferredSend?.messageId),
        eventType: "NEGOTIATION_TURN",
        // Persist the rate we just countered with (FIX-2) so the next turn knows
        // its own last offer instead of falling back to the floor.
        eventPayload: {
          outcome,
          round: newRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
          // §9: drawn delay, *scheduled* not *sent*.
          sendScheduledInMs: counter.sendScheduledInMs,
          // HARD-N2: persist this turn's creator questions for the answered-
          // questions ledger on any subsequent turn.
          ...(creatorQuestions?.length ? { creatorQuestions } : {}),
          // PLU-82 §4.6: fold the knowledge observability record onto this turn.
          ...knowledgeRecord,
        },
      };
    }
    default: {
      // H7: exhaustiveness backstop on a MONEY path. `outcome` is typed as the
      // NegotiateOutcome union, so assigning it to `never` here makes tsc flag
      // this switch if a new outcome is added without a case. At RUNTIME, though,
      // `outcome` arrives across the agent HTTP seam: a future/garbled value that
      // slips the adapter's validation would otherwise fall off the end of this
      // function and return `undefined`, silently breaking the NodeResult
      // contract. Escalate to a human instead — never guess a money state.
      // Mirrors mapNegotiationResponse's own default arm. The `String(outcome)`
      // read of the `never`-typed value is what keeps the exhaustiveness check
      // live without a throwaway assignment.
      return escalateOverCeiling({
        round: instance.negotiationRound,
        message: `Unrecognized negotiation outcome "${String(outcome as never)}" — routed to a human.`,
        creatorRate: creatorRequestedRate,
      });
    }
  }
}
