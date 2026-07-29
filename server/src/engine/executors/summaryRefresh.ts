// ---------------------------------------------------------------------------
// Rolling summary refresh (PLU-112) — in-turn, before context build
// ---------------------------------------------------------------------------
// Called at the start of a negotiation turn (§ your-choice: in-turn refresh), so a
// fresh summary is available for THIS turn's context build. Entirely behind
// CONVERSATION_SUMMARY_ENABLED — a no-op when the flag is off (the whole feature is
// dark). Fail-soft by construction: any failure leaves the prior summary in place
// and the projection falls back to the FULL transcript (§5.6). A refresh NEVER
// blocks or fails a turn.
//
// The cursor discipline (§5.4.1): we only fold in turns that are FINALIZED
// (sentAt/receivedAt present) and OLDER than the recent window, and we advance the
// cursor to the newest folded-in turn's ordering timestamp — never past a still-
// reserved (sentAt === null) outbound, because buildDraftHistory already excludes
// those (they aren't in `transcript`).

import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { Db, DbTx } from "../../db/drizzle.js";
import { db } from "../../db/drizzle.js";
import { getSummaryByInstance, upsertSummary } from "../../db/conversationSummary.js";
import { conversationSummaryEnabled, recentMessageWindow } from "./summaryConfig.js";
import { estimateTurnsTokens } from "./conversationWindow.js";

/** The subset of the agent provider this refresh needs (feature-detected). */
export interface SummarizerAgent {
  summarizeConversation?(
    priorSummary: string,
    turns: DraftHistoryEntry[],
  ): Promise<{ text: string; version?: string } | null>;
}

/**
 * Refresh the instance's rolling summary if the flag is on and there are older turns
 * beyond the window not yet folded in. PURE of turn control-flow: returns nothing,
 * throws nothing (all failures are swallowed to a no-op). The next context build
 * loads whatever this left (fresh or prior).
 *
 * @param transcript the FULL chronological transcript (from buildDraftHistory), the
 *   same source the projection windows — so "older than the window" here matches
 *   what the projection will elide.
 */
export async function refreshConversationSummary(
  instanceId: string,
  transcript: DraftHistoryEntry[],
  agent: SummarizerAgent,
  client: Db | DbTx = db,
): Promise<void> {
  if (!conversationSummaryEnabled()) return;
  if (typeof agent.summarizeConversation !== "function") return;

  const window = recentMessageWindow();
  // Nothing to elide → nothing to summarize (the whole thread fits the window).
  if (transcript.length <= window) return;

  // The prefix the projection will elide = everything except the newest `window`.
  const prefix = transcript.slice(0, transcript.length - window);
  if (prefix.length === 0) return;

  try {
    const existing = await getSummaryByInstance(instanceId, client);
    const priorSummary = existing?.text ?? "";

    // Incremental refresh (§5.4): fold in ONLY the prefix turns that are newer than
    // the cursor. We can't map a DraftHistoryEntry back to a sentAt cheaply here, so
    // v1 folds the WHOLE elided prefix each refresh (the summarizer extends the prior
    // summary and stays bounded by the prompt). A future optimization can thread
    // per-entry timestamps to fold only the delta; correctness does not depend on it
    // because the summarizer is given the prior summary to extend, not replace.
    const result = await agent.summarizeConversation(priorSummary, prefix);
    if (!result) return; // failure / guard rejection → keep prior (fail-soft)

    // Advance the cursor to the boundary between the elided prefix and the window:
    // the last prefix entry is the newest folded-in turn. Its messageId is the audit
    // high-water mark; the sentAt cursor is left null in v1 (audit id is enough to
    // trace, and the projection windows positionally — §5.4.1's cursor guards the
    // summarizer's delta selection, deferred with the per-entry timestamp threading).
    const boundary = prefix[prefix.length - 1];
    await upsertSummary(
      {
        instanceId,
        text: result.text,
        summarizedThroughSentAt: null,
        ...(boundary?.messageId ? { summarizedThroughMessageId: boundary.messageId } : {}),
        ...(result.version ? { version: result.version } : {}),
        estimatedInputTokensSaved: estimateTurnsTokens(prefix),
      },
      client,
    );
  } catch (err) {
    // Fail-soft: a refresh failure never blocks the turn — the prior summary (or the
    // full transcript, if none) is used.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[summaryRefresh] refresh failed for instance ${instanceId}, keeping prior: ${msg}`);
  }
}
