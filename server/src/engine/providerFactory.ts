import type { Creator } from "../db/schema.js";
import { llmSafeCreatorContext } from "../validation/llmSafeCreator.js";
import {
  MockEmailProvider,
  MockAgentProvider,
  buildNegotiationRequest,
  mapNegotiationResponse,
  type IEmailProvider,
  type IAgentProvider,
  type MockAgentOptions,
} from "./providers.js";
import { NylasEmailProvider } from "../providers/nylas/nylasEmailProvider.js";
import { LangGraphClassificationProvider } from "../adapters/classification/LangGraphClassificationProvider.js";
import { MockClassificationProvider } from "../adapters/classification/MockClassificationProvider.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import { LangGraphNegotiationProvider } from "../adapters/negotiation/LangGraphNegotiationProvider.js";
import { MockNegotiationProvider } from "../adapters/negotiation/MockNegotiationProvider.js";
import type { NegotiationProvider } from "../adapters/negotiation/NegotiationProvider.js";
import type { NegotiationTerm, DraftHistoryEntry, CreatorMemoryPayload } from "../adapters/negotiation/types.js";
import type {
  ClassifyResult,
  NegotiateResult,
  EmailDraft,
  PriorNegotiationContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default AI-provider mode (C1)
// ---------------------------------------------------------------------------
// The classification and negotiation providers previously defaulted to `mock`,
// which meant a process started WITHOUT the provider env vars (a misconfigured
// deploy, or `npm start` with no .env) silently ran ZERO LLM logic on a money
// path — MockNegotiationProvider fabricates rates from a hardcoded base and
// MockClassificationProvider is keyword-only with no injection/rate/opt-out
// parity. That is a production hazard, not a safe fallback.
//
// New default is env-aware:
//   * Under NODE_ENV=test  → `mock` (unit tests and CI stay hermetic; no network).
//   * Otherwise            → `langgraph` (real deploys use the real agent),
//                            and if a real run ever DOES fall back to mock we log
//                            a loud warning so the misconfiguration is visible.
//
// Test harnesses (engine/classification/negotiation/webhooks) construct
// Mock*Provider instances DIRECTLY and do not depend on this default, so the
// flip does not affect them.
function isTestEnv(): boolean {
  return (process.env["NODE_ENV"] ?? "").toLowerCase() === "test";
}

/**
 * Resolve the effective AI-provider mode from an explicit env value and the
 * NODE_ENV. Pure so it can be unit-tested without touching process.env.
 *
 *   explicit "langgraph" | "mock"  → used as-is (case-insensitive).
 *   explicit unknown / unset       → default: "mock" under NODE_ENV=test,
 *                                    "langgraph" otherwise.
 */
export function resolveAgentMode(
  explicit: string | undefined,
  nodeEnv: string | undefined,
): "mock" | "langgraph" {
  const e = (explicit ?? "").toLowerCase();
  if (e === "langgraph" || e === "mock") return e;
  return (nodeEnv ?? "").toLowerCase() === "test" ? "mock" : "langgraph";
}

function defaultAgentMode(): "mock" | "langgraph" {
  return isTestEnv() ? "mock" : "langgraph";
}

// Warn (once per kind) when a REAL (non-test) run resolves to the mock AI
// provider — either explicitly or by default. This is almost always a
// misconfiguration: the LLM is not being used at all.
const _mockFallbackWarned = new Set<string>();
function warnIfProdMock(kind: string, choice: string): void {
  if (choice === "mock" && !isTestEnv() && !_mockFallbackWarned.has(kind)) {
    _mockFallbackWarned.add(kind);
    console.warn(
      `[providerFactory] WARNING: ${kind} is running in MOCK mode outside NODE_ENV=test — ` +
        `no LLM is used for this path (rates/intents are rule-based). Set ${kind}=langgraph ` +
        `(and AGENT_SERVICE_URL) for real AI behavior.`,
    );
  }
}

// Warn when an explicit provider env var is set to something we don't recognize
// (a typo like "langraph"). resolveAgentMode() then applies the env-aware
// default; surfacing the typo avoids a silent fallback.
function warnUnknownProvider(kind: string, raw: string | undefined): void {
  if (raw === undefined) return;
  const v = raw.toLowerCase();
  if (v !== "langgraph" && v !== "mock") {
    console.warn(
      `[providerFactory] unknown ${kind}="${raw}" — using the ${defaultAgentMode()} default`,
    );
  }
}

// ---------------------------------------------------------------------------
// Email provider factory
// ---------------------------------------------------------------------------
//   EMAIL_PROVIDER=mock   (default) → MockEmailProvider
//   EMAIL_PROVIDER=nylas            → NylasEmailProvider (reads NYLAS_* env)

export function emailProvider(): IEmailProvider {
  const raw = process.env["EMAIL_PROVIDER"];

  // MED-A1: EMAIL_PROVIDER used to DEFAULT to "mock" even in production, so a
  // deploy that simply forgot to set it would advance the entire funnel while
  // sending ZERO real emails — a silent, funnel-wide outage. Fail fast instead:
  // outside NODE_ENV=test the variable MUST be set explicitly. (In test we
  // default to mock so the suite needs no env.) The classify/negotiate providers
  // already resolve env-aware defaults; email is the one that silently no-op'd.
  if (raw === undefined || raw.trim() === "") {
    if (isTestEnv()) return new MockEmailProvider();
    throw new Error(
      "EMAIL_PROVIDER is not set. Set EMAIL_PROVIDER=nylas (with NYLAS_* env) for " +
        "real email, or EMAIL_PROVIDER=mock to explicitly opt into the no-op mock. " +
        "Refusing to default to mock outside NODE_ENV=test — a misconfigured deploy " +
        "would advance the whole funnel while sending no real emails.",
    );
  }

  const choice = raw.toLowerCase();
  if (choice === "nylas") {
    return new NylasEmailProvider();
  }
  if (choice === "mock") {
    // Explicit opt-in. Warn outside test so a stray EMAIL_PROVIDER=mock in a real
    // deploy is at least visible (parity with warnIfProdMock for AI providers).
    if (!isTestEnv()) {
      console.warn(
        "[providerFactory] EMAIL_PROVIDER=mock outside NODE_ENV=test — no real " +
          "emails will be sent. Set EMAIL_PROVIDER=nylas for real delivery.",
      );
    }
    return new MockEmailProvider();
  }

  // An explicit but unrecognized value (a typo). Don't silently no-op the whole
  // funnel — fail so the typo is caught rather than swallowed to mock.
  throw new Error(
    `Unknown EMAIL_PROVIDER="${raw}". Expected "nylas" or "mock".`,
  );
}

// ---------------------------------------------------------------------------
// Classification provider factory
// ---------------------------------------------------------------------------
//   AGENT_PROVIDER=mock       (default) → MockClassificationProvider (keyword-based)
//   AGENT_PROVIDER=langgraph            → LangGraphClassificationProvider (HTTP to agent service)

export function classificationProvider(): ClassificationProvider {
  const raw = process.env["AGENT_PROVIDER"];
  const mode = resolveAgentMode(raw, process.env["NODE_ENV"]);
  warnUnknownProvider("AGENT_PROVIDER", raw);

  if (mode === "langgraph") {
    return new LangGraphClassificationProvider();
  }
  warnIfProdMock("AGENT_PROVIDER", "mock");
  return new MockClassificationProvider();
}

// ---------------------------------------------------------------------------
// Negotiation provider factory
// ---------------------------------------------------------------------------
//   NEGOTIATION_PROVIDER=mock       (default) → MockNegotiationProvider
//   NEGOTIATION_PROVIDER=langgraph            → LangGraphNegotiationProvider (HTTP to agent service)

export function negotiationProvider(): NegotiationProvider {
  const raw = process.env["NEGOTIATION_PROVIDER"];
  const mode = resolveAgentMode(raw, process.env["NODE_ENV"]);
  warnUnknownProvider("NEGOTIATION_PROVIDER", raw);

  if (mode === "langgraph") {
    return new LangGraphNegotiationProvider();
  }
  warnIfProdMock("NEGOTIATION_PROVIDER", "mock");
  return new MockNegotiationProvider();
}

// ---------------------------------------------------------------------------
// Agent provider adapter
// ---------------------------------------------------------------------------
// Bridges the engine's IAgentProvider interface to the separate
// ClassificationProvider and NegotiationProvider abstractions.
// The negotiate() bridge maps NegotiationAction → legacy NegotiateResult so
// the engine's executor interface is unchanged.
//
// FIX-9 graceful degradation lives HERE (the orchestration seam), not inside the
// strict LangGraph providers — those keep their strict-validation "throw on
// malformed" behavior the audit praised. When the agent service is unreachable
// or the circuit breaker is open, an exception would otherwise propagate to the
// worker and strand the instance (classify → stuck at REPLY_RECEIVED; negotiate
// → BullMQ retry to exhaustion). Instead we degrade to the existing safe seams:
//   classify  → UNKNOWN / confidence 0  → low-confidence gate → MANUAL_REVIEW
//   negotiate → escalate                → executor            → MANUAL_REVIEW
//   draftEmail→ null                    → executor falls back to template copy
// so an agent outage becomes "route to a human", never "lose or strand".

export class AgentProviderAdapter implements IAgentProvider {
  // The real adapter generates LLM copy: a null from draftEmail() means
  // generation failed after retries, so offer/counter turns escalate to a human
  // rather than send fallback copy. (The MockNegotiationProvider.draft never
  // returns null — it produces template copy — so this only fires on a genuine
  // real-generation failure.)
  readonly generatesDraftCopy = true;

  constructor(
    private readonly classifier: ClassificationProvider,
    private readonly negotiator: NegotiationProvider,
    private readonly mockOpts: MockAgentOptions,
  ) {}

  async classify(body: string): Promise<ClassifyResult> {
    try {
      const result = await this.classifier.classify({ message: body });
      return {
        intent: result.intent as ClassifyResult["intent"],
        confidence: result.confidence,
        // Phase E (#5): carry the always-escalate topic reason through so reply
        // detection can route to MANUAL_REVIEW with the specific reason.
        ...(result.escalationReason ? { escalationReason: result.escalationReason } : {}),
      };
    } catch (err) {
      // Degrade to UNKNOWN/0 — the low-confidence gate routes this to
      // MANUAL_REVIEW rather than stranding the instance at REPLY_RECEIVED.
      console.error(
        `[agentProvider] classify failed, degrading to UNKNOWN (MANUAL_REVIEW): ${errMessage(err)}`,
      );
      return { intent: "UNKNOWN", confidence: 0 };
    }
  }

  async negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply = "",
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult> {
    // FIX-1 history threading + FIX-2 current-offer tracking: the request is
    // built from the executor-assembled priorContext (not hardcoded []/floor).
    try {
      const resp = await this.negotiator.negotiate(
        buildNegotiationRequest(round, config, creatorReply, priorContext),
      );
      return mapNegotiationResponse(resp, round);
    } catch (err) {
      // Degrade to escalate — a money decision must never be guessed when the
      // agent is down. The executor maps escalate → MANUAL_REVIEW (human).
      console.error(
        `[agentProvider] negotiate failed, degrading to escalate (MANUAL_REVIEW): ${errMessage(err)}`,
      );
      return { outcome: "escalate", message: "" };
    }
  }

  async draftEmail(
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
      // HARD-N2: prior conversation (both sides) + answered-questions ledger.
      history?: DraftHistoryEntry[];
      openQuestions?: string[];
      // PLU-111: outstanding Pluvus commitments to honor or update.
      openCommitments?: string[];
      // Q3 (founder, autonomous launch): true on the LAST negotiation round so
      // the offer email states finality to the creator.
      isFinalRound?: boolean;
      // drafting-humanization (§Conversation State): style hints so the offer copy
      // states deltas (not full state) and warms up across the thread. Both purely
      // stylistic; absent = today's behavior.
      changedFields?: string[];
      relationshipWarmth?: string;
      // Option A (negotiate→draft answer sync): the /negotiate model's own vetted
      // reply, so the copy rephrases approved answers instead of inventing them.
      negotiatorAnswers?: string;
      // PLU-113: durable creator facts so the copy honors them without re-parsing
      // the transcript. Sanitized DATA agent-side; never the offer figure.
      creatorMemory?: CreatorMemoryPayload;
    },
  ): Promise<EmailDraft | null> {
    // PLU-109: the CSV import accepts creator-discovery vendor exports carrying
    // a phone number and adult-platform data. Projecting the creator through an
    // ALLOWLIST here — the one place a Creator becomes an LLM request — means
    // widening what reaches a model provider is an explicit, reviewable edit
    // rather than a side effect of adding a column.
    const safe = llmSafeCreatorContext(creator);
    const request = {
      purpose,
      creatorName: creator.name,
      creatorPlatform: safe.platform,
      creatorNiche: safe.niche,
      senderName: typeof config["senderName"] === "string" ? config["senderName"] : undefined,
      brandDescription: typeof config["brandDescription"] === "string" ? config["brandDescription"] : undefined,
      deliverables: typeof config["deliverables"] === "string" ? config["deliverables"] : undefined,
      timeline: typeof config["timeline"] === "string" ? config["timeline"] : undefined,
      rewardDescription:
        typeof config["rewardDescription"] === "string" ? config["rewardDescription"] : undefined,
      round: extra?.round,
      proposedTerms: extra?.proposedTerms,
      creatorReply: extra?.creatorReply,
      creatorRequestedRate: extra?.creatorRequestedRate,
      dealDescription: extra?.dealDescription,
      // Comprehension forwarded to /draft (spec §5.5/§6.2). The Python
      // DraftRequest reads these to render the question checklist + fixed-term
      // acknowledgement instead of re-parsing the raw reply.
      creatorQuestions: extra?.creatorQuestions,
      pushedFixedTerms: extra?.pushedFixedTerms,
      // HARD-N2: the conversation so far + the answered-questions ledger, so the
      // copy stays consistent with prior emails and re-surfaces an earlier
      // unanswered question rather than dropping it.
      history: extra?.history,
      openQuestions: extra?.openQuestions,
      // PLU-111: forward outstanding Pluvus commitments so /draft renders the
      // "honor or update these commitments" block. Undefined → the Python default
      // ([]) keeps the copy byte-identical for callers that pass none.
      openCommitments: extra?.openCommitments,
      // Q3 (founder, autonomous launch): forward the final-round flag so the
      // Python offer prompt renders the "this is our final rate" copy.
      isFinalRound: extra?.isFinalRound,
      // drafting-humanization (§Conversation State): forward the style hints so the
      // Python offer prompt renders the say-only-what-changed hint + warmth rung.
      // Both default safely agent-side when absent (empty delta / "new" warmth).
      changedFields: extra?.changedFields,
      relationshipWarmth: extra?.relationshipWarmth,
      // Option A: forward the negotiator's vetted answers so /draft renders the
      // authoritative <vetted_answers> block. Undefined → Python default (None)
      // omits the block, so the copy is byte-identical for callers that pass none.
      negotiatorAnswers: extra?.negotiatorAnswers,
      // PLU-113: forward the durable creator facts so /draft renders the
      // <creator_memory> DATA block. Undefined → Python default (None) omits the
      // block, so the copy is byte-identical for callers that pass none.
      creatorMemory: extra?.creatorMemory,
      // Strip the internal price band before handing config to the copy
      // generator. The negotiation prompt is told to keep floor/ceiling
      // secret, but the draft endpoint was being handed the raw band
      // (minBudget/maxBudget/termFloor/termCeiling) in campaignContext and
      // writing it into the email (e.g. "in the $200-$500 range") — which the
      // output guard then blocks. The draft only ever needs the offer rate
      // (via proposedTerms), never the band. (Defense in depth: the output
      // guard remains the backstop if a model still emits a bound.)
      campaignContext: stripBandFromContext(config),
    };

    // Retry the draft call before degrading. A counter/offer email that fails
    // to generate must NOT silently fall back to the sparse negotiate
    // responseDraft (which explains only the fee and reads as a one-liner) — the
    // executor escalates to MANUAL_REVIEW on null. But the local LLM is often
    // just SLOW/transiently flaky, so we retry a couple of times first to keep
    // automation flowing on a blip instead of paging a human for it.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= DRAFT_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.negotiator.draft(request);
      } catch (err) {
        lastErr = err;
        console.error(
          `[agentProvider] draftEmail attempt ${attempt}/${DRAFT_MAX_ATTEMPTS} failed` +
            `${attempt < DRAFT_MAX_ATTEMPTS ? ", retrying" : ""}: ${errMessage(err)}`,
        );
      }
    }
    // Exhausted retries — degrade to null. Outreach/follow-up fall back to
    // template copy; the negotiation executor escalates the turn to a human so
    // no low-quality auto-copy reaches the creator.
    console.error(
      `[agentProvider] draftEmail failed after ${DRAFT_MAX_ATTEMPTS} attempts, degrading to null: ${errMessage(lastErr)}`,
    );
    return null;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// How many times to try the /draft copy generation before degrading to null.
// The local LLM is frequently slow/transiently flaky, so a retry usually
// succeeds on a blip; only a persistent failure degrades (→ escalation on the
// negotiation path).
const DRAFT_MAX_ATTEMPTS = 3;

// Keys carrying the internal price band. These must NOT reach the email copy
// generator — the email may reference only the agreed/offer rate (via
// proposedTerms), never the floor/ceiling band. Removing them at the draft seam
// stops the model from writing "$200-$500" into the body; the output guard is
// the backstop if a model invents a bound anyway.
//
// PLU-81 §4.3: EXPORTED so the centralized context builder
// (conversationContext.ts toDraftContext) strips the band using this ONE list
// rather than re-listing the keys — the band-key list stays a single source of
// truth. Note it strips the RAW minBudget/maxBudget keys too, not just the
// term-shaped names: those raw keys are the real leak surface (a plain config
// number, not a struct a getter could gate).
export const BAND_CONTEXT_KEYS = ["minBudget", "maxBudget", "termFloor", "termCeiling"] as const;

export function stripBandFromContext(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...config };
  for (const k of BAND_CONTEXT_KEYS) delete safe[k];
  return safe;
}

/**
 * Agent (AI) provider.
 * Classification: AGENT_PROVIDER env flag (mock | langgraph).
 * Negotiation: NEGOTIATION_PROVIDER env flag (mock | langgraph).
 * Draft generation: via NegotiationProvider.draft().
 *
 * When mockIntent is set (harness / manual injection), the full MockAgentProvider
 * is returned so classification is bypassed and negotiation opts still apply.
 */
export function agentProvider(opts: MockAgentOptions = {}): IAgentProvider {
  if (opts.replyIntent !== undefined) {
    return new MockAgentProvider(opts);
  }
  return new AgentProviderAdapter(
    classificationProvider(),
    negotiationProvider(),
    opts,
  );
}
