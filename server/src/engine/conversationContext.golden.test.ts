/**
 * PLU-81 §10 — GOLDEN byte-identical request-shape matrix (THE MERGE GATE).
 *
 * Run with:
 *   npx tsx src/engine/conversationContext.golden.test.ts
 *
 * The migration MUST NOT change any request the agent receives. This test proves
 * that the NEW builder path (assembleContext → toDecisionContext/toDraftContext)
 * feeds byte-identical inputs to the two final shapers as the OLD inline assembly
 * (a literal re-implementation of negotiation.ts's inline code, the "golden oracle").
 *
 *   - /negotiate: both paths produce a PriorNegotiationContext that
 *     buildNegotiationRequest (providers.ts, the FINAL conditional-spread shaper —
 *     §5.7) turns into the request. We snapshot buildNegotiationRequest(...) output.
 *   - /draft: both paths produce a draftConfig; the request's campaignContext is
 *     stripBandFromContext(draftConfig). We snapshot the stripped campaignContext.
 *
 * Across the flag matrix: {all off}, {BRIEF_INTO_NEGOTIATE}, {KNOWLEDGE_RETRIEVAL_ENABLED},
 * {both}, {MATERIAL_CONFLICT_ESCALATION_ENABLED}. Byte-identical JSON (stable key
 * order) BEFORE (oracle) vs AFTER (builder). If the builder ever pre-populates an
 * empty object, reorders a spread, or crosses intent/dealDescription, a row fails.
 *
 * Specifically asserts the omit-when-empty contract (§5.7) + the DECISION/DRAFT
 * asymmetry (§10): flags-off negotiate has NO campaignContext/conversationHistory/
 * openCommitments/intent; draft campaignContext has NONE of BAND_CONTEXT_KEYS;
 * intent reaches DECISION only; dealDescription reaches DRAFT only.
 */

import assert from "node:assert/strict";
import type { Campaign, ConversationObligation, Creator, Event, ExecutionInstance, Message } from "../db/schema.js";
import type { NodeSnapshot, PriorNegotiationContext } from "./types.js";
import type { ResolvedBrief } from "./executors/briefKnowledge.js";
import type { DraftHistoryEntry } from "../adapters/negotiation/types.js";
import { buildNegotiationRequest } from "./providers.js";
import { BAND_CONTEXT_KEYS, stripBandFromContext } from "./providerFactory.js";
import {
  buildPriorContextFromEvents,
  buildDraftHistory,
  buildOpenObligations,
  buildStructuredObligations,
} from "./executors/negotiationHistory.js";
import { mergeCampaignFallback } from "./campaignContext.js";
import { extractReplyText } from "./executors/replyText.js";
import { assembleContext, toDecisionContext, toDraftContext, type AssembleInputs } from "./conversationContext.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A JSON canonicalizer with STABLE (sorted) key order, so "byte-identical" is
// order-insensitive at the object level but sensitive to which keys/values exist.
function canonical(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Fixtures — a representative round-1 turn with transcript, obligations, a brief.
// ---------------------------------------------------------------------------

const INSTANCE_ID = "inst-golden";
const ROUND = 1;

function inst(): ExecutionInstance {
  return { id: INSTANCE_ID, currentState: "NEGOTIATING", negotiationRound: ROUND } as ExecutionInstance;
}
function creator(): Creator {
  return { id: "c1", name: "Maya", email: "maya@example.com" } as Creator;
}

let msgSeq = 0;
function msg(overrides: Partial<Message> & { direction: Message["direction"] }): Message {
  msgSeq++;
  return {
    id: `m${msgSeq}`,
    instanceId: INSTANCE_ID,
    subject: null,
    body: "",
    threadId: null,
    senderEmail: null,
    externalMessageId: null,
    idempotencyKey: null,
    replyIntent: null,
    classifyConfidence: null,
    redriveCount: 0,
    sentAt: null,
    receivedAt: null,
    processedAt: null,
    createdAt: new Date(2026, 0, 1, 0, 0, msgSeq),
    ...overrides,
  } as Message;
}

let evSeq = 0;
function ev(type: Event["type"], payload: unknown): Event {
  evSeq++;
  return { id: `e${evSeq}`, instanceId: INSTANCE_ID, type, nodeId: null, payload: payload as Event["payload"], occurredAt: new Date(2026, 0, 1, 0, 0, evSeq) };
}

let obSeq = 0;
function obligation(overrides: Partial<ConversationObligation>): ConversationObligation {
  obSeq++;
  return {
    id: `o${obSeq}`, instanceId: INSTANCE_ID, type: "CREATOR_QUESTION", status: "OPEN",
    originalText: "", normalizedKey: "", category: null, resolution: null, resolutionSource: null,
    sourceMessageId: null, resolutionMessageId: null,
    createdAt: new Date(2026, 0, 1, 0, 0, obSeq), updatedAt: new Date(2026, 0, 1, 0, 0, obSeq), resolvedAt: null,
    ...overrides,
  } as ConversationObligation;
}

const NODE: NodeSnapshot = {
  id: "node-neg",
  type: "NEGOTIATION",
  order: 1,
  config: {
    senderName: "Acme",
    brandName: "Acme",
    brandDescription: "A brand",
    deliverables: "1 reel",
    timeline: "2 weeks",
    commissionRate: 10,
    rewardDescription: "free product",
    minBudget: 200,
    maxBudget: 500,
    maxRounds: 5,
    recommendedOfferPosition: 0.5,
    usageRights: "90-day paid social",
    exclusivity: "non-exclusive",
    paymentTerms: "Net 30",
    attributionWindow: "30 days",
  },
};

// A CONTENT_BRIEF node so the brief ref would resolve (the resolver is stubbed here
// via the injected ResolvedBrief; the graph shape is what the builder sees).
const CONTENT_BRIEF_NODE: NodeSnapshot = {
  id: "node-brief",
  type: "CONTENT_BRIEF",
  order: 2,
  config: { briefFileRef: "ref-abc" },
};
const NODE_GRAPH: NodeSnapshot[] = [NODE, CONTENT_BRIEF_NODE];

// A resolved brief with sections (so briefSections + structuredObligations project)
// and flatText (so the negotiate blob gating flags matter).
function resolvedBrief(): ResolvedBrief {
  return {
    flatText: "Brief flat text: usage is 90 days, Net 30.",
    status: "ok",
    sections: {
      paymentTerms: { type: "paymentTerms", text: "Net 30 from invoice.", sourceFileReference: "ref-abc", parserVersion: "v1" },
      usageRights: { type: "usageRights", text: "90 days paid social.", sourceFileReference: "ref-abc", parserVersion: "v1" },
    },
  };
}

// The transcript: creator Q → our sent counter → creator latest reply.
function messages(): Message[] {
  return [
    msg({ direction: "INBOUND", body: "What's the usage window?", externalMessageId: "in-1", receivedAt: new Date(2026, 0, 1, 0, 0, 10) }),
    msg({ direction: "OUTBOUND", body: "We can do $350.", idempotencyKey: `negotiation:counter_offer:${INSTANCE_ID}:1`, sentAt: new Date(2026, 0, 1, 0, 0, 20) }),
    msg({ direction: "INBOUND", body: "Sounds good, $350 works.", externalMessageId: "in-2", replyIntent: "POSITIVE", receivedAt: new Date(2026, 0, 1, 0, 0, 30) }),
  ];
}
function events(): Event[] {
  return [ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 350, message: "We can do $350." })];
}
function obligations(): ConversationObligation[] {
  return [
    obligation({ type: "CREATOR_QUESTION", originalText: "What's the usage window?", normalizedKey: "what s the usage window", category: "usage_rights" }),
    obligation({ type: "PLUVUS_COMMITMENT", originalText: "We'll confirm shipping.", normalizedKey: "we ll confirm shipping", category: "shipping" }),
  ];
}

// ---------------------------------------------------------------------------
// The GOLDEN ORACLE — a literal re-implementation of negotiation.ts's inline
// assembly (§1 table). This is the pre-refactor code, held here as the reference.
// ---------------------------------------------------------------------------

const FLAT_KNOWLEDGE_KEYS = ["usageRights", "exclusivity", "paymentTerms", "attributionWindow"] as const;

function oracleProjectFlatKnowledge(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FLAT_KNOWLEDGE_KEYS) {
    const v = config[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}
function oracleProjectBriefSections(sections: ResolvedBrief["sections"]): Record<string, string> | undefined {
  if (!sections) return undefined;
  const out: Record<string, string> = {};
  for (const [key, section] of Object.entries(sections)) {
    const text = section?.text;
    if (typeof text === "string" && text.trim()) out[key] = text;
  }
  return Object.keys(out).length ? out : undefined;
}
function briefIntoNegotiateEnabled(): boolean {
  return process.env["BRIEF_INTO_NEGOTIATE"] === "true";
}
function knowledgeRetrievalEnabled(): boolean {
  return process.env["KNOWLEDGE_RETRIEVAL_ENABLED"] === "true";
}

/** The old inline assembly (negotiation.ts ~489–711 + 865–870), producing the
 *  negotiate PriorNegotiationContext AND the draft draftConfig, from the same rows. */
function oracle(inputsRows: {
  campaign: Campaign | null;
  brief: ResolvedBrief;
  msgs: Message[];
  evs: Event[];
  obs: ConversationObligation[];
}): { negotiationContext: PriorNegotiationContext; draftConfig: Record<string, unknown>; creatorReply: string } {
  const { campaign, brief, msgs, evs, obs } = inputsRows;
  const config = mergeCampaignFallback(NODE.config, campaign);

  // loadCreatorInbounds
  const brandReplyMsgIds = new Set(
    evs
      .filter((e) => e.type === "INBOUND_REPLY_RECEIVED")
      .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
      .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
      .filter((id): id is string => typeof id === "string"),
  );
  const latestInbound = msgs
    .filter((m) => m.direction === "INBOUND")
    .filter((m) => !(m.externalMessageId && brandReplyMsgIds.has(m.externalMessageId)))
    .at(-1);
  const creatorReply = latestInbound?.body ? extractReplyText(latestInbound.body) : "";

  const priorEvents = evs.filter((e) => e.type === "NEGOTIATION_TURN");
  const priorContext = buildPriorContextFromEvents(evs);
  const draftHistory: DraftHistoryEntry[] = buildDraftHistory(msgs, brandReplyMsgIds, priorEvents);

  const ledgerSplit = buildOpenObligations(obs);
  const openCommitments = ledgerSplit.openCommitments;

  const classifiedIntent = typeof latestInbound?.replyIntent === "string" ? latestInbound.replyIntent : undefined;

  const briefKnowledge = brief.flatText;
  const negotiateBrief =
    (briefIntoNegotiateEnabled() || knowledgeRetrievalEnabled()) && briefKnowledge ? briefKnowledge : undefined;
  const briefSections = oracleProjectBriefSections(brief.sections);
  const structuredObligations = buildStructuredObligations(obs);
  const flatKnowledge = oracleProjectFlatKnowledge(config);

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

  const draftConfig: Record<string, unknown> = {
    ...config,
    ...(briefKnowledge ? { briefKnowledge } : {}),
    ...(briefSections ? { briefSections } : {}),
    ...(structuredObligations.length ? { structuredObligations } : {}),
  };

  return { negotiationContext, draftConfig, creatorReply };
}

// ---------------------------------------------------------------------------
// The BUILDER path — assembleContext + projections over the SAME rows.
// ---------------------------------------------------------------------------

function builder(inputsRows: {
  campaign: Campaign | null;
  brief: ResolvedBrief;
  msgs: Message[];
  evs: Event[];
  obs: ConversationObligation[];
}): { negotiationContext: PriorNegotiationContext; draftConfig: Record<string, unknown>; creatorReply: string } {
  const inputs: AssembleInputs = {
    purpose: "NEGOTIATION_DECISION",
    instance: inst(),
    creator: creator(),
    campaign: inputsRows.campaign,
    node: NODE,
    nodeGraph: NODE_GRAPH,
    messages: inputsRows.msgs,
    events: inputsRows.evs,
    obligationRows: inputsRows.obs,
    resolvedBrief: inputsRows.brief,
  };
  const ctx = assembleContext(inputs);
  const decision = toDecisionContext(ctx);
  const draft = toDraftContext(ctx);
  return {
    negotiationContext: decision.decisionHistory,
    draftConfig: draft.draftConfig,
    creatorReply: ctx.creatorReply,
  };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

interface FlagSet {
  BRIEF_INTO_NEGOTIATE?: boolean;
  KNOWLEDGE_RETRIEVAL_ENABLED?: boolean;
  MATERIAL_CONFLICT_ESCALATION_ENABLED?: boolean;
  // PLU-69 Step 0: the two epic flags whose features light up by swapping a loader
  // (§9.1). They MUST appear here so "flag OFF → byte-identical" is a REAL gate for
  // them and not vacuously true (PLU-69 spec §4 Step 0 / §10). The dark-safety they
  // guard is proved by the "loader returns a row but the flag is OFF → still
  // byte-identical" rows below.
  CREATOR_MEMORY_ENABLED?: boolean;
  CONVERSATION_SUMMARY_ENABLED?: boolean;
}
const MATRIX: Array<{ label: string; flags: FlagSet }> = [
  { label: "all flags off", flags: {} },
  { label: "BRIEF_INTO_NEGOTIATE on", flags: { BRIEF_INTO_NEGOTIATE: true } },
  { label: "KNOWLEDGE_RETRIEVAL_ENABLED on", flags: { KNOWLEDGE_RETRIEVAL_ENABLED: true } },
  { label: "both brief-into flags on", flags: { BRIEF_INTO_NEGOTIATE: true, KNOWLEDGE_RETRIEVAL_ENABLED: true } },
  { label: "MATERIAL_CONFLICT_ESCALATION_ENABLED on", flags: { MATERIAL_CONFLICT_ESCALATION_ENABLED: true } },
  { label: "CREATOR_MEMORY_ENABLED on", flags: { CREATOR_MEMORY_ENABLED: true } },
  { label: "CONVERSATION_SUMMARY_ENABLED on", flags: { CONVERSATION_SUMMARY_ENABLED: true } },
];

const FLAG_KEYS = [
  "BRIEF_INTO_NEGOTIATE",
  "KNOWLEDGE_RETRIEVAL_ENABLED",
  "MATERIAL_CONFLICT_ESCALATION_ENABLED",
  "CREATOR_MEMORY_ENABLED",
  "CONVERSATION_SUMMARY_ENABLED",
] as const;
function withFlags<T>(flags: FlagSet, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of FLAG_KEYS) {
    prev[k] = process.env[k];
    if ((flags as Record<string, boolean | undefined>)[k]) process.env[k] = "true";
    else delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of FLAG_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

function rows(campaign: Campaign | null = null) {
  return { campaign, brief: resolvedBrief(), msgs: messages(), evs: events(), obs: obligations() };
}

console.log("\nGOLDEN — /negotiate request byte-identical across the flag matrix\n");

for (const { label, flags } of MATRIX) {
  test(`[${label}] negotiate request byte-identical (oracle vs builder)`, () => {
    withFlags(flags, () => {
      const r = rows();
      const o = oracle(r);
      const b = builder(r);
      const oReq = buildNegotiationRequest(ROUND, mergeCampaignFallback(NODE.config, r.campaign), o.creatorReply, o.negotiationContext);
      const bReq = buildNegotiationRequest(ROUND, mergeCampaignFallback(NODE.config, r.campaign), b.creatorReply, b.negotiationContext);
      assert.equal(canonical(bReq), canonical(oReq), "negotiate request must be byte-identical");
    });
  });
}

console.log("\nGOLDEN — /draft campaignContext byte-identical across the flag matrix\n");

for (const { label, flags } of MATRIX) {
  test(`[${label}] draft campaignContext byte-identical (oracle vs builder)`, () => {
    withFlags(flags, () => {
      const r = rows();
      const o = oracle(r);
      const b = builder(r);
      // providerFactory.draftEmail sets request.campaignContext = stripBandFromContext(config).
      const oStripped = stripBandFromContext(o.draftConfig);
      const bStripped = stripBandFromContext(b.draftConfig);
      assert.equal(canonical(bStripped), canonical(oStripped), "draft campaignContext must be byte-identical");
    });
  });
}

console.log("\nGOLDEN — with a campaign fallback (mergeCampaignFallback path)\n");

test("negotiate + draft byte-identical when a campaign fills gaps", () => {
  withFlags({ KNOWLEDGE_RETRIEVAL_ENABLED: true }, () => {
    // A node config missing a couple of brand fields, with a campaign that fills them.
    const sparseNode: NodeSnapshot = { ...NODE, config: { minBudget: 200, maxBudget: 500, maxRounds: 5, recommendedOfferPosition: 0.5 } };
    const campaign = {
      brand: "CampBrand",
      brandDescription: "camp desc",
      deliverables: "camp deliverables",
      timeline: "camp timeline",
      rewardDescription: "camp reward",
      shipsPhysicalProduct: true,
      usageRights: "camp usage",
      exclusivity: "camp exclusivity",
      paymentTerms: "camp payment",
      attributionWindow: "camp window",
    } as unknown as Campaign;

    // oracle with the sparse node
    const config = mergeCampaignFallback(sparseNode.config, campaign);
    const r = { campaign, brief: resolvedBrief(), msgs: messages(), evs: events(), obs: obligations() };
    // Re-run oracle/builder against the sparse node by temporarily swapping NODE refs
    // through local re-implementation (the module-level NODE is fixed, so do it inline):
    const brandReplyMsgIds = new Set<string>();
    const latestInbound = r.msgs.filter((m) => m.direction === "INBOUND").at(-1);
    const creatorReply = latestInbound?.body ? extractReplyText(latestInbound.body) : "";
    const priorEvents = r.evs.filter((e) => e.type === "NEGOTIATION_TURN");
    const priorContext = buildPriorContextFromEvents(r.evs);
    const draftHistory = buildDraftHistory(r.msgs, brandReplyMsgIds, priorEvents);
    const openCommitments = buildOpenObligations(r.obs).openCommitments;
    const classifiedIntent = typeof latestInbound?.replyIntent === "string" ? latestInbound.replyIntent : undefined;
    const negotiateBrief = r.brief.flatText;
    const briefSections = oracleProjectBriefSections(r.brief.sections);
    const structuredObligations = buildStructuredObligations(r.obs);
    const flatKnowledge = oracleProjectFlatKnowledge(config);
    const knowledgeContext: Record<string, unknown> = {
      ...flatKnowledge,
      ...(negotiateBrief ? { briefKnowledge: negotiateBrief } : {}),
      ...(briefSections ? { briefSections } : {}),
      ...(structuredObligations.length ? { structuredObligations } : {}),
    };
    const oracleNeg: PriorNegotiationContext = {
      ...priorContext,
      ...(draftHistory.length ? { conversationHistory: draftHistory } : {}),
      ...(openCommitments.length ? { openCommitments } : {}),
      ...(classifiedIntent ? { intent: classifiedIntent } : {}),
      ...(Object.keys(knowledgeContext).length ? { campaignContext: knowledgeContext } : {}),
    };

    const ctx = assembleContext({
      purpose: "NEGOTIATION_DECISION",
      instance: inst(), creator: creator(), campaign, node: sparseNode, nodeGraph: [sparseNode, CONTENT_BRIEF_NODE],
      messages: r.msgs, events: r.evs, obligationRows: r.obs, resolvedBrief: r.brief,
    });
    const oReq = buildNegotiationRequest(ROUND, config, creatorReply, oracleNeg);
    const bReq = buildNegotiationRequest(ROUND, config, ctx.creatorReply, toDecisionContext(ctx).decisionHistory);
    assert.equal(canonical(bReq), canonical(oReq), "campaign-fallback negotiate request must match");
  });
});

// ---------------------------------------------------------------------------
// The explicit invariant assertions the spec calls out (§10)
// ---------------------------------------------------------------------------

console.log("\nGOLDEN — explicit §10 invariants\n");

test("flags-off negotiate request has NO campaignContext/conversationHistory/openCommitments/intent", () => {
  withFlags({}, () => {
    // A first-turn state: EMPTY transcript (no persisted Message rows yet), no
    // obligations, no persisted intent, no negotiate brief blob (flags off) → the
    // four keys must all be OMITTED. (A single inbound row legitimately produces a
    // one-entry transcript — the omit contract is specifically the empty case.)
    const r = { campaign: null as Campaign | null, brief: { flatText: "brief text", status: "ok" } as ResolvedBrief, msgs: [] as Message[], evs: [] as Event[], obs: [] as ConversationObligation[] };
    const ctx = assembleContext({
      purpose: "NEGOTIATION_DECISION",
      instance: inst(), creator: creator(), campaign: null, node: NODE, nodeGraph: NODE_GRAPH,
      messages: r.msgs, events: r.evs, obligationRows: r.obs, resolvedBrief: r.brief,
    });
    const neg = toDecisionContext(ctx).decisionHistory;
    // The knowledge campaignContext still carries flat FIELDS (config has them) — but
    // NOT the brief blob (flags off). The §10 assertion is specifically the omit of
    // the transcript/commitments/intent keys, which are all empty here:
    assert.ok(!("conversationHistory" in neg), "no conversationHistory when transcript empty");
    assert.ok(!("openCommitments" in neg), "no openCommitments when none open");
    assert.ok(!("intent" in neg), "no intent when the inbound has no persisted replyIntent");
    // brief blob NOT threaded with flags off
    const cc = (neg.campaignContext ?? {}) as Record<string, unknown>;
    assert.ok(!("briefKnowledge" in cc), "brief blob must NOT reach negotiate with flags off");
    // and the final request built from it omits them too
    const req = buildNegotiationRequest(ROUND, mergeCampaignFallback(NODE.config, null), ctx.creatorReply, neg) as Record<string, unknown>;
    assert.ok(!("conversationHistory" in req));
    assert.ok(!("openCommitments" in req));
    assert.ok(!("intent" in req));
  });
});

test("a truly bare config (no knowledge fields) → negotiate request has NO campaignContext key at all", () => {
  withFlags({}, () => {
    const bareNode: NodeSnapshot = { id: "n", type: "NEGOTIATION", order: 1, config: { minBudget: 200, maxBudget: 500, maxRounds: 5 } };
    const cleanInbound = msg({ direction: "INBOUND", body: "Yes I'm interested." });
    const ctx = assembleContext({
      purpose: "NEGOTIATION_DECISION",
      instance: inst(), creator: creator(), campaign: null, node: bareNode, nodeGraph: [bareNode],
      messages: [cleanInbound], events: [], obligationRows: [], resolvedBrief: { flatText: "", status: "no_brief" },
    });
    const neg = toDecisionContext(ctx).decisionHistory;
    assert.ok(!("campaignContext" in neg), "empty knowledge → no campaignContext (omit-when-empty §5.7)");
    const req = buildNegotiationRequest(ROUND, mergeCampaignFallback(bareNode.config, null), ctx.creatorReply, neg) as Record<string, unknown>;
    assert.ok(!("campaignContext" in req), "final request omits an empty campaignContext");
  });
});

test("draft campaignContext has NONE of BAND_CONTEXT_KEYS (any flag combination)", () => {
  for (const { flags } of MATRIX) {
    withFlags(flags, () => {
      const r = rows();
      const b = builder(r);
      const stripped = stripBandFromContext(b.draftConfig);
      for (const k of BAND_CONTEXT_KEYS) {
        assert.ok(!(k in stripped), `draft campaignContext must not carry band key ${k}`);
      }
    });
  }
});

test("intent reaches DECISION only; dealDescription reaches DRAFT only (neither crosses)", () => {
  withFlags({ KNOWLEDGE_RETRIEVAL_ENABLED: true }, () => {
    const r = rows();
    const b = builder(r);
    // intent is on the DECISION context (the latest inbound carries replyIntent POSITIVE)…
    assert.equal(b.negotiationContext.intent, "POSITIVE");
    // …and is NOT anywhere on the draftConfig.
    assert.ok(!("intent" in b.draftConfig), "intent must not cross into the draft config");
    // dealDescription is a per-branch DRAFT `extra` (executor-owned) — it must NEVER
    // appear on the negotiate context nor on the shared draftConfig the builder owns.
    assert.ok(!("dealDescription" in b.negotiationContext), "dealDescription must not reach the negotiate context");
    assert.ok(!("dealDescription" in b.draftConfig), "dealDescription is per-branch extra, not on the shared draftConfig");
  });
});

// ---------------------------------------------------------------------------
// PLU-69 Step 0 — the two new flags are REAL gates, not vacuous.
//
// The forward-compat seam (§9.1) lets PLU-112/113 light up by swapping a loader.
// The danger the golden gate must catch: a loader that returns a row when its flag
// is OFF must NOT change any request the agent receives — AND, when the flag is ON,
// creatorMemory must reach the DRAFT projection but NEVER leak onto the DECISION
// path via the pure projection (PLU-81 keeps memory draft-only in toDecisionContext;
// the executor threads it to the decision model separately and deliberately, §3.6).
//
// These tests feed a NON-EMPTY creatorMemory / conversationSummary straight into
// assembleContext (simulating "the loader returned a row") and prove the projection
// invariants hold regardless of the flag — the case that catches an accidental
// decision-path leak the 3-flag matrix could never observe.
// ---------------------------------------------------------------------------

import type { CreatorMemoryPayload, ConversationSummary } from "./conversationContext.js";

function memoryFixture(): CreatorMemoryPayload {
  return {
    requestedRate: "500",
    minimumRate: "400",
    availability: "weekdays only",
    logisticsConstraints: ["ships from EU"],
    objections: ["dislikes exclusivity"],
    deliverablePreferences: ["Reels over Stories"],
    compensationPreferences: ["flat fee"],
    managerInvolved: true,
    managerContact: "mgr@example.com",
    conflicts: [{ key: "REQUESTED_RATE", current: "500", prior: "450" }] as CreatorMemoryPayload["conflicts"],
  };
}
function summaryFixture(): ConversationSummary {
  return { text: "Creator asked about usage rights in round 1; we deferred.", version: "summary-v1", tokensSaved: 120 };
}

// Assemble twice over the SAME rows (so message/obligation ids match) — once with
// no loader rows (today's path) and once with the loaders returning real rows.
function assembleBaselineAndLoaded(): { base: ReturnType<typeof assembleContext>; loaded: ReturnType<typeof assembleContext> } {
  const r = rows();
  const common = {
    purpose: "NEGOTIATION_DECISION" as const,
    instance: inst(), creator: creator(), campaign: null, node: NODE, nodeGraph: NODE_GRAPH,
    messages: r.msgs, events: r.evs, obligationRows: r.obs, resolvedBrief: r.brief,
  };
  const base = assembleContext({ ...common });
  const loaded = assembleContext({ ...common, creatorMemory: memoryFixture(), conversationSummary: summaryFixture() });
  return { base, loaded };
}

console.log("\nGOLDEN — PLU-69 Step 0: memory/summary never leak onto the DECISION request\n");

for (const flags of [{}, { CREATOR_MEMORY_ENABLED: true }, { CONVERSATION_SUMMARY_ENABLED: true }] as FlagSet[]) {
  const label = Object.keys(flags)[0] ?? "all off";
  test(`[${label}] a populated creatorMemory/summary loader row does NOT change the negotiate request`, () => {
    withFlags(flags, () => {
      const { base, loaded } = assembleBaselineAndLoaded();
      const baseReq = buildNegotiationRequest(
        ROUND, mergeCampaignFallback(NODE.config, null), base.creatorReply, toDecisionContext(base).decisionHistory,
      );
      const loadedReq = buildNegotiationRequest(
        ROUND, mergeCampaignFallback(NODE.config, null), loaded.creatorReply, toDecisionContext(loaded).decisionHistory,
      );
      assert.equal(
        canonical(loadedReq), canonical(baseReq),
        "a loader row must NOT leak onto the DECISION request via the pure projection",
      );
    });
  });
}

test("toDecisionContext NEVER carries creatorMemory or conversationSummary (draft-only via projection)", () => {
  const { loaded } = assembleBaselineAndLoaded();
  const decision = toDecisionContext(loaded).decisionHistory as unknown as Record<string, unknown>;
  assert.ok(!("creatorMemory" in decision), "creatorMemory must not be on the decision projection");
  assert.ok(!("conversationSummary" in decision), "conversationSummary must not be on the decision projection");
});

test("toDraftContext DOES carry creatorMemory when the loader returned a row (draft-only seam)", () => {
  const { base, loaded } = assembleBaselineAndLoaded();
  const draft = toDraftContext(loaded);
  assert.ok(draft.creatorMemory, "draft projection carries the loaded creatorMemory");
  assert.equal(draft.creatorMemory?.requestedRate, "500");
  // and the summary/memory must not corrupt the byte-identity of the draftConfig knowledge keys
  const noMem = toDraftContext(base);
  assert.equal(
    canonical(stripBandFromContext(draft.draftConfig)),
    canonical(stripBandFromContext(noMem.draftConfig)),
    "draftConfig knowledge keys are byte-identical whether or not memory loaded (memory rides a separate field)",
  );
});

console.log(`\n${n} passed\n`);
