// ---------------------------------------------------------------------------
// PLU-112 — rolling conversation summary: feature flag + windowing knobs
// ---------------------------------------------------------------------------
// The summary lets a long DRAFT prompt window its raw transcript instead of
// shipping every prior email. OFF by default: with the flag off no summary is
// loaded, the window step is a no-op, and the draft prompt is byte-identical to
// today. Read per turn in the executor, so flipping it never rewrites an
// instance's prior transcript; summaries populate forward.

export function conversationSummaryEnabled(): boolean {
  return process.env["CONVERSATION_SUMMARY_ENABLED"] === "true";
}

/** How many newest raw turns stay verbatim in the draft prompt (for tone).
 *  Overridable via SUMMARY_RECENT_WINDOW (default 8, clamped ≥1). */
export function recentMessageWindow(): number {
  const raw = process.env["SUMMARY_RECENT_WINDOW"];
  if (raw === undefined) return 8;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 8;
  return n;
}

/** The RAW-TRANSCRIPT-TAIL token budget — it bounds only the raw window, NOT the
 *  whole prompt (summary/decision-history/campaign/memory/system are separate).
 *  Overridable via SUMMARY_TOKEN_BUDGET (default 6000, clamped ≥1). */
export function rawTranscriptTokenBudget(): number {
  const raw = process.env["SUMMARY_TOKEN_BUDGET"];
  if (raw === undefined) return 6000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 6000;
  return n;
}
