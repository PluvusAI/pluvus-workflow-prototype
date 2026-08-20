/**
 * PLU-137 (1c) §6 — PURE unit tests for snapshot-driven context (no DB, no network).
 *
 * Run with:
 *   node --import tsx --test src/engine/conversationContext.snapshots.test.ts
 *
 * Covers the projection/observability half of PLU-137 against hand-built fixtures
 * (a NegotiationPolicySnapshot literal threaded through assembleContext). The
 * DB-backed loader + integrity-return live in campaignSnapshots.db.test.ts. Asserts
 * (one per distinct behavior):
 *   - DecisionContext carries policyAuthority when a policy snapshot is present (E5);
 *   - a GIFT/affiliate-shaped policy (null fee fields) still projects (E12 corollary);
 *   - no-policy turn: policyAuthority ABSENT + legacyFallbackUsed true (R1/§5);
 *   - DraftContext STRUCTURALLY excludes every POLICY_SNAPSHOT_KEY from the provider
 *     payload — THE money-safety test (E6), inspecting the actual draftConfig object;
 *   - policySnapshotId is withheld from an unauthorized (draft) purpose (Defect 4).
 */

import assert from "node:assert/strict";
import type {
  Campaign,
  CampaignTermsSnapshot,
  ConversationObligation,
  Creator,
  Event,
  ExecutionInstance,
  Message,
  NegotiationPolicySnapshot,
} from "../db/schema.js";
import type { NodeSnapshot } from "./types.js";
import type { ResolvedBrief } from "./executors/briefKnowledge.js";
import { mergeCampaignFallback } from "./campaignContext.js";
import {
  assembleContext,
  toDecisionContext,
  toDraftContext,
  buildContextRecord,
  POLICY_SNAPSHOT_KEYS,
  type AssembleInputs,
} from "./conversationContext.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// Fixtures (mirror conversationContext.test.ts)
// ---------------------------------------------------------------------------

const INSTANCE_ID = "inst1";

function inst(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: INSTANCE_ID,
    currentState: "NEGOTIATING",
    negotiationRound: 1,
    campaignTermsSnapshotId: null,
    negotiationPolicySnapshotId: null,
    ...overrides,
  } as ExecutionInstance;
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

// A full PAID policy snapshot — the private authority. The distinctive VALUES here
// (44444/55555/…) are what the money-safety test proves never reach the draft payload.
function policySnapshot(
  overrides: Partial<NegotiationPolicySnapshot> = {},
): NegotiationPolicySnapshot {
  return {
    id: "polsnap1",
    campaignId: "camp1",
    floorCents: 20000,
    ceilingCents: 50000,
    preferredFeeCents: 44444,
    // PLU-136 1b.b — commissionRate split into private floor/ceiling/preferred.
    commissionFloorRate: 0.1,
    commissionCeilingRate: 0.25,
    preferredCommissionRate: 0.15,
    maxRounds: 3,
    openingOfferPosition: 0.6,
    overCeilingTolerance: 0.1,
    negotiationGuidance: "SECRET-GUIDANCE-55555 push hard on exclusivity",
    // PLU-136 1b.b — private gift-negotiation authority (also never reaches draft).
    giftSubstitutionAllowed: true,
    giftValueFlexibilityCents: 66666,
    negotiableTerms: ["timeline"],
    nonNegotiableTerms: ["usage rights"],
    launchedAt: new Date(2026, 0, 1),
    createdAt: new Date(2026, 0, 1),
    ...overrides,
  } as NegotiationPolicySnapshot;
}

function termsSnapshot(overrides: Partial<CampaignTermsSnapshot> = {}): CampaignTermsSnapshot {
  return {
    id: "termsnap1",
    campaignId: "camp1",
    detailsSnapshot: { objective: "Drive signups", usageRights: "90-day paid social" },
    briefExtractionId: null,
    launchedAt: new Date(2026, 0, 1),
    createdBy: null,
    createdAt: new Date(2026, 0, 1),
    ...overrides,
  } as CampaignTermsSnapshot;
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

function baseInputs(overrides: Partial<AssembleInputs> = {}): AssembleInputs {
  const inbound = msg({
    direction: "INBOUND",
    body: "Sounds good, I can do $350.",
    externalMessageId: "ext-in-1",
    receivedAt: new Date(2026, 0, 1, 0, 0, 30),
  });
  const resolvedBrief: ResolvedBrief = { flatText: "Brief: usage is 90 days.", status: "ok" };
  const built: AssembleInputs = {
    purpose: "NEGOTIATION_DECISION",
    instance: inst(),
    creator: { id: "c1", name: "Maya", email: "maya@example.com" } as Creator,
    campaign: null as Campaign | null,
    node,
    nodeGraph,
    messages: [inbound],
    events: [] as Event[],
    obligationRows: [] as ConversationObligation[],
    resolvedBrief,
    mergedConfig: {},
    ...overrides,
  };
  if (!("mergedConfig" in overrides)) {
    built.mergedConfig = mergeCampaignFallback(built.node.config, built.campaign);
  }
  return built;
}

// ---------------------------------------------------------------------------
// DecisionContext gets the private policy authority (E5, §3a)
// ---------------------------------------------------------------------------

console.log("\nDecisionContext private policy authority (E5, §3a)\n");

test("policyAuthority is attached to DecisionContext when a policy snapshot is present", () => {
  const ctx = assembleContext(baseInputs({ policySnapshot: policySnapshot() }));
  const decision = toDecisionContext(ctx);
  assert.ok(decision.policyAuthority, "decision must carry policyAuthority");
  assert.equal(decision.policyAuthority?.floorCents, 20000);
  assert.equal(decision.policyAuthority?.ceilingCents, 50000);
  assert.equal(decision.policyAuthority?.preferredFeeCents, 44444);
  assert.equal(decision.policyAuthority?.negotiationGuidance, "SECRET-GUIDANCE-55555 push hard on exclusivity");
  assert.equal(decision.debug.policyPresent, true);
});

test("a GIFT/affiliate policy with NULL fee fields still projects (E12 corollary — no fee gates load)", () => {
  const gift = policySnapshot({
    floorCents: null,
    ceilingCents: null,
    preferredFeeCents: null,
    commissionCeilingRate: 0.2, // commission-only deal
    negotiationGuidance: "gift only, no cash",
  });
  const ctx = assembleContext(baseInputs({ policySnapshot: gift }));
  const decision = toDecisionContext(ctx);
  assert.ok(decision.policyAuthority, "policyAuthority present even with null fee fields");
  assert.equal(decision.policyAuthority?.floorCents, null);
  assert.equal(decision.policyAuthority?.commissionCeilingRate, 0.2);
  assert.equal(decision.policyAuthority?.negotiationGuidance, "gift only, no cash");
});

test("no-policy turn: policyAuthority ABSENT + legacyFallbackUsed true (emptiness contract, R1/§5)", () => {
  const ctx = assembleContext(baseInputs());
  const decision = toDecisionContext(ctx);
  // No policyAuthority key at all (not `undefined` — absent), so the serialized
  // decision object is unchanged from a world that never knew about snapshots.
  assert.ok(!("policyAuthority" in decision), "policyAuthority must be ABSENT, not undefined, when no snapshot");
  assert.equal(decision.debug.policyPresent, false);
  // A legacy no-snapshot turn is flagged for observability; no snapshot ids recorded.
  const rec = buildContextRecord(ctx);
  assert.equal(rec.legacyFallbackUsed, true);
  assert.equal(rec.termsSnapshotId, undefined);
  assert.equal(rec.policySnapshotId, undefined);
});

// ---------------------------------------------------------------------------
// DraftContext structural exclusion — THE money-safety test (E6, §3b)
// ---------------------------------------------------------------------------

console.log("\nDraftContext structural exclusion of private policy (E6, §3b)\n");

test("draftConfig (the provider payload) carries NONE of POLICY_SNAPSHOT_KEYS", () => {
  const ctx = assembleContext(baseInputs({ policySnapshot: policySnapshot() }));
  const draft = toDraftContext(ctx);
  for (const k of POLICY_SNAPSHOT_KEYS) {
    assert.ok(!(k in draft.draftConfig), `draftConfig must NOT carry policy key ${k}`);
  }
  // And the actual SECRET VALUES never appear anywhere in the serialized draft payload.
  const serialized = JSON.stringify(draft);
  assert.ok(!serialized.includes("44444"), "preferredFeeCents value must not reach the draft");
  assert.ok(!serialized.includes("SECRET-GUIDANCE-55555"), "negotiationGuidance must not reach the draft");
});

test("PLU-137/138: draftConfig PUBLIC terms come from the terms snapshot, not stale nodeGraph", () => {
  // Stale nodeGraph public terms + a poisoned band; the pinned snapshot supplies the
  // real public terms. The DRAFT copy must quote the SNAPSHOT values, and STILL carry
  // no private band (money-safety unchanged).
  const staleConfig = {
    commissionRate: 10, // stale nodeGraph commission
    rewardDescription: "old widget", // stale nodeGraph reward
    termFloor: { rate: 999 }, // poisoned band — must never reach draft anyway
    termCeiling: { rate: 9999 },
    minBudget: 999,
    maxBudget: 9999,
  };
  const snap = termsSnapshot({
    detailsSnapshot: {
      publicCommissionRate: 8, // the AUTHORITATIVE public commission
      productOrOffer: "new gift box", // maps to rewardDescription
      deliverables: "1 Reel + 2 Stories",
    },
  });
  const ctx = assembleContext(baseInputs({ purpose: "EMAIL_DRAFT", termsSnapshot: snap, mergedConfig: staleConfig }));
  const draft = toDraftContext(ctx);

  // Public terms are the SNAPSHOT's, not the stale nodeGraph copies.
  assert.equal(draft.draftConfig["commissionRate"], 8, "commission must come from the snapshot (8), not stale nodeGraph (10)");
  assert.equal(draft.draftConfig["rewardDescription"], "new gift box", "reward must come from the snapshot, not 'old widget'");
  assert.equal(draft.draftConfig["deliverables"], "1 Reel + 2 Stories", "deliverables must come from the snapshot");

  // Band still structurally absent — the public overlay never re-introduces it.
  for (const k of ["minBudget", "maxBudget", "termFloor", "termCeiling"] as const) {
    assert.ok(!(k in draft.draftConfig), `draftConfig must NOT carry band key ${k}`);
  }
  assert.ok(!JSON.stringify(draft).includes("9999"), "poisoned ceiling value must not reach the draft");
});

// ---------------------------------------------------------------------------
// Observability: the PRIVATE policy id is gated on an authorized purpose (Defect 4).
// Value-leak prevention (E11) is asserted on the real record in the DB e2e test.
// ---------------------------------------------------------------------------

console.log("\nobservability: policySnapshotId gated on authorized purpose (Defect 4)\n");

test("policySnapshotId is OMITTED for an unauthorized (draft) purpose; public terms id still shown", () => {
  const ctx = assembleContext(
    baseInputs({ purpose: "EMAIL_DRAFT", policySnapshot: policySnapshot(), termsSnapshot: termsSnapshot() }),
  );
  const rec = buildContextRecord(ctx);
  assert.equal(rec.termsSnapshotId, "termsnap1", "public terms id still appears");
  assert.equal(rec.policySnapshotId, undefined, "private policy id withheld from an unauthorized purpose");
});

console.log(`\n${n} passed\n`);
