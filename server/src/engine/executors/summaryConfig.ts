// ---------------------------------------------------------------------------
// Rolling conversation summary + prompt budget (PLU-112) — flags + bounds
// ---------------------------------------------------------------------------
// The summary bounds the context a long thread ships: older raw turns fold into a
// narrative summary, the recent window stays verbatim for tone. It is OFF by
// default (PLU-69 §5.6): with the flag off no summary loads and NO windowing runs,
// so the projections emit the FULL un-windowed transcript — byte-identical to
// today's shipped behavior. The flag is read per turn (like creatorMemoryEnabled),
// so flipping it never retroactively rewrites an instance's prior transcript.
//
// CRITICAL invariant (§5.1): windowing is gated on a VALID summary that covers the
// elided prefix. Absent/failed/stale summary → fall back to the FULL transcript,
// never a bare window with a hole. So these bounds only ever take effect when a
// real summary is present; the flag alone does not drop any turn.

export function conversationSummaryEnabled(): boolean {
  return process.env["CONVERSATION_SUMMARY_ENABLED"] === "true";
}

/**
 * How many of the most recent raw turns stay VERBATIM in the window (§5.4). Turns
 * older than this fold into the summary — but only when a valid summary covers
 * them (§5.1). Starting point 8 (PLU-69 §11 Q1). Overridable via
 * RECENT_MESSAGE_WINDOW; a non-positive/unparseable value falls back to the default.
 */
export function recentMessageWindow(): number {
  const raw = process.env["RECENT_MESSAGE_WINDOW"];
  if (raw === undefined) return 8;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 8;
  return n;
}

/**
 * The soft token budget for the raw window (§5.4). If the newest
 * recentMessageWindow() turns still exceed this, the oldest raw turns move into the
 * summary until under budget (never dropping the latest creator reply). Starting
 * point 6000 (PLU-69 §11 Q1). Overridable via CONTEXT_TOKEN_BUDGET; a
 * non-positive/unparseable value falls back to the default.
 *
 * NB (§5.4, review finding M1): this budget is enforced against a PRE-PROJECTION
 * token estimate over the raw candidate turns, NOT the labeled chars/4 debug proxy
 * on ContextDebug (which is computed post-projection and documented as unreliable).
 * The two numbers are intentionally distinct.
 */
export function contextTokenBudget(): number {
  const raw = process.env["CONTEXT_TOKEN_BUDGET"];
  if (raw === undefined) return 6000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 6000;
  return n;
}
