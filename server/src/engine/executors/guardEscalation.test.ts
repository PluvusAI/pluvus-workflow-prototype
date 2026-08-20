/**
 * PLU-143 — pure unit tests for the Content Brief escalation guards
 * (blockedByCampaignBriefMismatch / blockedByMissingFinalAgreement /
 * blockedByMissingFixedFee / blockedByIncompleteDeliverables). No DB, no
 * network. Run:
 *   npx tsx --test src/engine/executors/guardEscalation.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedByCampaignBriefMismatch,
  blockedByMissingFinalAgreement,
  blockedByMissingFixedFee,
  blockedByIncompleteDeliverables,
} from "./guardEscalation.js";
import type { CampaignBriefValidationResult } from "../../db/campaignBriefValidation.js";

function mismatchResult(
  category: CampaignBriefValidationResult["mismatchCategory"],
): CampaignBriefValidationResult {
  return {
    status: "BLOCKED",
    brief: null,
    expected: { campaignId: "camp-1", campaignTermsSnapshotId: "snap-1" },
    stored: { campaignId: null, campaignTermsSnapshotId: null },
    mismatchCategory: category,
    regenerationAllowed: false,
    nextAction: "operator_review_required",
    diagnostic: "test diagnostic",
  };
}

test("blockedByCampaignBriefMismatch routes to MANUAL_REVIEW with the mismatch category attached", () => {
  const r = blockedByCampaignBriefMismatch("CONTENT_BRIEF", mismatchResult("CROSS_CAMPAIGN"));
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.equal(r.eventType, "MANUAL_REVIEW_FLAGGED");
  assert.equal(r.eventPayload?.["outcome"], "ESCALATE");
  assert.equal(r.eventPayload?.["reason"], "campaign_brief_mismatch");
  assert.equal(r.eventPayload?.["mismatchCategory"], "CROSS_CAMPAIGN");
  assert.equal(r.eventPayload?.["node"], "CONTENT_BRIEF");
});

test("blockedByMissingFinalAgreement routes to MANUAL_REVIEW with an auditable reason", () => {
  const r = blockedByMissingFinalAgreement("CONTENT_BRIEF");
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.equal(r.eventType, "MANUAL_REVIEW_FLAGGED");
  assert.equal(r.eventPayload?.["outcome"], "ESCALATE");
  assert.equal(r.eventPayload?.["reason"], "no_final_agreement");
  assert.equal(r.eventPayload?.["node"], "CONTENT_BRIEF");
});

test("blockedByMissingFixedFee routes to MANUAL_REVIEW with an auditable reason", () => {
  const r = blockedByMissingFixedFee("CONTENT_BRIEF");
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.equal(r.eventType, "MANUAL_REVIEW_FLAGGED");
  assert.equal(r.eventPayload?.["outcome"], "ESCALATE");
  assert.equal(r.eventPayload?.["reason"], "missing_fixed_fee");
  assert.equal(r.eventPayload?.["node"], "CONTENT_BRIEF");
});

test("blockedByIncompleteDeliverables routes to MANUAL_REVIEW and carries the validator's detail", () => {
  const r = blockedByIncompleteDeliverables("CONTENT_BRIEF", "finalDeliverables is empty");
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.equal(r.eventType, "MANUAL_REVIEW_FLAGGED");
  assert.equal(r.eventPayload?.["outcome"], "ESCALATE");
  assert.equal(r.eventPayload?.["reason"], "incomplete_final_deliverables");
  assert.equal(r.eventPayload?.["detail"], "finalDeliverables is empty");
  assert.equal(r.eventPayload?.["node"], "CONTENT_BRIEF");
});

test("all four guards stamp completedAt (terminal escalation)", () => {
  for (const r of [
    blockedByCampaignBriefMismatch("CONTENT_BRIEF", mismatchResult("SNAPSHOT_MISMATCH")),
    blockedByMissingFinalAgreement("CONTENT_BRIEF"),
    blockedByMissingFixedFee("CONTENT_BRIEF"),
    blockedByIncompleteDeliverables("CONTENT_BRIEF", "bad shape"),
  ]) {
    assert.ok(r.completedAt instanceof Date);
  }
});
