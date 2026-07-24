// ---------------------------------------------------------------------------
// Manual Initial Outreach — template variable allow-list (single source of truth)
// ---------------------------------------------------------------------------
//
// The operator writes the initial outreach email by hand in the builder and can
// personalize it with {{variables}} that are substituted per-creator at send
// time. This module is the ONE canonical list of which variables exist, how each
// resolves, and its fallback when the source value is empty.
//
// It is imported by:
//   - the render seam (MockEmailProvider.draft) — the actual substitution + the
//     send-time strip of any unknown {{token}} that slipped past validation;
//   - graph validation (server) — reject a publish that references an unknown
//     variable, with a "did you mean" hint;
//   - (mirrored) the web builder palette + live preview.
// Keeping renderer, validator, and palette off one list means they can never
// drift — a variable added here is instantly known everywhere.

import type { Creator } from "../db/schema.js";

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

export interface OutreachVariable {
  /** Token name WITHOUT braces, e.g. "creatorName" for {{creatorName}}. */
  readonly name: string;
  /** Grouping for the UI palette. */
  readonly group: "Creator" | "Brand" | "Campaign";
  /** One-line description of what it resolves to (shown as a tooltip/hint). */
  readonly label: string;
  /** Human note about the fallback when the source is empty. */
  readonly fallbackNote: string;
  /**
   * PLU-117 §3 / AC10: a REQUIRED variable has NO silent fallback. If a template
   * uses it and the value resolves empty for a given creator, that creator's send
   * is blocked (routed to MANUAL_REVIEW) rather than mailed a broken sentence.
   * Optional variables (the default) keep their fallback string.
   */
  readonly required?: boolean;
  /**
   * When is this variable AVAILABLE to use (offered in the palette, given to the
   * AI, allowed in the template)? PLU-117: a placeholder must never render blank,
   * so a variable is only offered when its value is genuinely present.
   *   - "always": resolves to a sensible value for every creator regardless of
   *     config (creator name / first name; platform+niche+brandName+senderName+
   *     collaborationType, which all carry a non-empty fallback). Always offered.
   *   - "config": comes from a brand-supplied field on the node config and is
   *     BLANK when the brand didn't fill it in. Offered ONLY when the config
   *     carries a non-empty value for `sourceKey` (defaults to `name`).
   */
  readonly availability: "always" | "config";
  /** For availability:"config" — the config key that must be non-empty. */
  readonly sourceKey?: string;
}

// Order here is the palette order in the UI.
export const OUTREACH_VARIABLES: readonly OutreachVariable[] = [
  // Creator — always available (creator fields have fallbacks, never blank).
  { name: "creatorFirstName", group: "Creator", label: "The creator's first name", fallbackNote: "first word of the creator's name", availability: "always" },
  { name: "creatorName", group: "Creator", label: "The creator's name", fallbackNote: "always present", required: true, availability: "always" },
  { name: "platform", group: "Creator", label: "The creator's platform (e.g. Instagram)", fallbackNote: "\"social media\" when unknown", availability: "always" },
  { name: "niche", group: "Creator", label: "The creator's niche (e.g. fitness)", fallbackNote: "\"your niche\" when unknown", availability: "always" },
  // Brand — sourced from the campaign brand (senderName mirrors it). Offered only
  // when a real brand value is present; NEVER falls back to an internal name.
  { name: "brandName", group: "Brand", label: "The brand's name", fallbackNote: "the campaign's brand", required: true, availability: "config", sourceKey: "brandName" },
  { name: "senderName", group: "Brand", label: "The sender / partnerships identity", fallbackNote: "the campaign's brand", availability: "config", sourceKey: "senderName" },
  { name: "brandDescription", group: "Brand", label: "What the brand does", fallbackNote: "blank when unset", availability: "config", sourceKey: "brandDescription" },
  // Campaign — offered only when the brand/campaign actually supplied the value.
  { name: "campaignName", group: "Campaign", label: "The campaign's name", fallbackNote: "blank when unset", availability: "config", sourceKey: "campaignName" },
  { name: "collaborationType", group: "Campaign", label: "The deal shape (fixed-fee / affiliate / hybrid)", fallbackNote: "\"partnership\" when the deal shape is unknown", availability: "always" },
  { name: "offerSummary", group: "Campaign", label: "A price-free summary of the offer", fallbackNote: "blank when the deal shape is unknown", availability: "config", sourceKey: "offerSummary" },
  { name: "rewardDescription", group: "Campaign", label: "The product / sample reward blurb", fallbackNote: "blank when cash-only", availability: "config", sourceKey: "rewardDescription" },
  { name: "deliverables", group: "Campaign", label: "What the creator would produce", fallbackNote: "blank when unset", availability: "config", sourceKey: "deliverables" },
  { name: "timeline", group: "Campaign", label: "The campaign timeline", fallbackNote: "blank when unset", availability: "config", sourceKey: "timeline" },
] as const;

/**
 * PLU-117: the variables that are AVAILABLE for a given node config — i.e. that
 * will resolve to a real (non-blank) value. "always" variables are always in;
 * "config" variables are included only when the config carries a non-empty
 * string for their source key. This is the single source of truth for what the
 * palette offers, what the AI may use, and what the preview treats as valid, so a
 * placeholder that would render blank is never offered anywhere.
 */
export function availableOutreachVariables(
  config: Record<string, unknown>,
): OutreachVariable[] {
  return OUTREACH_VARIABLES.filter((v) => {
    if (v.availability === "always") return true;
    const key = v.sourceKey ?? v.name;
    const val = config[key];
    return typeof val === "string" && val.trim().length > 0;
  });
}

/** The available variable NAMES for a config (O(1) membership set). */
export function availableOutreachVariableNames(
  config: Record<string, unknown>,
): Set<string> {
  return new Set(availableOutreachVariables(config).map((v) => v.name));
}

/** Set of REQUIRED variable names (PLU-117 §3). O(1) membership. */
export const REQUIRED_OUTREACH_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_VARIABLES.filter((v) => v.required).map((v) => v.name),
);

/** Set of allowed variable names for O(1) membership checks. */
export const OUTREACH_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_VARIABLES.map((v) => v.name),
);

// ---------------------------------------------------------------------------
// Token scanning
// ---------------------------------------------------------------------------

// Matches a {{token}} with optional inner whitespace: {{ creatorName }}.
// Global so we can iterate every occurrence. Token capture is the trimmed name.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Return the distinct variable names referenced in a template string that are
 * NOT in the allow-list. Empty array when the template is clean. Used by
 * validation to block a publish and by the UI to highlight typos.
 */
export function extractUnknownTokens(template: string): string[] {
  if (!template) return [];
  const unknown = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[1];
    if (name && !OUTREACH_VARIABLE_NAMES.has(name)) unknown.add(name);
  }
  return [...unknown];
}

/**
 * Cheap Levenshtein-distance suggestion: given an unknown token, return the
 * closest known variable name within edit distance 3, else undefined. Powers the
 * "did you mean {{creatorName}}?" hint. Small N (9 vars) so this is trivial.
 */
export function suggestVariable(unknown: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  const lower = unknown.toLowerCase();
  for (const v of OUTREACH_VARIABLES) {
    const d = editDistance(lower, v.name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = v.name;
    }
  }
  return bestDist <= 3 ? best : undefined;
}

/**
 * Format the "did you mean" clause for an unknown token, e.g.
 *   ` — did you mean {{creatorName}}?`
 * Returns "" when there's no close match. Pure string helper shared by the
 * server and web validators so the wording matches.
 */
export function didYouMeanClause(unknown: string): string {
  const s = suggestVariable(unknown);
  return s ? ` — did you mean {{${s}}}?` : "";
}

// ---------------------------------------------------------------------------
// Validation (shared logic for the graph validators)
// ---------------------------------------------------------------------------

export type OutreachValidationCode =
  | "MISSING_SUBJECT"
  | "MISSING_BODY"
  | "UNKNOWN_VARIABLE";

export interface OutreachValidationIssue {
  code: OutreachValidationCode;
  message: string;
}

/**
 * Validate an INITIAL_OUTREACH node's outreach copy. Returns the first blocking
 * issue, or null when valid. Mode-aware:
 *   - "manual"  → subject AND body are required (they ARE the email), and any
 *                 unknown {{token}} in either is rejected (with a suggestion).
 *   - "ai" / absent → subject/body are optional (they're only the AI fallback);
 *                 we still reject an unknown {{token}} IF one is present, so a
 *                 typo in a fallback template can't silently mail literal braces.
 *
 * Absent mode is treated as "ai" here to match the executor's legacy default —
 * re-validating an old AI-mode draft never suddenly fails on empty copy.
 */
export function validateOutreachConfig(cfg: Record<string, unknown>): OutreachValidationIssue | null {
  const mode = cfg["outreachMode"] === "manual" ? "manual" : "ai";
  const subject = typeof cfg["subjectTemplate"] === "string" ? cfg["subjectTemplate"] : "";
  const body = typeof cfg["bodyTemplate"] === "string" ? cfg["bodyTemplate"] : "";

  if (mode === "manual") {
    if (subject.trim().length === 0)
      return { code: "MISSING_SUBJECT", message: "Initial Outreach needs an email subject." };
    if (body.trim().length === 0)
      return { code: "MISSING_BODY", message: "Initial Outreach needs an email body." };
  }

  // Unknown-variable check runs for BOTH modes (a typo in an AI-fallback template
  // is still a latent bug). Subject first so its error surfaces first.
  for (const [field, text] of [["subject", subject], ["body", body]] as const) {
    const unknown = extractUnknownTokens(text);
    if (unknown.length > 0) {
      const bad = unknown[0]!;
      return {
        code: "UNKNOWN_VARIABLE",
        message: `The outreach ${field} uses {{${bad}}}, which is not a known variable${didYouMeanClause(bad)}`,
      };
    }
  }
  return null;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Resolve every allow-listed variable in `template` from the creator + config,
 * and STRIP any surviving unknown {{token}} to empty string (the send-time net
 * so a validation miss can never mail a creator literal braces).
 *
 * This is the single substitution function used by MockEmailProvider.draft for
 * both the manual outreach body and subject. Values come from the same merged
 * config the executor already built (mergeCampaignFallback stamps the campaign
 * fields), so no new plumbing is needed.
 */
export function resolveOutreachTemplate(
  template: string,
  creator: Pick<Creator, "name" | "platform" | "niche">,
  config: Record<string, unknown>,
): string {
  const values = resolveOutreachValues(creator, config);
  // One pass: known tokens → their value, unknown tokens → "" (stripped).
  return template.replace(TOKEN_RE, (_full, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : "",
  );
}

/** First whitespace-delimited word of a name; "" when the name is blank. */
export function firstNameOf(name: string | null | undefined): string {
  if (typeof name !== "string") return "";
  const first = name.trim().split(/\s+/)[0];
  return first ?? "";
}

/**
 * Resolve EVERY allow-listed variable to its per-creator value. Shared by the
 * renderer and the required-value check so both see the exact same resolution
 * (a variable is "missing" for §3 iff this map yields an empty string for it).
 *
 * collaborationType / offerSummary / campaignName come off `config` — the
 * executor stamps them from the campaign row + NEGOTIATION deal shape before
 * calling the render seam (they are NOT plain brand fields). collaborationType
 * keeps a soft "partnership" fallback so an unshaped deal never mails a blank.
 */
export function resolveOutreachValues(
  creator: Pick<Creator, "name" | "platform" | "niche">,
  config: Record<string, unknown>,
): Record<string, string> {
  const str = (key: string): string =>
    typeof config[key] === "string" ? (config[key] as string) : "";

  // brandName is the campaign brand; senderName mirrors it. NO internal-name
  // fallback — "Pluvus Partnerships" must never appear in a brand's outreach.
  // Each cross-fills the other (they hold the same value once the campaign is
  // stamped) but neither invents a value when both are genuinely empty; a blank
  // brandName is caught by the required-value gate (§3) instead.
  const brandName = str("brandName") || str("senderName");
  const senderName = str("senderName") || brandName;
  const platform =
    typeof creator.platform === "string" && creator.platform.trim().length > 0
      ? creator.platform
      : "social media";
  const niche =
    typeof creator.niche === "string" && creator.niche.trim().length > 0
      ? creator.niche
      : "your niche";
  const collaborationType = str("collaborationType") || "partnership";

  return {
    creatorFirstName: firstNameOf(creator.name),
    creatorName: creator.name,
    platform,
    niche,
    brandName,
    senderName,
    brandDescription: str("brandDescription"),
    campaignName: str("campaignName"),
    collaborationType,
    offerSummary: str("offerSummary"),
    rewardDescription: str("rewardDescription"),
    deliverables: str("deliverables"),
    timeline: str("timeline"),
  };
}

/**
 * PLU-117 §3 / AC10: the distinct REQUIRED variables that a template USES but
 * whose value resolves EMPTY for this creator. Empty array = safe to send. A
 * non-empty result means the executor must block/skip this creator's send and
 * surface which variable was missing, rather than mail a broken sentence.
 *
 * Only variables actually referenced in subject/body are checked — a required
 * variable the template never uses can't break anything.
 */
export function missingRequiredValues(
  subject: string,
  body: string,
  creator: Pick<Creator, "name" | "platform" | "niche">,
  config: Record<string, unknown>,
): string[] {
  const used = new Set<string>();
  for (const text of [subject, body]) {
    if (!text) continue;
    for (const m of text.matchAll(TOKEN_RE)) {
      const name = m[1];
      if (name && REQUIRED_OUTREACH_VARIABLE_NAMES.has(name)) used.add(name);
    }
  }
  if (used.size === 0) return [];

  const values = resolveOutreachValues(creator, config);
  const missing: string[] = [];
  for (const name of used) {
    if ((values[name] ?? "").trim().length === 0) missing.push(name);
  }
  return missing;
}

/**
 * PLU-117: the distinct KNOWN placeholders a template USES that are NOT available
 * for this config — i.e. an allow-listed variable whose value is blank because
 * the brand didn't supply it (e.g. {{campaignName}} when the campaign has no
 * name). These would render as an empty gap ("upcoming  campaign"), so the
 * builder flags them and the operator removes/fills them before publishing.
 * Unknown tokens (typos) are handled separately by extractUnknownTokens.
 */
export function unavailableUsedTokens(
  subject: string,
  body: string,
  config: Record<string, unknown>,
): string[] {
  const available = availableOutreachVariableNames(config);
  const flagged = new Set<string>();
  for (const text of [subject, body]) {
    if (!text) continue;
    for (const m of text.matchAll(TOKEN_RE)) {
      const name = m[1];
      if (name && OUTREACH_VARIABLE_NAMES.has(name) && !available.has(name)) {
        flagged.add(name);
      }
    }
  }
  return [...flagged];
}
