// ---------------------------------------------------------------------------
// Manual Initial Outreach — template variables (WEB MIRROR)
// ---------------------------------------------------------------------------
//
// This is the web-side mirror of server/src/engine/outreachVariables.ts. The two
// build roots can't cross-import (same pattern as the two graphValidation.ts
// modules), so the allow-list, the preview renderer, unknown-token extraction,
// validation, and the suggestion logic are duplicated here VERBATIM in behavior.
//
// Keep in sync with the server module. If you add/rename a variable, change BOTH.
//
// Used by: the builder variable palette, the live preview, and the web graph
// validator (pre-publish error surfacing).

export interface OutreachVariable {
  name: string;
  group: "Creator" | "Brand" | "Campaign";
  label: string;
  fallbackNote: string;
  /**
   * PLU-117 §3 / AC10: a REQUIRED variable has NO silent fallback. When a
   * template uses it and a creator's value is empty, that send is blocked. The
   * builder surfaces a warning when a required variable is referenced.
   */
  required?: boolean;
  /**
   * PLU-117: when is this variable AVAILABLE (offered in the palette / given to
   * the AI / valid in the template)? "always" = resolves for every creator
   * regardless of config; "config" = comes from a brand-supplied field and is
   * offered only when the config carries a non-empty value for `sourceKey`. Keep
   * in sync with the server module.
   */
  availability: "always" | "config";
  sourceKey?: string;
}

export const OUTREACH_VARIABLES: readonly OutreachVariable[] = [
  { name: "creatorFirstName", group: "Creator", label: "The creator's first name", fallbackNote: "first word of the creator's name", availability: "always" },
  { name: "creatorName", group: "Creator", label: "The creator's name", fallbackNote: "always present", required: true, availability: "always" },
  { name: "platform", group: "Creator", label: "The creator's platform (e.g. Instagram)", fallbackNote: '"social media" when unknown', availability: "always" },
  { name: "niche", group: "Creator", label: "The creator's niche (e.g. fitness)", fallbackNote: '"your niche" when unknown', availability: "always" },
  { name: "brandName", group: "Brand", label: "The brand's name", fallbackNote: "the campaign's brand", required: true, availability: "config", sourceKey: "brandName" },
  { name: "senderName", group: "Brand", label: "The sender / partnerships identity", fallbackNote: "the campaign's brand", availability: "config", sourceKey: "senderName" },
  { name: "brandDescription", group: "Brand", label: "What the brand does", fallbackNote: "blank when unset", availability: "config", sourceKey: "brandDescription" },
  { name: "campaignName", group: "Campaign", label: "The campaign's name", fallbackNote: "blank when unset", availability: "config", sourceKey: "campaignName" },
  { name: "collaborationType", group: "Campaign", label: "The deal shape (fixed-fee / affiliate / hybrid)", fallbackNote: '"partnership" when the deal shape is unknown', availability: "always" },
  { name: "offerSummary", group: "Campaign", label: "A price-free summary of the offer", fallbackNote: "blank when the deal shape is unknown", availability: "config", sourceKey: "offerSummary" },
  { name: "rewardDescription", group: "Campaign", label: "The product / sample reward blurb", fallbackNote: "blank when cash-only", availability: "config", sourceKey: "rewardDescription" },
  { name: "deliverables", group: "Campaign", label: "What the creator would produce", fallbackNote: "blank when unset", availability: "config", sourceKey: "deliverables" },
  { name: "timeline", group: "Campaign", label: "The campaign timeline", fallbackNote: "blank when unset", availability: "config", sourceKey: "timeline" },
] as const;

export const OUTREACH_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_VARIABLES.map((v) => v.name),
);

/** REQUIRED variable names (PLU-117 §3) — mirrors the server set. */
export const REQUIRED_OUTREACH_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_VARIABLES.filter((v) => v.required).map((v) => v.name),
);

/**
 * Variables AVAILABLE for a config — "always" vars plus "config" vars whose
 * source key carries a non-empty value. Mirrors the server. Single source of
 * truth for what the palette offers and what the AI is allowed to use.
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

export function availableOutreachVariableNames(
  config: Record<string, unknown>,
): Set<string> {
  return new Set(availableOutreachVariables(config).map((v) => v.name));
}

/**
 * KNOWN placeholders a template uses that are NOT available for this config (they
 * would render blank because the brand didn't supply the value). Mirrors the
 * server unavailableUsedTokens. Unknown-token typos are handled separately.
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

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Distinct {{tokens}} in `template` that are NOT in the allow-list. */
export function extractUnknownTokens(template: string): string[] {
  if (!template) return [];
  const unknown = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[1];
    if (name && !OUTREACH_VARIABLE_NAMES.has(name)) unknown.add(name);
  }
  return [...unknown];
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

export function didYouMeanClause(unknown: string): string {
  const s = suggestVariable(unknown);
  return s ? ` — did you mean {{${s}}}?` : "";
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

/**
 * Sample values used by the builder's live preview so the operator sees roughly
 * what a creator receives. Creator fields are illustrative; brand/campaign
 * fields come from the node config (the real campaign values already stamped
 * onto it), falling back to these placeholders when the campaign hasn't set one.
 */
export const PREVIEW_SAMPLE = {
  creatorName: "Maya Chen",
  platform: "Instagram",
  niche: "fitness",
} as const;

/** First whitespace-delimited word of a name; "" when blank. Mirrors server. */
export function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ?? "";
}

/**
 * Render `template` for the live preview using the node config's real brand /
 * campaign values plus sample creator values. Unknown {{tokens}} are STRIPPED to
 * "" (mirrors the server send-time net). This mirrors resolveOutreachTemplate on
 * the server.
 */
export function renderOutreachPreview(
  template: string,
  config: Record<string, unknown>,
): string {
  const str = (key: string): string =>
    typeof config[key] === "string" ? (config[key] as string) : "";

  // Mirror the server: brandName is the campaign brand, senderName mirrors it, and
  // there is NO "Pluvus Partnerships" fallback — it must never appear in the copy.
  const brandName = str("brandName") || str("senderName");
  const senderName = str("senderName") || brandName;
  const collaborationType = str("collaborationType") || "partnership";

  const values: Record<string, string> = {
    creatorFirstName: firstNameOf(PREVIEW_SAMPLE.creatorName),
    creatorName: PREVIEW_SAMPLE.creatorName,
    platform: PREVIEW_SAMPLE.platform,
    niche: PREVIEW_SAMPLE.niche,
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

  return template.replace(TOKEN_RE, (_full, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : "",
  );
}

// ---------------------------------------------------------------------------
// Validation (mirror of server validateOutreachConfig)
// ---------------------------------------------------------------------------

export type OutreachValidationCode = "MISSING_SUBJECT" | "MISSING_BODY" | "UNKNOWN_VARIABLE";

export interface OutreachValidationIssue {
  code: OutreachValidationCode;
  message: string;
  /** Which field the issue is on, for inline UI error placement. */
  field: "subject" | "body";
}

export function validateOutreachConfig(
  cfg: Record<string, unknown>,
): OutreachValidationIssue | null {
  const mode = cfg["outreachMode"] === "manual" ? "manual" : "ai";
  const subject = typeof cfg["subjectTemplate"] === "string" ? cfg["subjectTemplate"] : "";
  const body = typeof cfg["bodyTemplate"] === "string" ? cfg["bodyTemplate"] : "";

  if (mode === "manual") {
    if (subject.trim().length === 0)
      return { code: "MISSING_SUBJECT", message: "Initial Outreach needs an email subject.", field: "subject" };
    if (body.trim().length === 0)
      return { code: "MISSING_BODY", message: "Initial Outreach needs an email body.", field: "body" };
  }

  for (const [field, text] of [["subject", subject], ["body", body]] as const) {
    const unknown = extractUnknownTokens(text);
    if (unknown.length > 0) {
      const bad = unknown[0]!;
      return {
        code: "UNKNOWN_VARIABLE",
        message: `The outreach ${field} uses {{${bad}}}, which is not a known variable${didYouMeanClause(bad)}`,
        field,
      };
    }
  }
  return null;
}
