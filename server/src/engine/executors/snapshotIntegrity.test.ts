/**
 * PLU-137 — snapshot integrity guard (Harshit review).
 * Pure, offline (no DB). Run with:
 *   node --import tsx --test src/engine/executors/snapshotIntegrity.test.ts
 *
 * loadPinnedSnapshots FAILS CLOSED with `campaign_unresolved` when a pin exists
 * but expectedCampaignId can't be resolved (deleted campaign / DB error) — and
 * does so BEFORE any DB read (proven by a client that throws on use). (:507)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadPinnedSnapshots } from "./negotiation.js";
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
