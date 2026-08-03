import { and, eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  conversationSummaries,
  type ConversationSummary,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Rolling conversation-summary access module (PLU-112)
// ---------------------------------------------------------------------------
// One row per instance (unique instanceId). The refresh is fire-and-forget after
// the turn, so two overlapping workers can race on the same instance. Writes go
// through an ATOMIC compare-and-swap on `summarizedThroughSentAt` (the coverage
// cursor): the guarded UPDATE succeeds only if the stored cursor still equals the
// one the refresher loaded, so a stale worker can never overwrite a newer summary
// (Calvin review #7). The cursor only ever advances forward from the loaded value.

/** The single row for an instance, or undefined if none has been written yet. */
export async function loadConversationSummary(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<ConversationSummary | undefined> {
  const [row] = await client
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.instanceId, instanceId))
    .limit(1);
  return row;
}

/** The narrative + advanced cursor a successful refresh produces. */
export interface SummaryWrite {
  instanceId: string;
  text: string;
  summarizedThroughSentAt: Date;
  summarizedThroughMessageId?: string | undefined;
  version: string;
  estimatedTokensSaved?: number | undefined;
}

/**
 * Atomically create-or-advance the summary. `expectedThroughSentAt` is the cursor
 * the refresher loaded (null when it saw no row). Returns the written row, or null
 * when the CAS lost — another worker inserted first or already advanced the cursor,
 * so this (now stale) write is discarded.
 */
export async function upsertConversationSummary(
  write: SummaryWrite,
  expectedThroughSentAt: Date | null,
  client: Db | DbTx = db,
): Promise<ConversationSummary | null> {
  // No prior summary → insert. ON CONFLICT DO NOTHING loses the race to whichever
  // worker inserts first (returning() is empty), so we never clobber their row.
  if (expectedThroughSentAt === null) {
    const [inserted] = await client
      .insert(conversationSummaries)
      .values({
        instanceId: write.instanceId,
        text: write.text,
        summarizedThroughSentAt: write.summarizedThroughSentAt,
        summarizedThroughMessageId: write.summarizedThroughMessageId,
        version: write.version,
        estimatedTokensSaved: write.estimatedTokensSaved ?? 0,
      })
      .onConflictDoNothing({ target: conversationSummaries.instanceId })
      .returning();
    return inserted ?? null;
  }

  // Prior summary → advance only if the stored cursor is still the one we loaded.
  // The WHERE-guard makes the check-and-set atomic; 0 rows back ⇒ CAS lost.
  const [updated] = await client
    .update(conversationSummaries)
    .set({
      text: write.text,
      summarizedThroughSentAt: write.summarizedThroughSentAt,
      summarizedThroughMessageId: write.summarizedThroughMessageId,
      version: write.version,
      estimatedTokensSaved: write.estimatedTokensSaved ?? 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversationSummaries.instanceId, write.instanceId),
        eq(conversationSummaries.summarizedThroughSentAt, expectedThroughSentAt),
      ),
    )
    .returning();
  return updated ?? null;
}
