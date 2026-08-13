/**
 * PLU-137 — snapshot integrity guard (Harshit / Greptile review).
 * Pure, offline (no DB). Run with:
 *   node --import tsx --test src/engine/executors/snapshotIntegrity.test.ts
 *
 * Covers:
 *   1. loadPinnedSnapshots FAILS CLOSED with `campaign_unresolved` when a pin
 *      exists but expectedCampaignId can't be resolved (deleted campaign / DB
 *      error) — and does so BEFORE any DB read (proven by a client that throws
 *      on use). (Harshit #3, :507)
 *   2. escalateSnapshotIntegrity is the pure MANUAL_REVIEW result carrying NO
 *      memoryWrites / obligationWrites — the property that lets the guard run
 *      before the agent so an invalid pin never persists agent-derived facts.
 *      (Harshit #2 / Greptile, ordering :1133)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { escalateSnapshotIntegrity, loadPinnedSnapshots } from "./negotiation.js";
import type { Db } from "../../db/drizzle.js";

// A client that explodes if touched — proves the guard returns before any DB read.
const explodingClient = new Proxy({}, {
  get() {
    throw new Error("DB must not be touched when the campaign is unresolved");
  },
}) as unknown as Db;

test("loadPinnedSnapshots fails closed with campaign_unresolved (terms pinned, no campaign)", async () => {
  const r = await loadPinnedSnapshots(
    { campaignTermsSnapshotId: "terms-1", negotiationPolicySnapshotId: null },
    "NEGOTIATION_DECISION",
    explodingClient,
    null, // expectedCampaignId unresolved (deleted campaign / DB error)
  );
  assert.deepEqual(r, { integrityFailure: { reason: "campaign_unresolved" } });
});

test("loadPinnedSnapshots fails closed with campaign_unresolved (policy pinned, no campaign)", async () => {
  const r = await loadPinnedSnapshots(
    { campaignTermsSnapshotId: null, negotiationPolicySnapshotId: "policy-1" },
    "NEGOTIATION_DECISION",
    explodingClient,
    undefined, // undefined is as unresolved as null
  );
  assert.deepEqual(r, { integrityFailure: { reason: "campaign_unresolved" } });
});

test("loadPinnedSnapshots does NOT fail closed when nothing is pinned (legacy journey)", async () => {
  // No pin ⇒ no campaign verification needed ⇒ empty result even with no campaign.
  const r = await loadPinnedSnapshots(
    { campaignTermsSnapshotId: null, negotiationPolicySnapshotId: null },
    "NEGOTIATION_DECISION",
    explodingClient,
    null,
  );
  assert.deepEqual(r, {});
});

test("escalateSnapshotIntegrity is terminal MANUAL_REVIEW with NO derived-fact writes", () => {
  // Greptile's artifact showed the LATE guard invoked the agent and persisted an
  // AVAILABILITY memory write. Moving it before the agent is only safe because the
  // result is pure and carries no agent-derived writes — assert that property.
  const r = escalateSnapshotIntegrity({ round: 2, reason: "terms_snapshot_cross_campaign" });
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.ok(r.completedAt instanceof Date, "terminal → completedAt stamped");
  assert.equal(r.eventType, "NEGOTIATION_TURN");
  const p = r.eventPayload as Record<string, unknown>;
  assert.equal(p["outcome"], "ESCALATE");
  assert.equal(p["reason"], "snapshot_integrity");
  assert.equal(p["integrityReason"], "terms_snapshot_cross_campaign");
  assert.equal(p["round"], 2);
  assert.ok(!("memoryWrites" in r), "integrity escalation must carry no memoryWrites");
  assert.ok(!("obligationWrites" in r), "integrity escalation must carry no obligationWrites");
});
