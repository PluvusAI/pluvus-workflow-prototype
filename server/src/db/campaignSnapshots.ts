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
