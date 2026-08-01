/**
 * PLU-82 §4.6 — mapKnowledge (event-log → knowledge DTO) unit tests.
 * Pure mapping; run with:
 *   npx tsx src/observability/knowledgeMapper.test.ts
 *
 * Asserts: conflicts + availability are read off the NEGOTIATION_TURN `knowledge`
 * sub-object; the LATEST availability wins; conflicts are UNIONed + deduped by
 * field+reason; resolvedSources come from the post-acceptance event payloads; an
 * empty/knowledge-free log maps to undefined (empty panel).
 */

import assert from "node:assert/strict";
import type { Event } from "../db/schema.js";
import { mapKnowledge } from "./repository.js";

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

console.log("\nmapKnowledge — nothing to report\n");

test("empty event list → undefined", () => {
  assert.equal(mapKnowledge([]), undefined);
});

test("turns with no knowledge sub-object → undefined", () => {
  const events = [ev("NEGOTIATION_TURN", { outcome: "counter", round: 1 })];
  assert.equal(mapKnowledge(events), undefined);
});

console.log("\nbriefAvailability — latest wins, stamped with round\n");

test("reads availability off a NEGOTIATION_TURN.knowledge record", () => {
  const events = [
    ev("NEGOTIATION_TURN", {
      outcome: "present_offer",
      round: 0,
      knowledge: { briefAvailability: { status: "PARTIAL", error: null, missingSections: ["exclusivity"] } },
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.ok(k);
  assert.equal(k.briefAvailability?.status, "PARTIAL");
  assert.deepEqual(k.briefAvailability?.missingSections, ["exclusivity"]);
  assert.equal(k.briefAvailability?.round, 0);
});

test("the LATEST availability across turns wins (chronological overwrite)", () => {
  const events = [
    ev("NEGOTIATION_TURN", {
      round: 0,
      knowledge: { briefAvailability: { status: "PARTIAL", error: null, missingSections: [] } },
    }),
    ev("NEGOTIATION_TURN", {
      round: 1,
      knowledge: { briefAvailability: { status: "AVAILABLE", error: null, missingSections: [] } },
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.briefAvailability?.status, "AVAILABLE");
  assert.equal(k.briefAvailability?.round, 1);
});

test("an unknown availability status is ignored (not mapped)", () => {
  const events = [
    ev("NEGOTIATION_TURN", {
      round: 0,
      knowledge: { briefAvailability: { status: "WAT", error: null, missingSections: [] } },
    }),
  ];
  // Nothing valid to report → undefined.
  assert.equal(mapKnowledge(events), undefined);
});

console.log("\nconflicts — unioned + deduped by field+reason\n");

test("collects conflict rows with all fields + round", () => {
  const events = [
    ev("NEGOTIATION_TURN", {
      round: 1,
      knowledge: {
        briefAvailability: { status: "AVAILABLE", error: null, missingSections: [] },
        conflicts: [
          {
            section: "paymentTerms",
            campaignField: "paymentTerms",
            campaignValue: "Net 30",
            briefExcerpt: "Net 60 within...",
            pageStart: 2,
            reason: "net-days mismatch (30 vs 60)",
          },
        ],
      },
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts.length, 1);
  const c = k.conflicts[0]!;
  assert.equal(c.campaignField, "paymentTerms");
  assert.equal(c.campaignValue, "Net 30");
  assert.equal(c.briefExcerpt, "Net 60 within...");
  assert.equal(c.pageStart, 2);
  assert.equal(c.reason, "net-days mismatch (30 vs 60)");
  assert.equal(c.round, 1);
});

test("the SAME conflict repeated across rounds is deduped (field+reason key)", () => {
  const conflict = {
    section: "paymentTerms",
    campaignField: "paymentTerms",
    campaignValue: "Net 30",
    briefExcerpt: "Net 60",
    reason: "net-days mismatch (30 vs 60)",
  };
  const events = [
    ev("NEGOTIATION_TURN", { round: 0, knowledge: { conflicts: [conflict] } }),
    ev("NEGOTIATION_TURN", { round: 1, knowledge: { conflicts: [conflict] } }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts.length, 1, "repeated conflict must dedupe");
  assert.equal(k.conflicts[0]!.round, 0, "first occurrence round is kept");
});

test("distinct conflicts on the same field (different reason) are both kept", () => {
  const events = [
    ev("NEGOTIATION_TURN", {
      round: 0,
      knowledge: {
        conflicts: [
          { section: "usageRights", campaignField: "usageRights", campaignValue: "90d", briefExcerpt: "180d", reason: "duration mismatch (90 vs 180 days)" },
        ],
      },
    }),
    ev("NEGOTIATION_TURN", {
      round: 1,
      knowledge: {
        conflicts: [
          { section: "usageRights", campaignField: "usageRights", campaignValue: "90d", briefExcerpt: "exclusive", reason: "some other reason" },
        ],
      },
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts.length, 2);
});

test("harvests conflicts from a material_knowledge_conflict ESCALATION payload (top-level conflicts)", () => {
  // The escalation payload puts conflicts at the top level (not under `knowledge`)
  // and carries reason=material_knowledge_conflict — the mapper must still surface
  // them so the turn that escalated shows its conflicts in the panel.
  const events = [
    ev("NEGOTIATION_TURN", {
      outcome: "ESCALATE",
      reason: "material_knowledge_conflict",
      round: 1,
      conflictFields: ["paymentTerms"],
      conflicts: [
        {
          section: "paymentTerms",
          campaignField: "paymentTerms",
          campaignValue: "Net 30",
          briefExcerpt: "Net 60",
          reason: "net-days mismatch (30 vs 60)",
        },
      ],
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts.length, 1);
  assert.equal(k.conflicts[0]!.campaignField, "paymentTerms");
  assert.equal(k.conflicts[0]!.round, 1);
});

test("a NON-material-conflict escalation with top-level conflicts is NOT harvested", () => {
  // Only the material_knowledge_conflict reason carries conflicts at top level;
  // a different escalation reason must not have its (absent) conflicts misread.
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "ESCALATE", reason: "escalated", round: 1 }),
  ];
  assert.equal(mapKnowledge(events), undefined);
});

console.log("\nconflicts — active vs cleared (review §6, recovery recording)\n");

const netConflict = {
  section: "paymentTerms",
  campaignField: "paymentTerms",
  campaignValue: "Net 30",
  briefExcerpt: "Net 60",
  reason: "net-days mismatch (30 vs 60)",
};

test("a conflict still present in the LATEST knowledge round is ACTIVE", () => {
  const events = [
    ev("NEGOTIATION_TURN", { round: 0, knowledge: { conflicts: [netConflict] } }),
    ev("NEGOTIATION_TURN", { round: 1, knowledge: { conflicts: [netConflict] } }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts.length, 1);
  assert.equal(k.conflicts[0]!.status, "active");
  assert.equal(k.conflicts[0]!.round, 0, "firstRound kept");
  assert.equal(k.conflicts[0]!.lastRound, 1, "lastRound advances on re-sighting");
});

test("a conflict ABSENT from a later re-resolution reads as CLEARED, not active (§6)", () => {
  // Round 1 conflicts; round 2 re-resolves the brief (knowledge block present) with
  // NO conflicts — the source was corrected. The earlier conflict must demote.
  const events = [
    ev("NEGOTIATION_TURN", {
      round: 1,
      knowledge: {
        briefAvailability: { status: "PARTIAL", error: null, missingSections: [] },
        conflicts: [netConflict],
      },
    }),
    ev("NEGOTIATION_TURN", {
      round: 2,
      knowledge: {
        // brief now clean — availability AVAILABLE, no conflicts array.
        briefAvailability: { status: "AVAILABLE", error: null, missingSections: [] },
      },
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts.length, 1);
  assert.equal(k.conflicts[0]!.status, "cleared", "corrected conflict must not read as live");
  assert.equal(k.conflicts[0]!.lastRound, 1);
  assert.equal(k.briefAvailability?.status, "AVAILABLE");
});

test("a later turn WITHOUT a knowledge block does not clear a standing conflict", () => {
  // A plain counter turn (no re-resolution) must not be treated as a clean
  // knowledge round — the conflict stays active.
  const events = [
    ev("NEGOTIATION_TURN", { round: 1, knowledge: { conflicts: [netConflict] } }),
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 2 }), // no knowledge block
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts[0]!.status, "active", "a non-knowledge turn is not a recovery signal");
});

test("conflicts with null rounds stay ACTIVE (can't prove recovery — conservative)", () => {
  const events = [
    ev("NEGOTIATION_TURN", { knowledge: { conflicts: [netConflict] } }), // no round
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.conflicts[0]!.status, "active");
});

test("recovery is per-field: one field clears while another stays active", () => {
  const usage = { section: "usageRights", campaignField: "usageRights", campaignValue: "90d", briefExcerpt: "180d", reason: "duration mismatch" };
  const events = [
    ev("NEGOTIATION_TURN", { round: 1, knowledge: { conflicts: [netConflict, usage] } }),
    ev("NEGOTIATION_TURN", { round: 2, knowledge: { conflicts: [usage] } }), // payment fixed, usage remains
  ];
  const k = mapKnowledge(events)!;
  const byField = Object.fromEntries(k.conflicts.map((c) => [c.campaignField, c.status]));
  assert.equal(byField["paymentTerms"], "cleared");
  assert.equal(byField["usageRights"], "active");
});

console.log("\nresolvedSources — from post-acceptance event payloads\n");

for (const t of ["DEAL_HANDOFF_REQUESTED", "REWARD_SETUP_SENT", "PAYMENT_INFO_SENT"] as const) {
  test(`reads resolvedSources off a ${t} payload`, () => {
    const events = [
      ev(t, {
        resolvedSources: { deliverables: "workflow_config", timeline: "campaign_default", paymentTerms: null },
      }),
    ];
    const k = mapKnowledge(events)!;
    assert.equal(k.resolvedSources["deliverables"], "workflow_config");
    assert.equal(k.resolvedSources["timeline"], "campaign_default");
    assert.equal(k.resolvedSources["paymentTerms"], null);
  });
}

test("the LATEST post-acceptance resolvedSources map wins", () => {
  const events = [
    ev("REWARD_SETUP_SENT", { resolvedSources: { deliverables: "negotiation_state" } }),
    ev("PAYMENT_INFO_SENT", { resolvedSources: { deliverables: "workflow_config" } }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.resolvedSources["deliverables"], "workflow_config");
});

console.log("\ncombined — availability + conflicts + sources together\n");

test("a full run maps all three sections", () => {
  const events = [
    ev("NEGOTIATION_TURN", {
      round: 0,
      knowledge: {
        briefAvailability: { status: "PARTIAL", error: null, missingSections: ["exclusivity"] },
        conflicts: [
          { section: "paymentTerms", campaignField: "paymentTerms", campaignValue: "Net 30", briefExcerpt: "Net 60", reason: "net-days mismatch (30 vs 60)" },
        ],
      },
    }),
    ev("DEAL_HANDOFF_REQUESTED", {
      resolvedSources: { deliverables: "workflow_config", paymentTerms: "campaign_default" },
    }),
  ];
  const k = mapKnowledge(events)!;
  assert.equal(k.briefAvailability?.status, "PARTIAL");
  assert.equal(k.conflicts.length, 1);
  assert.equal(k.resolvedSources["deliverables"], "workflow_config");
});

console.log(`\n${n} passed\n`);
