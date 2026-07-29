import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  conversationSummaries,
  type ConversationSummary,
} from "./schema.js";

// ---------------------------------------------------------------------------
// ConversationSummary access module (PLU-112)
// ---------------------------------------------------------------------------
// One rolling narrative summary per ExecutionInstance of the ELIDED transcript
// prefix (turns older than the recent raw window). See
// .claude/spec/plu-69-conversation-context-memory-knowledge/PLAN.md §5.
//
// Mirrors campaignCreatorMemory.ts / conversationObligations.ts: every fn takes
// `client: Db | DbTx = db` so a write can run INSIDE a step transaction. There is
// exactly one row per instance (the unique index `ConversationSummary_instanceId_key`
// is the DB backstop), so the write is an UPSERT keyed on instanceId.

/** The rolling summary for an instance, or undefined if none has been generated
 *  yet. This is the AI-context load (§5.1) — the loader that lights up the
 *  forward-compat seam PLU-81 left in buildConversationContext. */
export async function getSummaryByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<ConversationSummary | undefined> {
  const rows = await client
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.instanceId, instanceId))
    .limit(1);
  return rows[0];
}

/** The fields a summary refresh writes (§5.3). `text` is the narrative body;
 *  `summarizedThroughSentAt` is the §5.4.1 cursor (the transcript's own ordering
 *  key, NEVER a message id); the rest are audit/observability. */
export interface UpsertSummaryArgs {
  instanceId: string;
  text: string;
  /** §5.4.1 — the ordering-key high-water mark of the folded-in prefix. Null only
   *  before the very first summary; a refresh always advances it to the last
   *  FINALIZED (sentAt/receivedAt non-null) turn before any reserved send. */
  summarizedThroughSentAt: Date | null;
  /** The Message row at that high-water mark, for audit/debug only. */
  summarizedThroughMessageId?: string | null;
  /** The summarizer prompt/version stamp → observability `summaryVersion`. */
  version?: string | null;
  /** Best-effort token-savings proxy, for the debug surface only. */
  estimatedInputTokensSaved?: number | null;
}

/**
 * Insert-or-update the instance's single rolling summary (§5.3). Idempotent by
 * construction: re-running with the same cursor and no new finalized turns writes
 * the same row (the summarizer produces the same text for the same prefix), and
 * the UNIQUE(instanceId) index means a concurrent double-write collapses onto one
 * row via onConflictDoUpdate rather than erroring. `updatedAt` is stamped by the
 * schema helper on both insert and update.
 */
export async function upsertSummary(
  args: UpsertSummaryArgs,
  client: Db | DbTx = db,
): Promise<ConversationSummary> {
  const values = {
    instanceId: args.instanceId,
    text: args.text,
    summarizedThroughSentAt: args.summarizedThroughSentAt,
    summarizedThroughMessageId: args.summarizedThroughMessageId ?? null,
    version: args.version ?? null,
    estimatedInputTokensSaved: args.estimatedInputTokensSaved ?? null,
  };
  const rows = await client
    .insert(conversationSummaries)
    .values(values)
    .onConflictDoUpdate({
      target: conversationSummaries.instanceId,
      set: {
        text: values.text,
        summarizedThroughSentAt: values.summarizedThroughSentAt,
        summarizedThroughMessageId: values.summarizedThroughMessageId,
        version: values.version,
        estimatedInputTokensSaved: values.estimatedInputTokensSaved,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}
