// ---------------------------------------------------------------------------
// Budget-aware conversation windowing (PLU-112) — pure, per-purpose
// ---------------------------------------------------------------------------
// Applied as a per-purpose POST-PROJECTION (§5.1.1): toDecisionContext /
// toDraftContext call this over the full transcript; assembleContext and
// buildDraftHistory stay UN-windowed (so the escalation caller, which bypasses the
// projections, always gets the complete history a human audits — §5.1.1).
//
// THE LOAD-BEARING INVARIANT (§5.1): windowing may drop older raw turns ONLY when
// a VALID summary covers the elided prefix. If the summary is absent / empty /
// stale, we return the FULL transcript unchanged — never a bare window with a hole
// where the summary should be. The fallback target IS today's shipped behavior
// (the full transcript), which is why PLU-112 is dark-safe (§5.6).
//
// Windowing is POSITIONAL here (the newest N entries), per §5.4: "take the newest
// RECENT_MESSAGE_WINDOW turns raw; older turns are covered by the summary." The
// sentAt CURSOR (§5.4.1) governs the SUMMARIZER (what to fold in, send-delay-safe),
// not this projection — which is pure and timestamp-free.

import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import type { ConversationSummary } from "../conversationContext.js";
import { recentMessageWindow, contextTokenBudget } from "./summaryConfig.js";

/** A coarse pre-projection token estimate over the RAW candidate turns (§5.4). This
 *  is the budget driver — deliberately distinct from the labeled chars/4 debug proxy
 *  on ContextDebug (post-projection, documented unreliable, review finding M1). Same
 *  chars/4 heuristic, but computed here over the raw window for enforcement. */
export function estimateTurnsTokens(turns: DraftHistoryEntry[]): number {
  let chars = 0;
  for (const t of turns) chars += (t.message ?? "").length;
  return Math.ceil(chars / 4);
}

export interface WindowResult {
  /** The transcript to ship to the model for THIS purpose. Either the full
   *  transcript (no valid summary → §5.6 fallback) or the windowed tail. */
  recentMessages: DraftHistoryEntry[];
  /** Whether windowing actually elided any turns (drives whether the summary block
   *  is threaded — a no-op window ships no summary). */
  windowed: boolean;
}

/**
 * A summary is VALID for windowing iff it exists and carries non-empty text. An
 * empty/whitespace body means "generation failed or nothing summarized yet" → we
 * must NOT window (§5.1). Kept deliberately simple: the coupling that makes PLU-112
 * safe is "no window without a real summary", not an elaborate staleness oracle —
 * a stale-but-present summary still covers the older prefix (the refresh advances
 * it next turn; §5.4.1), and the recent window is always verbatim regardless.
 */
export function isSummaryValid(
  summary: ConversationSummary | undefined,
): summary is ConversationSummary {
  return !!summary && typeof summary.text === "string" && summary.text.trim().length > 0;
}

/**
 * Apply the budget window for one purpose (§5.4). PURE.
 *
 *   - No valid summary → return the FULL transcript, windowed=false (§5.6 fallback).
 *     This is the flag-OFF path AND the summary-failure path — identical to today.
 *   - Valid summary → keep the newest `recentMessageWindow()` turns raw. If those
 *     still exceed `contextTokenBudget()`, drop the OLDEST of them (they're covered
 *     by the summary) until under budget — but NEVER drop the single latest turn
 *     (the creator's most recent reply is always preserved for tone).
 *
 * The elided prefix (everything before the returned tail) is exactly what the
 * summary covers — the caller threads the summary block alongside.
 */
export function applyBudgetWindow(
  transcript: DraftHistoryEntry[],
  summary: ConversationSummary | undefined,
): WindowResult {
  // §5.1 / §5.6 — the fallback is the FULL transcript, never a bare window.
  if (!isSummaryValid(summary)) {
    return { recentMessages: transcript, windowed: false };
  }

  const window = recentMessageWindow();
  // Nothing to elide: the whole transcript already fits the turn window. Ship it
  // all (no summary needed) so short threads are byte-identical to today.
  if (transcript.length <= window) {
    return { recentMessages: transcript, windowed: false };
  }

  // Take the newest `window` turns raw.
  let tail = transcript.slice(transcript.length - window);

  // Budget backstop (§5.4): if the raw window still busts the token budget, move
  // its OLDEST turns into the summary-covered prefix until under budget — but keep
  // at least the latest turn (never drop the creator's most recent reply).
  const budget = contextTokenBudget();
  while (tail.length > 1 && estimateTurnsTokens(tail) > budget) {
    tail = tail.slice(1);
  }

  // If the window ended up being the whole transcript (window >= length was handled
  // above, but the budget loop can only shrink), it is genuinely windowed here.
  return { recentMessages: tail, windowed: true };
}
