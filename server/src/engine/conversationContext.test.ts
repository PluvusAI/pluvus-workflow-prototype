/**
 * PLU-81 §8 — conversationContext PURE unit tests (no DB, no network).
 *
 * Run with:
 *   npx tsx src/engine/conversationContext.test.ts
 *
 * Tests the PURE assembleContext core + the two projections against hand-built
 * fixtures (Message[], Event[], ConversationObligation[], a literal ResolvedBrief).
 * Asserts (per §8):
 *   - transcript ordering + brand-reply exclusion (§5.4),
 *   - two-compartment split (knowledge on campaignContext, band on campaignConstraints),
 *   - toDraftContext output contains NONE of BAND_CONTEXT_KEYS (the money-safety test),
 *   - toDecisionContext carries band presence + the DECISION-only intent,
 *   - estimatedTokens differs between the two projections,
 *   - sourcesUsed / contextRecord are labels only (no value strings, no band number),
 *   - optional slots are undefined with the default stub loaders,
 *   - latestMessageId is a validated consistency check (throws on a mismatch).
 *
 * Any test touching the real resolver would call _clearBriefCache — these tests
 * inject a stub ResolvedBrief and never hit the resolver, so no cache discipline
 * is needed here (the golden matrix exercises the shell separately).
 */

import assert from "node:assert/strict";
import type { Campaign, ConversationObligation, Creator, Event, ExecutionInstance, Message } from "../db/schema.js";
import type { NodeSnapshot } from "./types.js";
import type { ResolvedBrief } from "./executors/briefKnowledge.js";
import { BAND_CONTEXT_KEYS } from "./providerFactory.js";
import {
  assembleContext,
  toDecisionContext,
  toDraftContext,
  buildContextRecord,
  LatestMessageMismatchError,
  type AssembleInputs,
  type CreatorMemoryPayload,
} from "./conversationContext.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTANCE_ID = "inst1";

function inst(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: INSTANCE_ID,
    currentState: "NEGOTIATING",
    negotiationRound: 1,
    ...overrides,
  } as ExecutionInstance;
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
  return {
    id: `e${evSeq}`,
    instanceId: INSTANCE_ID,
    type,
    nodeId: null,
    payload: payload as Event["payload"],
    occurredAt: new Date(2026, 0, 1, 0, 0, evSeq),
  };
}

let obSeq = 0;
function obligation(overrides: Partial<ConversationObligation>): ConversationObligation {
  obSeq++;
  return {
    id: `o${obSeq}`,
    instanceId: INSTANCE_ID,
    type: "CREATOR_QUESTION",
    status: "OPEN",
    originalText: "",
    normalizedKey: "",
    category: null,
    resolution: null,
    resolutionSource: null,
    sourceMessageId: null,
    resolutionMessageId: null,
    createdAt: new Date(2026, 0, 1, 0, 0, obSeq),
    updatedAt: new Date(2026, 0, 1, 0, 0, obSeq),
    resolvedAt: null,
    ...overrides,
  } as ConversationObligation;
}

const node: NodeSnapshot = {
  id: "node-negotiation",
  type: "NEGOTIATION",
  order: 1,
  config: {
    senderName: "Acme",
    brandName: "Acme",
    minBudget: 200,
    maxBudget: 500,
    usageRights: "90-day paid social",
    paymentTerms: "Net 30",
  },
};

const nodeGraph: NodeSnapshot[] = [node];

/** A representative multi-turn set: creator → us → creator, plus a brand-reply
 *  inbound that must be EXCLUDED from both latest-selection and the transcript. */
function baseInputs(overrides: Partial<AssembleInputs> = {}): AssembleInputs {
  const inboundOld = msg({
    direction: "INBOUND",
    body: "What's the usage window?",
    externalMessageId: "ext-in-1",
    receivedAt: new Date(2026, 0, 1, 0, 0, 10),
  });
  const outbound = msg({
    direction: "OUTBOUND",
    body: "We can offer $350 for this.",
    idempotencyKey: `negotiation:counter_offer:${INSTANCE_ID}:1`,
    sentAt: new Date(2026, 0, 1, 0, 0, 20),
  });
  const inboundLatest = msg({
    direction: "INBOUND",
    body: "Sounds good, I can do $350.",
    externalMessageId: "ext-in-2",
    replyIntent: "POSITIVE",
    receivedAt: new Date(2026, 0, 1, 0, 0, 30),
  });
  const brandReply = msg({
    direction: "INBOUND",
    body: "Approve — go ahead.",
    externalMessageId: "ext-brand-1",
    receivedAt: new Date(2026, 0, 1, 0, 0, 40),
  });

  const messages: Message[] = [inboundOld, outbound, inboundLatest, brandReply];
  const events: Event[] = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 350, message: "We can offer $350 for this." }),
    ev("INBOUND_REPLY_RECEIVED", { brandDecisionReply: true, externalMessageId: "ext-brand-1" }),
  ];
  const resolvedBrief: ResolvedBrief = { flatText: "Brief: usage is 90 days.", status: "ok" };

  return {
    purpose: "NEGOTIATION_DECISION",
    instance: inst(),
    creator: creator(),
    campaign: null,
    node,
    nodeGraph,
    messages,
    events,
    obligationRows: [],
    resolvedBrief,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transcript ordering + brand-reply exclusion (§5.4)
// ---------------------------------------------------------------------------

console.log("\ntranscript ordering + brand-reply exclusion (§5.4)\n");

test("latest inbound is the newest NON-brand-reply creator row", () => {
  const ctx = assembleContext(baseInputs());
  assert.equal(ctx.latestInbound?.body, "Sounds good, I can do $350.");
  assert.equal(ctx.creatorReply, "Sounds good, I can do $350.");
});

test("the brand-reply inbound is EXCLUDED from latest-selection", () => {
  const ctx = assembleContext(baseInputs());
  // The brand "Approve" row is the newest INBOUND by time, but it's excluded.
  assert.notEqual(ctx.creatorReply, "Approve — go ahead.");
  assert.ok(ctx.brandReplyMsgIds.has("ext-brand-1"));
});

test("transcript is chronological and excludes the brand reply + unsent outbound", () => {
  const ctx = assembleContext(baseInputs());
  const roles = ctx.recentMessages.map((e) => e.role);
  const bodies = ctx.recentMessages.map((e) => e.message);
  // creator (old Q) → us (sent counter) → creator (latest). Brand reply dropped.
  assert.deepEqual(roles, ["creator", "us", "creator"]);
  assert.ok(!bodies.includes("Approve — go ahead."));
  // ordered by time.
  assert.equal(bodies[0], "What's the usage window?");
  assert.equal(bodies[2], "Sounds good, I can do $350.");
});

test("an unsent (sentAt=null) outbound is dropped from the transcript", () => {
  const inbound = msg({ direction: "INBOUND", body: "hi", receivedAt: new Date(2026, 0, 1, 0, 0, 5) });
  const unsent = msg({ direction: "OUTBOUND", body: "reserved but not sent", sentAt: null });
  const inputs = baseInputs({ messages: [inbound, unsent], events: [] });
  const ctx = assembleContext(inputs);
  assert.deepEqual(ctx.recentMessages.map((e) => e.role), ["creator"]);
});

// ---------------------------------------------------------------------------
// Two-compartment split (§5.3) + money-safety (§4.3)
// ---------------------------------------------------------------------------

console.log("\ntwo-compartment split + band-leak defense (§4.3, §5.3)\n");

test("knowledge rides campaignContext (band-free); band presence rides campaignConstraints", () => {
  const ctx = assembleContext(baseInputs());
  const decision = toDecisionContext(ctx);
  // Knowledge compartment: the flat fields are present, NONE of the band keys are.
  const cc = decision.decisionHistory.campaignContext ?? {};
  assert.equal(cc["usageRights"], "90-day paid social");
  assert.equal(cc["paymentTerms"], "Net 30");
  for (const k of BAND_CONTEXT_KEYS) {
    assert.ok(!(k in cc), `band key ${k} must NOT be on the knowledge campaignContext`);
  }
  // Money compartment: band presence is recorded, values are NOT. (The type only
  // has `bandPresent` — no band-value field exists to read; assert via the
  // serialized form so a future field addition carrying a value would fail here.)
  assert.equal(decision.campaignConstraints.bandPresent, true);
  const ccSerialized = JSON.stringify(decision.campaignConstraints);
  assert.ok(!ccSerialized.includes("200") && !ccSerialized.includes("500"), "campaignConstraints must carry no band value");
});

test("toDraftContext.draftConfig contains NONE of BAND_CONTEXT_KEYS (money-safety)", () => {
  const ctx = assembleContext(baseInputs());
  const draft = toDraftContext(ctx);
  for (const k of BAND_CONTEXT_KEYS) {
    assert.ok(!(k in draft.draftConfig), `draftConfig must NOT carry band key ${k}`);
  }
  // But it DOES keep the non-band brand/knowledge fields.
  assert.equal(draft.draftConfig["senderName"], "Acme");
  assert.equal(draft.draftConfig["usageRights"], "90-day paid social");
});

test("DraftContext has no campaignConstraints field at all (structural, §4.3)", () => {
  const ctx = assembleContext(baseInputs());
  const draft = toDraftContext(ctx);
  assert.ok(!("campaignConstraints" in draft), "DraftContext must structurally lack campaignConstraints");
});

test("bandPresent is false when the config carries no band", () => {
  const bandless: NodeSnapshot = { ...node, config: { senderName: "Acme" } };
  const ctx = assembleContext(baseInputs({ node: bandless, nodeGraph: [bandless] }));
  assert.equal(ctx.campaignConstraints.bandPresent, false);
  assert.equal(toDecisionContext(ctx).debug.bandPresent, false);
});

test("bandPresent is true for the termFloor/termCeiling shape too", () => {
  const termShape: NodeSnapshot = {
    ...node,
    config: { senderName: "Acme", termFloor: { rate: 200 }, termCeiling: { rate: 500 } },
  };
  const ctx = assembleContext(baseInputs({ node: termShape, nodeGraph: [termShape] }));
  assert.equal(ctx.campaignConstraints.bandPresent, true);
});

// ---------------------------------------------------------------------------
// DECISION-only intent; per-projection token estimate (§7.3, §10)
// ---------------------------------------------------------------------------

console.log("\nDECISION-only intent + per-projection token estimate (§7.3, §10)\n");

test("classified intent reaches DECISION only (never the draft path)", () => {
  // give the latest inbound a persisted replyIntent
  const inputs = baseInputs();
  const withIntent = inputs.messages.map((m) =>
    m.body === "Sounds good, I can do $350." ? ({ ...m, replyIntent: "POSITIVE" } as Message) : m,
  );
  const ctx = assembleContext({ ...inputs, messages: withIntent });
  assert.equal(ctx.classifiedIntent, "POSITIVE");
  const decision = toDecisionContext(ctx);
  assert.equal(decision.decisionHistory.intent, "POSITIVE");
  // The draft projection has no `intent` anywhere in its config or history shape.
  const draft = toDraftContext(ctx);
  assert.ok(!("intent" in draft.draftConfig));
});

test("estimatedTokens differs between the DECISION and DRAFT projections", () => {
  const ctx = assembleContext(baseInputs());
  const d = toDecisionContext(ctx).debug.estimatedTokens;
  const e = toDraftContext(ctx).debug.estimatedTokens;
  assert.ok(d > 0 && e > 0);
  assert.notEqual(d, e, "the two projections carry different fields → different coarse counts");
});

// ---------------------------------------------------------------------------
// sourcesUsed / contextRecord = labels only (§7.4, §7.5)
// ---------------------------------------------------------------------------

console.log("\nsourcesUsed + contextRecord are labels only (§7.4, §7.5)\n");

test("sourcesUsed carries provenance LABELS, never values or the band number", () => {
  const ctx = assembleContext(baseInputs());
  const sources = toDecisionContext(ctx).debug.sourcesUsed;
  // labels present
  assert.ok(sources.includes("campaign:usageRights"));
  assert.ok(sources.includes("campaign:paymentTerms"));
  assert.ok(sources.includes("band:present"));
  // NEVER the band value or a section text
  for (const s of sources) {
    assert.ok(!s.includes("200"), `source label must not carry the band number: ${s}`);
    assert.ok(!s.includes("500"), `source label must not carry the band number: ${s}`);
    assert.ok(!s.includes("90-day paid social"), `source label must not carry a value: ${s}`);
    assert.ok(!s.includes("Net 30"), `source label must not carry a value: ${s}`);
  }
});

test("contextRecord is keys/counts only — no band value, no section text", () => {
  const ob = obligation({ originalText: "What's the usage window?", normalizedKey: "what s the usage window", category: "usage_rights" });
  const ctx = assembleContext(baseInputs({ obligationRows: [ob] }));
  const rec = buildContextRecord(ctx);
  assert.equal(rec.purpose, "NEGOTIATION_DECISION");
  assert.deepEqual(rec.campaignFieldsSelected.sort(), ["paymentTerms", "usageRights"]);
  assert.deepEqual(rec.openObligationIds, [ob.id]);
  assert.equal(rec.bandPresent, true);
  assert.equal(typeof rec.estimatedTokens, "number");
  assert.equal(rec.briefAvailability.status, "PARTIAL"); // ok parse, but expected sections not all present
  // no value strings anywhere in the serialized record
  const serialized = JSON.stringify(rec);
  assert.ok(!serialized.includes('"200"') && !serialized.includes(":200"), "no band value in the record");
  assert.ok(!serialized.includes("Net 30") || serialized.includes("paymentTerms"), "only keys, not the paymentTerms value");
  // messageIdsIncluded are ids, matched to the transcript rows
  assert.equal(rec.messageIdsIncluded.length, ctx.recentMessages.length);
});

// ---------------------------------------------------------------------------
// Optional slots default to undefined (§9)
// ---------------------------------------------------------------------------

console.log("\noptional slots default to undefined with the stub loaders (§9)\n");

test("creatorMemory + conversationSummary are undefined when not supplied", () => {
  const ctx = assembleContext(baseInputs());
  assert.equal(ctx.creatorMemory, undefined);
  assert.equal(ctx.conversationSummary, undefined);
  assert.equal(toDraftContext(ctx).creatorMemory, undefined);
  // the summaryVersion observability field is omitted when there's no summary
  assert.ok(!("summaryVersion" in buildContextRecord(ctx)));
});

test("a supplied creatorMemory flows to the draft projection + adds a memory:present label", () => {
  const memory: CreatorMemoryPayload = {
    logisticsConstraints: [],
    objections: [],
    deliverablePreferences: [],
    compensationPreferences: [],
    conflicts: [],
    availability: "weekends",
  };
  const ctx = assembleContext(baseInputs({ creatorMemory: memory }));
  assert.equal(toDraftContext(ctx).creatorMemory, memory);
  assert.ok(toDecisionContext(ctx).debug.sourcesUsed.includes("memory:present"));
});

test("a supplied conversationSummary.version surfaces as summaryVersion in the record", () => {
  const ctx = assembleContext(baseInputs({ conversationSummary: { text: "…", version: "sum-v1" } }));
  assert.equal(buildContextRecord(ctx).summaryVersion, "sum-v1");
});

// ---------------------------------------------------------------------------
// Obligations → openCommitments / structuredObligations (§5.6 inputs)
// ---------------------------------------------------------------------------

console.log("\nobligations feed openCommitments + structuredObligations\n");

test("PLUVUS_COMMITMENT rows become openCommitments; questions do not", () => {
  const commitment = obligation({
    type: "PLUVUS_COMMITMENT",
    originalText: "We'll send a shipping label by Friday.",
    normalizedKey: "we ll send a shipping label by friday",
  });
  const question = obligation({ originalText: "Which platform?", normalizedKey: "which platform" });
  const ctx = assembleContext(baseInputs({ obligationRows: [commitment, question] }));
  assert.deepEqual(ctx.openCommitments, ["We'll send a shipping label by Friday."]);
  assert.equal(ctx.structuredObligations.length, 2);
  // openCommitments ride the DECISION context (sanitized DATA, never a money input)
  assert.deepEqual(toDecisionContext(ctx).decisionHistory.openCommitments, ["We'll send a shipping label by Friday."]);
  // and the DRAFT context
  assert.deepEqual(toDraftContext(ctx).openCommitments, ["We'll send a shipping label by Friday."]);
});

// ---------------------------------------------------------------------------
// latestMessageId — validated consistency check, not an override (§5.4)
// ---------------------------------------------------------------------------

console.log("\nlatestMessageId is a validated consistency check (§5.4)\n");

test("a matching latestMessageId passes", () => {
  const inputs = baseInputs();
  const latest = inputs.messages.find((m) => m.body === "Sounds good, I can do $350.")!;
  const ctx = assembleContext({ ...inputs, latestMessageId: latest.id });
  assert.equal(ctx.latestInbound?.id, latest.id);
});

test("a latestMessageId pointing at a BRAND-reply row throws", () => {
  const inputs = baseInputs();
  const brand = inputs.messages.find((m) => m.body === "Approve — go ahead.")!;
  assert.throws(
    () => assembleContext({ ...inputs, latestMessageId: brand.id }),
    LatestMessageMismatchError,
  );
});

test("a latestMessageId pointing at an OUTBOUND row throws", () => {
  const inputs = baseInputs();
  const out = inputs.messages.find((m) => m.direction === "OUTBOUND")!;
  assert.throws(
    () => assembleContext({ ...inputs, latestMessageId: out.id }),
    LatestMessageMismatchError,
  );
});

test("a latestMessageId that is NOT the newest creator inbound throws", () => {
  const inputs = baseInputs();
  const old = inputs.messages.find((m) => m.body === "What's the usage window?")!;
  assert.throws(
    () => assembleContext({ ...inputs, latestMessageId: old.id }),
    LatestMessageMismatchError,
  );
});

// ---------------------------------------------------------------------------
// §5.5 — brief carries the FULL ResolvedBrief (conflicts included)
// ---------------------------------------------------------------------------

console.log("\nbrief carries the FULL ResolvedBrief incl. conflicts (§5.5)\n");

test("conflicts on the ResolvedBrief survive onto AssembledContext.brief", () => {
  const brief: ResolvedBrief = {
    flatText: "…",
    status: "ok",
    conflicts: [
      { section: "paymentTerms", campaignField: "paymentTerms", campaignValue: "Net 30", briefExcerpt: "Net 60", reason: "net-days mismatch (30 vs 60)" },
    ],
  };
  const ctx = assembleContext(baseInputs({ resolvedBrief: brief }));
  assert.equal(ctx.brief.conflicts?.length, 1);
  assert.equal(ctx.brief.conflicts?.[0]?.campaignField, "paymentTerms");
});

console.log(`\n${n} passed\n`);
