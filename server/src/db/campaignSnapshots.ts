// PLU-137 (1c): read the immutable launch snapshots an execution is PINNED to
// (ExecutionInstance.campaignTermsSnapshotId / .negotiationPolicySnapshotId) BY id.
// resolveCampaignLaunchContext (campaigns.ts) reads them by campaignId to STAMP the
// pin at enrollment; these read the already-pinned rows back BY id at negotiation
// time. Tx-aware `client` (same convention as the rest of db/*) so the context
// builder loads them inside its existing read-tx (build.ts:95).
import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  campaignTermsSnapshots,
  negotiationPolicySnapshots,
  type CampaignTermsSnapshot,
  type NegotiationPolicySnapshot,
} from "./schema.js";

export async function getCampaignTermsSnapshotById(
  id: string,
  client: Db | DbTx = db,
): Promise<CampaignTermsSnapshot | undefined> {
  const [row] = await client
    .select()
    .from(campaignTermsSnapshots)
    .where(eq(campaignTermsSnapshots.id, id))
    .limit(1);
  return row;
}

export async function getNegotiationPolicySnapshotById(
  id: string,
  client: Db | DbTx = db,
): Promise<NegotiationPolicySnapshot | undefined> {
  const [row] = await client
    .select()
    .from(negotiationPolicySnapshots)
    .where(eq(negotiationPolicySnapshots.id, id))
    .limit(1);
  return row;
}

// PLU-138 (1d): the post-acceptance executors (contentBrief / rewardSetup /
// operatorHandoff / brandApproval / partnership) are contract-forming but do NOT
// build a conversation context — so they have no DecisionContext and can't reach
// the pinned snapshot the way negotiation.ts does. This is the executor-side
// equivalent of loadPinnedSnapshots for the PUBLIC terms only: it reads the pinned
// CampaignTermsSnapshot by id with the SAME integrity discipline (missing /
// cross-campaign are explicit failures, never a silent config read), so a stale or
// mis-pinned snapshot escalates instead of quietly falling back to nodeGraph.
//
// Returns { terms } on success (or when nothing is pinned → { terms: undefined },
// the legacy no-snapshot journey → the caller keeps its existing config chain), or
// { integrityFailure } which the caller must route to MANUAL_REVIEW.
export interface PinnedTermsResult {
  terms?: CampaignTermsSnapshot | undefined;
  integrityFailure?: { reason: string } | undefined;
}

export async function loadPinnedTermsSnapshotForExecutor(
  instance: { campaignTermsSnapshotId: string | null },
  expectedCampaignId: string | null | undefined,
  client: Db | DbTx = db,
): Promise<PinnedTermsResult> {
  if (!instance.campaignTermsSnapshotId) return {}; // legacy no-snapshot journey
  const terms = await getCampaignTermsSnapshotById(instance.campaignTermsSnapshotId, client);
  if (!terms) return { integrityFailure: { reason: "terms_snapshot_missing" } };
  if (expectedCampaignId && terms.campaignId !== expectedCampaignId) {
    return { integrityFailure: { reason: "terms_snapshot_cross_campaign" } };
  }
  return { terms };
}
