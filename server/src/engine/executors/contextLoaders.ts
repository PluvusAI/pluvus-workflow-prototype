// ---------------------------------------------------------------------------
// Real context loaders (PLU-112 / PLU-113) — the seam swap
// ---------------------------------------------------------------------------
// PLU-81 left buildConversationContext with two injectable async loader slots
// (loadCreatorMemory / loadConversationSummary) defaulting to undefined-returning
// stubs (§9.1). PLU-112 (and the deferred PLU-113 loader wiring) light up by
// supplying these REAL loaders as the builder's defaults. The FLAG CHECK lives
// INSIDE each loader — never in the builder body — so a flag OFF returns undefined
// (no block threaded, prompt byte-identical) without the builder knowing anything
// about memory or summaries.

import type { Db, DbTx } from "../../db/drizzle.js";
import { db } from "../../db/drizzle.js";
import { listLiveMemoryByInstance } from "../../db/campaignCreatorMemory.js";
import { getSummaryByInstance } from "../../db/conversationSummary.js";
import type { CreatorMemoryPayload, ConversationSummary } from "../conversationContext.js";
import { buildCreatorMemoryBlock } from "./creatorMemory.js";
import { creatorMemoryEnabled } from "./creatorMemoryConfig.js";
import { conversationSummaryEnabled } from "./summaryConfig.js";

/**
 * PLU-113 loader (real). OFF → undefined (no block, byte-identical). ON → the live
 * facts (ACTIVE + CONFLICTED) built into the sanitized read payload; an instance
 * with no live facts yet → buildCreatorMemoryBlock returns null → we normalize to
 * undefined so the slot is simply absent.
 */
export async function loadCreatorMemory(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<CreatorMemoryPayload | undefined> {
  if (!creatorMemoryEnabled()) return undefined;
  const block = buildCreatorMemoryBlock(await listLiveMemoryByInstance(instanceId, client));
  return block ?? undefined;
}

/**
 * PLU-112 loader (real). OFF → undefined (no summary, no windowing, byte-identical).
 * ON → the persisted rolling summary mapped to the lean WIRE shape (text + version).
 * A row with empty text is treated as "no valid summary" upstream (isSummaryValid),
 * so we still return it here and let the windowing helper decide (§5.1) — but an
 * absent row is undefined. The `purpose` is accepted for signature parity with the
 * seam; v1 uses one summary per instance for both purposes (§5.8 threads it to both).
 */
export async function loadConversationSummary(
  instanceId: string,
  _purpose: unknown,
  client: Db | DbTx = db,
): Promise<ConversationSummary | undefined> {
  if (!conversationSummaryEnabled()) return undefined;
  const row = await getSummaryByInstance(instanceId, client);
  if (!row) return undefined;
  return {
    text: row.text,
    ...(row.version ? { version: row.version } : {}),
    ...(row.estimatedInputTokensSaved != null
      ? { tokensSaved: row.estimatedInputTokensSaved }
      : {}),
  };
}
