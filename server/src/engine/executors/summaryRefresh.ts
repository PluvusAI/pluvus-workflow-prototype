import type { ConversationSummary } from "../conversationContext/types.js";
import type { DatedEntry } from "./negotiationHistory.js";
import type { IAgentProvider } from "../providers.js";
import {
  loadConversationSummary,
  upsertConversationSummary,
} from "../../db/conversationSummary.js";
import { recentMessageWindow } from "./summaryConfig.js";
import { estimateTokens } from "../conversationContext/assemble.js";

// ---------------------------------------------------------------------------
// PLU-112 — incremental rolling-summary refresh (fire-and-forget, fail-soft)
// ---------------------------------------------------------------------------
// Runs AFTER the turn's decision is made. It folds the turns that scrolled past
// the window (newly covered since the cursor) into the narrative and advances the
// cursor — so the NEXT turn can window them. Never blocks or fails a turn:
//   * nothing new past the cursor → no-op, the summarizer is not called (idempotent);
//   * summarize/guard failure → keep the old summary (windowing falls back to full);
//   * a concurrent worker that already advanced → CAS discards this stale write.
// The cursor is `sentAt` order; a still-reserved outbound never reaches this input
// (buildDatedDraftHistory drops sentAt===null), so it can't be summarized-past.

/** The delta the summarizer must fold, or null when the refresh is a no-op. */
export interface SummaryRefreshPlan {
  delta: DatedEntry[];
  priorSummary: string;
  expectedThroughSentAt: Date | null;
  newThroughSentAt: Date;
  newThroughMessageId?: string | undefined;
}

/** Pure: decide what (if anything) to summarize this turn. The delta is every
 *  entry that is now BEHIND the recent window but not yet covered by the cursor. */
export function planSummaryRefresh(
  dated: DatedEntry[],
  summary: ConversationSummary | undefined,
  window: number,
): SummaryRefreshPlan | null {
  // Only the pre-window prefix is summarizable; the newest `window` turns stay raw.
  if (dated.length <= window) return null;
  const prefix = dated.slice(0, dated.length - window);

  const cursorMs =
    summary?.summarizedThroughSentAt instanceof Date
      ? summary.summarizedThroughSentAt.getTime()
      : -Infinity;
  const delta = prefix.filter((d) => d.at > cursorMs);
  if (delta.length === 0) return null; // idempotent: nothing new to fold.

  const last = delta[delta.length - 1]!;
  return {
    delta,
    priorSummary: summary?.text ?? "",
    expectedThroughSentAt:
      summary?.summarizedThroughSentAt instanceof Date ? summary.summarizedThroughSentAt : null,
    newThroughSentAt: new Date(last.at),
    ...(last.entry.messageId ? { newThroughMessageId: last.entry.messageId } : {}),
  };
}

/**
 * Refresh the instance's summary from the turn's transcript. Fire-and-forget from
 * the executor — awaited only to keep errors contained. Returns nothing; failures
 * are swallowed (the old summary stays authoritative).
 */
export async function refreshConversationSummary(
  instanceId: string,
  dated: DatedEntry[],
  agent: IAgentProvider,
): Promise<void> {
  if (!agent.summarizeConversation) return;
  try {
    // Re-read the summary INSIDE the refresh so the CAS compares against the
    // freshest stored cursor, not the one this turn's context loaded.
    const current = await loadConversationSummary(instanceId);
    const plan = planSummaryRefresh(dated, current, recentMessageWindow());
    if (!plan) return;

    const result = await agent.summarizeConversation(
      plan.priorSummary,
      plan.delta.map((d) => d.entry),
    );
    if (!result || !result.text.trim()) return; // summarizer failed / empty → keep old.

    const saved = estimateTokens(plan.delta.map((d) => d.entry)) - estimateTokens(result.text);
    await upsertConversationSummary(
      {
        instanceId,
        text: result.text,
        summarizedThroughSentAt: plan.newThroughSentAt,
        summarizedThroughMessageId: plan.newThroughMessageId,
        version: result.version,
        estimatedTokensSaved: saved > 0 ? saved : 0,
      },
      plan.expectedThroughSentAt,
    );
  } catch (err) {
    console.error(
      `[summaryRefresh] refresh failed for ${instanceId} (keeping prior summary): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
