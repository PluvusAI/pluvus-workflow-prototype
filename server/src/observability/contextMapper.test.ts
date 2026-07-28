/**
 * PLU-81 §7.2 — mapContext (event-log → ContextDTO) unit tests.
 * Pure mapping; run with:
 *   npx tsx src/observability/contextMapper.test.ts
 *
 * Asserts: the sanitized context record is read off the NEGOTIATION_TURN `context`
 * sub-object; the LATEST turn wins; a turn with no context sub-object is skipped; an
 * empty / context-free log maps to undefined (empty panel); the mapped DTO carries
 * labels/keys/counts only (a well-formed record has no value strings).
 */

import assert from "node:assert/strict";
import type { Event } from "../db/schema.js";
import { mapContext } from "./repository.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

let seq = 0;
function ev(type: Event["type"], payload: unknown): Event {
  seq++;
  return {
    id: `e${seq}`,
    instanceId: "inst1",
    type,
    nodeId: null,
    payload: payload as Event["payload"],
    occurredAt: new Date(2026, 0, 1, 0, 0, seq),
  };
}

const sampleContext = {
  purpose: "NEGOTIATION_DECISION",
  round: 1,
  messageIdsIncluded: ["m1", "m2", "m3"],
  eventCount: 1,
  campaignFieldsSelected: ["usageRights", "paymentTerms"],
  briefSectionsUsed: ["paymentTerms"],
  openObligationIds: ["o1"],
  estimatedTokens: 512,
  sourcesUsed: ["campaign:usageRights", "brief:paymentTerms", "band:present"],
  bandPresent: true,
};

console.log("\nmapContext — nothing to report\n");

test("empty event list → undefined", () => {
  assert.equal(mapContext([]), undefined);
});

test("a NEGOTIATION_TURN with no context sub-object → undefined", () => {
  const events = [ev("NEGOTIATION_TURN", { outcome: "counter", round: 1 })];
  assert.equal(mapContext(events), undefined);
});

console.log("\nmapContext — reads the record + latest wins\n");

test("reads the sanitized context record off a NEGOTIATION_TURN.context sub-object", () => {
  const events = [ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, context: sampleContext })];
  const c = mapContext(events)!;
  assert.ok(c);
  assert.equal(c.purpose, "NEGOTIATION_DECISION");
  assert.equal(c.round, 1);
  assert.deepEqual(c.messageIdsIncluded, ["m1", "m2", "m3"]);
  assert.equal(c.eventCount, 1);
  assert.deepEqual(c.campaignFieldsSelected, ["usageRights", "paymentTerms"]);
  assert.deepEqual(c.briefSectionsUsed, ["paymentTerms"]);
  assert.deepEqual(c.openObligationIds, ["o1"]);
  assert.equal(c.estimatedTokens, 512);
  assert.deepEqual(c.sourcesUsed, ["campaign:usageRights", "brief:paymentTerms", "band:present"]);
  assert.equal(c.bandPresent, true);
});

test("the LATEST context record across turns wins (chronological overwrite)", () => {
  const events = [
    ev("NEGOTIATION_TURN", { round: 0, context: { ...sampleContext, round: 0, estimatedTokens: 100 } }),
    ev("NEGOTIATION_TURN", { round: 1, context: { ...sampleContext, round: 1, estimatedTokens: 900 } }),
  ];
  const c = mapContext(events)!;
  assert.equal(c.round, 1);
  assert.equal(c.estimatedTokens, 900);
});

test("a context record with no purpose is ignored", () => {
  const events = [ev("NEGOTIATION_TURN", { round: 0, context: { round: 0, sourcesUsed: [] } })];
  assert.equal(mapContext(events), undefined);
});

test("summaryVersion is surfaced only when present", () => {
  const withVer = [ev("NEGOTIATION_TURN", { round: 0, context: { ...sampleContext, summaryVersion: "sum-v1" } })];
  assert.equal(mapContext(withVer)!.summaryVersion, "sum-v1");
  const without = [ev("NEGOTIATION_TURN", { round: 0, context: sampleContext })];
  assert.equal(mapContext(without)!.summaryVersion, undefined);
});

test("band presence is a boolean flag, never a value", () => {
  const events = [ev("NEGOTIATION_TURN", { round: 0, context: { ...sampleContext, bandPresent: false } })];
  const c = mapContext(events)!;
  assert.equal(c.bandPresent, false);
  // The whole serialized DTO carries no floor/ceiling number.
  const serialized = JSON.stringify(c);
  assert.ok(!serialized.includes('"200"') && !serialized.includes('"500"'), "no band value in the DTO");
});

test("a non-NEGOTIATION_TURN event carrying a context field is ignored", () => {
  const events = [ev("STATE_TRANSITION", { context: sampleContext })];
  assert.equal(mapContext(events), undefined);
});

console.log(`\n${n} passed\n`);
