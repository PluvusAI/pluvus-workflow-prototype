import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { ConversationSummary } from "../conversationContext/types.js";
import { estimateTokens } from "../conversationContext/assemble.js";
import type { DatedEntry } from "./negotiationHistory.js";

// ---------------------------------------------------------------------------
// PLU-112 — pure draft-transcript windowing (no I/O)
// ---------------------------------------------------------------------------
// Window ⟺ the summary's cursor covers the dropped turns. A raw entry is removed
// ONLY when its sentAt is at/before `summarizedThroughSentAt`; everything after the
// cursor always stays raw (so nothing is ever in neither the summary nor the raw
// tail — Calvin review #2/#3/#4). No valid summary → the full transcript, byte-
// identical to today (the flag-OFF path). Draft path only — the money decision
// keeps the full transcript.

export interface WindowResult {
  history: DraftHistoryEntry[];
  summary?: ConversationSummary | undefined;
}

export interface WindowOpts {
  /** Newest raw turns kept verbatim for tone. */
  window: number;
  /** Raw-transcript-tail token budget (bounds only the raw window). */
  tokenBudget: number;
}

/** A summary can gate windowing only if it has body text AND a real cursor. */
function hasValidCursor(
  summary: ConversationSummary | undefined,
): summary is ConversationSummary & { summarizedThroughSentAt: Date } {
  return (
    summary !== undefined &&
    summary.text.trim().length > 0 &&
    summary.summarizedThroughSentAt instanceof Date
  );
}

/**
 * Bound the draft transcript against the summary's coverage cursor.
 *
 * @param dated   the chronological transcript WITH each entry's sentAt (`at`).
 * @param summary the rolling summary, or undefined when the flag is off / absent.
 */
export function windowDraftHistory(
  dated: DatedEntry[],
  summary: ConversationSummary | undefined,
  opts: WindowOpts,
): WindowResult {
  const all = dated.map((d) => d.entry);
  // No valid summary → full transcript (§5.6 fallback = today's behavior).
  if (!hasValidCursor(summary)) return { history: all };

  const cursor = summary.summarizedThroughSentAt.getTime();
  // Everything after the cursor is uncovered → must stay raw. Everything at/before
  // is covered by the summary → droppable.
  const tailCount = dated.filter((d) => d.at > cursor).length;

  // Keep the newest max(window, tail) entries. Dropping below the tail is
  // forbidden (would strand an uncovered entry); dropping a covered entry above
  // the tail is fine (the summary carries it).
  let keep = Math.max(opts.window, tailCount);

  // Budget backstop: shed the OLDEST kept entries, but only while they are covered
  // (index < drop boundary keeps at least `tailCount`), and never the latest.
  while (
    keep > tailCount &&
    keep > 1 &&
    estimateTokens(all.slice(all.length - keep)) > opts.tokenBudget
  ) {
    keep--;
  }

  const history = all.slice(all.length - keep);
  return { history, summary };
}
