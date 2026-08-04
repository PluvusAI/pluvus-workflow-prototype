/**
 * PLU-113 — unit tests for the PURE creator-memory helpers: evidence verification,
 * the deterministic structured checks, the write-plan builder, and the read block.
 *
 * Pure — no DB. Run with:
 *   npx tsx src/engine/executors/creatorMemory.test.ts
 */

import assert from "node:assert/strict";
import type { CampaignCreatorMemory } from "../../db/schema.js";
import type { ExtractedFact } from "../../adapters/negotiation/types.js";
import {
  verifyAndBuildMemoryWritePlan,
  buildCreatorMemoryBlock,
} from "./creatorMemory.js";
import { singletonSentinel } from "../memoryKeys.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const SRC = "msg-1";

function fact(over: Partial<ExtractedFact> & Pick<ExtractedFact, "key" | "value">): ExtractedFact {
  return { evidenceText: over.value, confidence: 0.9, ...over };
}

// A minimal live-head factory for buildCreatorMemoryBlock.
function head(over: Partial<CampaignCreatorMemory> & Pick<CampaignCreatorMemory, "key" | "value">): CampaignCreatorMemory {
  return {
    id: "m1",
    instanceId: "i1",
    status: "ACTIVE",
    valueNumber: null,
    normalizedValue: "x",
    category: null,
    currentRevisionId: null,
    conflictValue: null,
    conflictSourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as CampaignCreatorMemory;
}

// ---------------------------------------------------------------------------
// Evidence verification (Calvin review #3)
// ---------------------------------------------------------------------------

test("drops a fact whose evidence is NOT in the reply", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "AVAILABILITY", value: "away in August", evidenceText: "I love pizza" })],
    creatorReply: "I am busy this week but flexible otherwise.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("keeps a fact whose evidence IS in the reply", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({ key: "AVAILABILITY", value: "away until August", evidenceText: "travelling until August" }),
    ],
    creatorReply: "Heads up — I'm travelling until August, so a bit slow.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.key, "AVAILABILITY");
  assert.equal(plan[0]!.sourceMessageId, SRC);
  assert.equal(plan[0]!.evidenceText, "travelling until August");
});

test("drops a fact with no evidenceText", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [{ key: "OBJECTION", value: "no perpetual rights", evidenceText: "" }],
    creatorReply: "no perpetual rights please",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("drops a fact below the confidence floor", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "OBJECTION", value: "x", evidenceText: "x", confidence: 0.2 })],
    creatorReply: "x",
    sourceMessageId: SRC,
    minConfidence: 0.5,
  });
  assert.equal(plan.length, 0);
});

test("drops any fact when there is no source message (provenance required)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "AVAILABILITY", value: "away", evidenceText: "away" })],
    creatorReply: "I'll be away.",
    // no sourceMessageId
  });
  assert.equal(plan.length, 0);
});

test("drops an unknown key", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [{ key: "NONSENSE", value: "x", evidenceText: "x" }],
    creatorReply: "x here",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

// ---------------------------------------------------------------------------
// Deterministic structured checks (Calvin review #3)
// ---------------------------------------------------------------------------

test("MINIMUM_RATE requires a parseable number", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "somewhere around there", evidenceText: "around there" })],
    creatorReply: "my floor is around there",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("MINIMUM_RATE with a number is grounded (numeric mirror set)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "300", evidenceText: "I can't go below 300" })],
    creatorReply: "Honestly I can't go below 300 for this.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.valueNumber, 300);
  assert.equal(plan[0]!.normalizedValue, singletonSentinel("MINIMUM_RATE"));
});

test("MANAGER_INVOLVED requires explicit manager wording", () => {
  const noWording = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MANAGER_INVOLVED", value: "true", evidenceText: "I'll check with someone" })],
    creatorReply: "I'll check with someone first.",
    sourceMessageId: SRC,
  });
  assert.equal(noWording.length, 0);

  const withWording = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MANAGER_INVOLVED", value: "true", evidenceText: "my manager handles rates" })],
    creatorReply: "my manager handles rates, loop them in.",
    sourceMessageId: SRC,
  });
  assert.equal(withWording.length, 1);
});

test("MANAGER_CONTACT requires an email or the value present in evidence", () => {
  const good = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({ key: "MANAGER_CONTACT", value: "jane@mgmt.co", evidenceText: "email jane@mgmt.co" }),
    ],
    creatorReply: "please email jane@mgmt.co about this",
    sourceMessageId: SRC,
  });
  assert.equal(good.length, 1);
});

// ---------------------------------------------------------------------------
// Founder review — value/evidence AGREEMENT, not merely both-present
// ---------------------------------------------------------------------------

test("MINIMUM_RATE DROPS when the stored number disagrees with the evidence number", () => {
  // Creator wrote $500; model tried to store $800 with that same evidence. The
  // generic substring check passes (the phrase is in the reply) but the numbers
  // disagree, so the fact must be dropped.
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({
        key: "MINIMUM_RATE",
        value: "$800",
        evidenceText: "The lowest I can do is $500",
      }),
    ],
    creatorReply: "The lowest I can do is $500.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("MINIMUM_RATE KEEPS when the stored number matches the evidence number", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({
        key: "MINIMUM_RATE",
        value: "$500",
        evidenceText: "The lowest I can do is $500",
      }),
    ],
    creatorReply: "The lowest I can do is $500.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.valueNumber, 500);
});

test("MANAGER_CONTACT DROPS when the stored email is not the one in the evidence", () => {
  // Evidence names sarah@; model tried to store john@. Must be dropped.
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({
        key: "MANAGER_CONTACT",
        value: "john@example.com",
        evidenceText: "Please contact Sarah at sarah@example.com",
      }),
    ],
    creatorReply: "Please contact Sarah at sarah@example.com.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("MANAGER_CONTACT KEEPS when the stored email exactly matches the evidence email", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({
        key: "MANAGER_CONTACT",
        value: "sarah@example.com",
        evidenceText: "Please contact Sarah at sarah@example.com",
      }),
    ],
    creatorReply: "Please contact Sarah at sarah@example.com.",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.value, "sarah@example.com");
});

test("MANAGER_CONTACT email match is case-insensitive", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({
        key: "MANAGER_CONTACT",
        value: "Sarah@Example.com",
        evidenceText: "contact sarah@example.com",
      }),
    ],
    creatorReply: "contact sarah@example.com",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
});

// ---------------------------------------------------------------------------
// Founder review — rate parsing (k suffix + ambiguity rejection)
// ---------------------------------------------------------------------------

test("MINIMUM_RATE parses a k suffix (1.5k => 1500, not 1.5)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "1.5k", evidenceText: "my floor is 1.5k" })],
    creatorReply: "my floor is 1.5k for a video",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.valueNumber, 1500);
});

test("MINIMUM_RATE parses a bare k suffix (1k => 1000)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "1k", evidenceText: "at least 1k" })],
    creatorReply: "I'd need at least 1k",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.valueNumber, 1000);
});

test("MINIMUM_RATE parses thousands separators (1,500 => 1500)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "1,500", evidenceText: "floor is 1,500" })],
    creatorReply: "floor is 1,500",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.valueNumber, 1500);
});

test("MINIMUM_RATE parses a non-dollar currency (€500 => 500)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "€500", evidenceText: "minimum €500" })],
    creatorReply: "minimum €500 per post",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.valueNumber, 500);
});

test("MINIMUM_RATE REJECTS an ambiguous range ($500-$700)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({ key: "MINIMUM_RATE", value: "$500-$700", evidenceText: "somewhere between $500-$700" }),
    ],
    creatorReply: "somewhere between $500-$700 depending on scope",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("MINIMUM_RATE REJECTS a compound figure ($500 per video + 10%)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({
        key: "MINIMUM_RATE",
        value: "$500 per video + 10%",
        evidenceText: "$500 per video + 10% of sales",
      }),
    ],
    creatorReply: "$500 per video + 10% of sales works",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

test("MINIMUM_RATE REJECTS a bare percentage (10%)", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "MINIMUM_RATE", value: "10%", evidenceText: "just 10% commission" })],
    creatorReply: "just 10% commission is fine",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 0);
});

// ---------------------------------------------------------------------------
// Validated requested rate (self-evidencing) + intra-turn dedup
// ---------------------------------------------------------------------------

test("REQUESTED_RATE comes from the validated ask, not the model's fact", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [fact({ key: "REQUESTED_RATE", value: "999", evidenceText: "999" })],
    creatorReply: "How about $450?",
    sourceMessageId: SRC,
    creatorRequestedRate: 450,
  });
  const rate = plan.find((p) => p.key === "REQUESTED_RATE");
  assert.ok(rate);
  assert.equal(rate!.valueNumber, 450); // the validated number, NOT the model's 999
});

test("two facts that normalize to the same (key,value) collapse", () => {
  const plan = verifyAndBuildMemoryWritePlan({
    creatorFacts: [
      fact({ key: "OBJECTION", value: "No perpetual rights", evidenceText: "no perpetual rights" }),
      fact({ key: "OBJECTION", value: "no perpetual rights!", evidenceText: "no perpetual rights" }),
    ],
    creatorReply: "no perpetual rights please",
    sourceMessageId: SRC,
  });
  assert.equal(plan.length, 1);
});

// ---------------------------------------------------------------------------
// Read block (buildCreatorMemoryBlock)
// ---------------------------------------------------------------------------

test("read block returns null when nothing live", () => {
  assert.equal(buildCreatorMemoryBlock([]), null);
  assert.equal(
    buildCreatorMemoryBlock([head({ key: "OBJECTION", value: "x", status: "REMOVED" })]),
    null,
  );
});

test("read block maps rate to numeric CONTEXT + surfaces a conflict", () => {
  const payload = buildCreatorMemoryBlock([
    head({ key: "REQUESTED_RATE", value: "450", valueNumber: 450 }),
    head({
      key: "AVAILABILITY",
      value: "away in August",
      status: "CONFLICTED",
      conflictValue: "free in August",
    }),
  ]);
  assert.ok(payload);
  assert.equal(payload!.requestedRate, 450);
  assert.equal(payload!.availability, "away in August");
  assert.equal(payload!.conflicts.length, 1);
  assert.equal(payload!.conflicts[0]!.priorValue, "free in August");
  assert.equal(payload!.conflicts[0]!.newValue, "away in August");
});

console.log(`\n${n} creatorMemory assertions passed.`);
