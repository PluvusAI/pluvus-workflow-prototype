/**
 * PLU-169 (1f) decision #4: one-time backfill assigning a stable `id` to every
 * existing `CampaignDetails.deliverableQuantities` array item that doesn't
 * have one yet (every row saved before this ticket, via the pre-PLU-169
 * `DeliverableCards`/`QuantityRows` UI, which never wrote an id).
 *
 * Why a backfill rather than lazy-generate-on-next-edit: a campaign whose
 * deliverables are never touched again would otherwise keep id-less items
 * indefinitely, and negotiation-delta support (a separate future ticket,
 * PLU-169 decision #5) needs a stable id on every item to reference —
 * lazy generation would leave a permanent gap for exactly the campaigns
 * least likely to be re-saved before that ticket ships.
 *
 * Idempotent / re-runnable: an item that already has an `id` is left
 * untouched; a row where every item already has an id is skipped entirely
 * (no write). Running this twice is a no-op the second time.
 *
 * Dry-run by DEFAULT — pass --apply to actually write.
 *
 * Run from server/:
 *   npx tsx scripts/backfill-deliverable-ids.ts            (DRY RUN — report only)
 *   npx tsx scripts/backfill-deliverable-ids.ts --apply    (apply the backfill)
 */

import { createId } from "@paralleldrive/cuid2";
import { eq, isNotNull } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { campaignDetails } from "../src/db/schema.js";

function backfillIds(items: unknown): { changed: boolean; result: unknown } {
  if (!Array.isArray(items)) return { changed: false, result: items };
  let changed = false;
  const result = items.map((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>)["id"] !== "string"
    ) {
      changed = true;
      return { id: createId(), ...(item as Record<string, unknown>) };
    }
    return item;
  });
  return { changed, result };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(
    `\n[backfill-deliverable-ids] scanning CampaignDetails.deliverableQuantities${
      apply ? "" : " (DRY RUN — pass --apply to write)"
    }\n`,
  );

  const rows = await db
    .select({ id: campaignDetails.id, deliverableQuantities: campaignDetails.deliverableQuantities })
    .from(campaignDetails)
    .where(isNotNull(campaignDetails.deliverableQuantities));

  let candidates = 0;
  let updated = 0;
  let alreadyBackfilled = 0;

  for (const row of rows) {
    const { changed, result } = backfillIds(row.deliverableQuantities);
    if (!changed) {
      alreadyBackfilled++;
      continue;
    }
    candidates++;
    if (apply) {
      await db
        .update(campaignDetails)
        .set({ deliverableQuantities: result as typeof row.deliverableQuantities })
        .where(eq(campaignDetails.id, row.id));
      updated++;
      console.log(`  backfilled CampaignDetails ${row.id}`);
    } else {
      console.log(`  would backfill CampaignDetails ${row.id}`);
    }
  }

  console.log(
    `\n[backfill-deliverable-ids] done. scanned=${rows.length} already-had-ids=${alreadyBackfilled} ` +
      `${apply ? "updated" : "would-update"}=${apply ? updated : candidates}\n`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-deliverable-ids] failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
