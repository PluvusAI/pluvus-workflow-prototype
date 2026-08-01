import type { NodeSnapshot } from "../types.js";
import { readStoredFile } from "../../storage/localFileStorage.js";
import { agentBaseUrl, agentPostJson } from "../../adapters/agentServiceClient.js";

// ---------------------------------------------------------------------------
// HARD-K1 / PLU-107: campaign-brief knowledge resolution
// ---------------------------------------------------------------------------
// The campaign brief PDF holds the ground-truth campaign terms the negotiation
// agent previously had no structured source for (deliverables / usage / timeline
// / payment) — so it hallucinated them. This resolver reads the brief bytes
// (the engine owns local storage), asks the Python agent to extract the text
// (pypdf lives there, beside the LLM that consumes it), and returns a compact
// knowledge string the negotiation executor threads into campaignContext as
// `briefKnowledge`.
//
// PLU-107 widens the return from a flat string to a structured `ResolvedBrief`:
//   - flatText  — the old blob (byte-identical when the flag is off), threaded as
//                 campaignContext.briefKnowledge into BOTH /negotiate and /draft;
//   - status    — no_brief | ok | empty | parse_failed, so an ABSENT section is
//                 finally distinguishable from a PARSE FAILURE (invariant #2);
//   - sections  — the structured section map (projects into PLU-114's
//                 AvailableSections.brief);
//   - conflicts — material disagreements between a brief section and the
//                 authoritative Campaign knowledge field (§4.5), surfaced not
//                 resolved.
//
// The brief ref lives on the CONTENT_BRIEF node's config (the terminal node),
// not the NEGOTIATION node, so we resolve it from the whole node graph.
//
// The file content is immutable per reference (uploads get a fresh random name),
// so parsed results are cached in-process keyed by `${ref}::${parserVersion}`
// (invariant #3). The READ keys on the server's EXPECTED version
// (expectedParserVersion(), env BRIEF_PARSER_VERSION) — known before the parse — so
// bumping the parser genuinely misses every stale entry (PLU-82 review §3). Only
// ok/empty results
// are cached; a parse_failed is NOT cached (fixes BUG-E8: a transient agent
// timeout no longer poisons the campaign's brief until process restart, §4.4).
// Any failure (no brief, unreadable file, agent error) degrades to an empty flat
// string + a status so a brief we can't read never breaks a negotiation.

// PLU-107 §4.1 / §5: the structured shapes. Section keys are the SAME strings
// PLU-114's SectionKey uses where they overlap, so ResolvedBrief.sections projects
// directly into AvailableSections.brief.
export type BriefParseStatus = "ok" | "empty" | "parse_failed";

export interface CampaignBriefSection {
  type: string; // canonical key, e.g. "usageRights"
  text: string;
  pageStart?: number; // best-effort (invariant #4)
  pageEnd?: number;
  extractionConfidence?: number; // 0..1, best-effort
  sourceFileReference: string; // REQUIRED — invariant #4
  parserVersion: string; // REQUIRED — invariant #3
}

export interface BriefFieldConflict {
  section: string; // "paymentTerms"
  campaignField: string; // "paymentTerms"
  campaignValue: string;
  briefExcerpt: string;
  pageStart?: number;
  reason: string; // why it was flagged material (§4.5)
}

export interface ResolvedBrief {
  // → campaignContext.briefKnowledge on BOTH endpoints. Byte-identical to today's
  // extract_brief_text output when the structured flag is off.
  flatText: string;
  // no_brief is a resolver-level status (the parser is never called); ok/empty/
  // parse_failed come from the agent. invariant #2.
  status: BriefParseStatus | "no_brief";
  // → AvailableSections.brief (PLU-114). Absent when the flag is off / no sections.
  sections?: Partial<Record<string, CampaignBriefSection>>;
  // Material Campaign-field conflicts (§4.5). Absent/empty on no conflict.
  conflicts?: BriefFieldConflict[];
  // Observability substrate (§4.8).
  tierUsed?: string;
  pageCount?: number;
}

// The four authoritative Campaign knowledge fields we detect brief conflicts
// against (§4.5). The executor reads these off the merged node config (they are
// the same BRAND_KEYS mergeCampaignFallback overlays).
export interface CampaignKnowledgeFields {
  usageRights?: string | undefined;
  exclusivity?: string | undefined;
  paymentTerms?: string | undefined;
  attributionWindow?: string | undefined;
}

// PLU-107 invariant #3: the cache key stamps the parser version so a parser bump
// self-invalidates. The version is reported by the agent per parse; we key the
// cache on the version the agent RETURNED (so a mixed-version deploy caches each
// under its own key). Until a successful parse tells us the version, an unknown
// ref simply isn't cached.
const _cache = new Map<string, ResolvedBrief>();
const _CACHE_MAX = 256;

// PLU-82 review §3 (Calvin): the server's EXPECTED parser version. The read path
// keys the cache on THIS (known before the parse) rather than scanning for any
// entry whose key starts with the ref — so bumping the parser (deploy a new agent,
// set BRIEF_PARSER_VERSION to match) genuinely invalidates every stale entry
// instead of silently reusing a version-A result under a version-B parser. Default
// tracks the agent's current PARSER_VERSION (agent/app/brief.py); override via env
// during a mixed-version rollout. Read lazily so a test can set the env per-case.
const _DEFAULT_PARSER_VERSION = "brief-parser-v1.1";
export function expectedParserVersion(): string {
  const raw = process.env["BRIEF_PARSER_VERSION"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : _DEFAULT_PARSER_VERSION;
}

function cacheKey(ref: string, parserVersion: string): string {
  return `${ref}::${parserVersion}`;
}

function cacheGet(key: string): ResolvedBrief | undefined {
  return _cache.get(key);
}

function cacheSet(key: string, value: ResolvedBrief): void {
  if (_cache.size >= _CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
  }
  _cache.set(key, value);
}

/** The CONTENT_BRIEF node's brief file reference, if the graph has one. */
function briefRefFromGraph(nodeGraph: NodeSnapshot[]): string | undefined {
  const node = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
  const ref = node?.config?.["briefFileRef"];
  return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
}

// The section keys that have an authoritative Campaign column to conflict against.
const _CONFLICT_KEYS: Array<keyof CampaignKnowledgeFields> = [
  "usageRights",
  "exclusivity",
  "paymentTerms",
  "attributionWindow",
];

/** First "net N" day-count in a string, or null. */
function netDays(s: string): number | null {
  const m = /net[- ]?(\d{1,3})/i.exec(s);
  return m && m[1] ? Number(m[1]) : null;
}

/** First bare "N day(s)" count in a string, or null (for usage/exclusivity durations). */
function dayCount(s: string): number | null {
  const m = /\b(\d{1,4})\s*[- ]?days?\b/i.exec(s);
  return m && m[1] ? Number(m[1]) : null;
}

/**
 * PLU-107 §4.5: detect MATERIAL conflicts between a parsed brief section and the
 * authoritative Campaign knowledge field of the same key. Conservative — a
 * false-positive is noise, a false-negative reverts to today's silence, so we
 * only flag a clear contradiction (a different net-days / different day-count /
 * an opposite exclusivity stance), never mere elaboration. Campaign field stays
 * authoritative; this SURFACES the disagreement, it does not resolve it.
 */
export function detectBriefConflicts(
  sections: Partial<Record<string, CampaignBriefSection>>,
  fields: CampaignKnowledgeFields,
): BriefFieldConflict[] {
  const conflicts: BriefFieldConflict[] = [];
  for (const key of _CONFLICT_KEYS) {
    const section = sections[key];
    const campaignValue = fields[key];
    if (!section || typeof campaignValue !== "string" || !campaignValue.trim()) continue;
    const briefText = section.text;
    const excerpt = briefText.slice(0, 200).trim();
    const base: Omit<BriefFieldConflict, "reason"> = {
      section: key,
      campaignField: key,
      campaignValue: campaignValue.trim(),
      briefExcerpt: excerpt,
      ...(section.pageStart !== undefined ? { pageStart: section.pageStart } : {}),
    };

    if (key === "paymentTerms") {
      // Money/number conflict: a different net-days is material (Net 60 vs Net 30).
      const cNet = netDays(campaignValue);
      const bNet = netDays(briefText);
      if (cNet !== null && bNet !== null && cNet !== bNet) {
        conflicts.push({ ...base, reason: `net-days mismatch (${cNet} vs ${bNet})` });
      }
      continue;
    }

    if (key === "usageRights" || key === "attributionWindow") {
      // Duration conflict: a different day-count on the SAME term is material.
      const cDays = dayCount(campaignValue);
      const bDays = dayCount(briefText);
      if (cDays !== null && bDays !== null && cDays !== bDays) {
        conflicts.push({ ...base, reason: `duration mismatch (${cDays} vs ${bDays} days)` });
      }
      continue;
    }

    if (key === "exclusivity") {
      // Term-presence conflict: the Campaign says non-exclusive but the brief
      // asserts an exclusive clause (or vice versa). Only the clear opposite-stance
      // case is flagged.
      const cNonExcl = /\bnon[- ]?exclusiv/i.test(campaignValue);
      const bExcl = /\bexclusiv/i.test(briefText) && !/\bnon[- ]?exclusiv/i.test(briefText);
      const cExcl = /\bexclusiv/i.test(campaignValue) && !cNonExcl;
      const bNonExcl = /\bnon[- ]?exclusiv/i.test(briefText);
      if ((cNonExcl && bExcl) || (cExcl && bNonExcl)) {
        conflicts.push({
          ...base,
          reason: "exclusivity stance mismatch (campaign vs brief disagree on exclusivity)",
        });
      }
      continue;
    }
  }
  return conflicts;
}

/** Coerce an agent /parse-brief section-map payload into typed CampaignBriefSection
 *  objects, stamping the immutable file ref (the parser is ref-agnostic, §5).
 *  Exported for unit tests (the wire-mapping is where a schema drift would bite). */
export function projectSections(
  raw: unknown,
  ref: string,
  parserVersion: string,
): Partial<Record<string, CampaignBriefSection>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, CampaignBriefSection> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // faq/other are list-valued agent-side; v1 threads only the single-value keys
    // into AvailableSections.brief (PLU-114 selects over those). A list value is
    // skipped here (kept out of the section map) — it still rode into flatText.
    if (Array.isArray(value)) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const text = typeof v["text"] === "string" ? v["text"] : "";
    if (!text.trim()) continue;
    out[key] = {
      type: typeof v["type"] === "string" ? (v["type"] as string) : key,
      text,
      sourceFileReference: ref, // stamp the real ref (invariant #4)
      parserVersion,
      ...(typeof v["pageStart"] === "number" ? { pageStart: v["pageStart"] as number } : {}),
      ...(typeof v["pageEnd"] === "number" ? { pageEnd: v["pageEnd"] as number } : {}),
      ...(typeof v["extractionConfidence"] === "number"
        ? { extractionConfidence: v["extractionConfidence"] as number }
        : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Resolve the parsed campaign-brief for a negotiation. Never throws — a knowledge
 * miss must degrade to "no extra knowledge" + a status, never fail the turn.
 *
 * `campaignFields` (optional) are the authoritative Campaign knowledge columns; when
 * provided AND the parse produced sections, material conflicts are detected (§4.5).
 * When absent (or the flag is off / no sections), the conflict pass is skipped.
 */
// The two I/O boundaries the resolver crosses, injectable so a unit test can drive
// deterministic parses (and count how many times the parser was actually called)
// without mocking modules or standing up the agent. Defaults ARE the real calls,
// so the production call site (negotiation.ts) is byte-identical.
export interface BriefResolveDeps {
  readFile: (ref: string) => Promise<Buffer>;
  parse: (pdfBase64: string) => Promise<Record<string, unknown>>;
}
const _realDeps: BriefResolveDeps = {
  readFile: (ref) => readStoredFile(ref),
  parse: (pdfBase64) => agentPostJson(agentBaseUrl(), "/parse-brief", { pdfBase64 }),
};

export async function resolveBriefKnowledge(
  nodeGraph: NodeSnapshot[],
  campaignFields?: CampaignKnowledgeFields,
  deps: BriefResolveDeps = _realDeps,
): Promise<ResolvedBrief> {
  const ref = briefRefFromGraph(nodeGraph);
  if (!ref) return { flatText: "", status: "no_brief" };

  // PLU-82 review §3 (Calvin): key the read on the EXPECTED parser version, which
  // we know before the parse. A stale entry cached under a DIFFERENT version (an
  // older parser, or a mixed-deploy peer) no longer matches, so bumping
  // BRIEF_PARSER_VERSION forces a re-parse instead of reusing a version-A result.
  // (The prior `startsWith(`${ref}::`)` scan returned the first match regardless of
  // version — the invalidation bug.) The working set is one brief per campaign, so
  // the direct Map.get is also strictly cheaper than the scan it replaces.
  const hit = cacheGet(cacheKey(ref, expectedParserVersion()));
  if (hit) {
    return withConflicts(hit, campaignFields);
  }

  let resolved: ResolvedBrief;
  try {
    const bytes = await deps.readFile(ref);
    const data = await deps.parse(bytes.toString("base64"));
    const flatText = typeof data["text"] === "string" ? data["text"] : "";
    const status = normalizeStatus(data["status"]);
    const parserVersion =
      typeof data["parserVersion"] === "string" && data["parserVersion"].trim()
        ? (data["parserVersion"] as string)
        : "unknown";
    const sections = projectSections(data["sections"], ref, parserVersion);
    resolved = {
      flatText,
      status,
      ...(sections ? { sections } : {}),
      ...(typeof data["tierUsed"] === "string" ? { tierUsed: data["tierUsed"] as string } : {}),
      ...(typeof data["pageCount"] === "number" ? { pageCount: data["pageCount"] as number } : {}),
    };

    // Cache only ok/empty (invariant / §4.4): a parse_failed must NOT be cached so
    // a transient agent timeout is retried next turn instead of poisoning the
    // brief until process restart (fixes BUG-E8). Keyed on the version the agent
    // RETURNED (provenance-accurate). The read path keys on expectedParserVersion();
    // when they match (the normal case) the next turn hits, and when they DON'T (a
    // stale entry from an older parser) the read misses and re-parses — which is the
    // correct behavior for PLU-82 review §3, not a cache we want to serve.
    if (status === "ok" || status === "empty") {
      cacheSet(cacheKey(ref, parserVersion), resolved);
    }
  } catch (err) {
    // Unreadable file, agent down/breaker-open, malformed response — all degrade
    // to a parse_failed status with no knowledge. The structured Campaign fields
    // (usageRights/exclusivity/…) remain the primary source, so a brief miss is a
    // soft loss, not a correctness bug. NOT cached (retry next turn).
    console.error(
      `[briefKnowledge] failed to resolve brief ${ref}, continuing without it: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    resolved = { flatText: "", status: "parse_failed" };
  }

  return withConflicts(resolved, campaignFields);
}

/** Attach the conflict list (§4.5) when we have both sections and Campaign fields.
 *  Pure — returns a new object so a cached entry is never mutated. */
function withConflicts(
  resolved: ResolvedBrief,
  campaignFields?: CampaignKnowledgeFields,
): ResolvedBrief {
  if (!resolved.sections || !campaignFields) return resolved;
  const conflicts = detectBriefConflicts(resolved.sections, campaignFields);
  return conflicts.length ? { ...resolved, conflicts } : resolved;
}

/** Coerce the agent's status string to a known BriefParseStatus (defaults to ok —
 *  an old agent that returns no status returns flat text, which IS an ok parse).
 *  Exported for unit tests. */
export function normalizeStatus(raw: unknown): BriefParseStatus {
  return raw === "empty" || raw === "parse_failed" ? raw : "ok";
}

// ---------------------------------------------------------------------------
// PLU-82 §4.4: explicit brief AVAILABILITY (the issue's four-state result)
// ---------------------------------------------------------------------------
// The issue's core complaint: the brief resolver could not say WHY it had no
// knowledge — "no brief uploaded" and "a brief exists but parsing failed" both
// historically collapsed to text = "". PLU-107 already separated the INTERNAL
// status (no_brief / ok / empty / parse_failed); PLU-82 projects that (plus which
// EXPECTED sections are present) to the issue's four-state BriefKnowledgeResult so
// an operator finally sees the distinction.
//
// This is a PURE PROJECTION over the already-cached ResolvedBrief (invariant #5,
// #10): it changes no parser logic, no cache logic (empty stays cached,
// parse_failed stays uncached — the BUG-E8 fix), and gates NO prompt in v1 — the
// agent already owns honest-defer. It is an observability label only (§4.6).

export interface BriefKnowledgeResult {
  status: "NO_BRIEF" | "AVAILABLE" | "PARTIAL" | "PARSE_FAILED";
  /** The immutable upload ref, when a brief is configured on the graph. */
  fileReference?: string;
  /** ResolvedBrief.flatText, when present (non-empty). */
  text?: string;
  /** A short reason on PARSE_FAILED (which underlying status produced it). */
  error?: string;
  /** For PARTIAL: the EXPECTED sections that were absent (observability detail). */
  missingSections?: string[];
}

/**
 * Project a ResolvedBrief + the campaign's expected sections to the four-state
 * availability result (§4.4). Pure — no I/O, no cache touch.
 *
 * `expectedSections` must be the campaign's DECLARED knowledge fields ∩
 * _CONFLICT_KEYS (usageRights/exclusivity/paymentTerms/attributionWindow that the
 * campaign actually populated) — NOT every possible section key, or every brief is
 * PARTIAL forever (§4.4). A section is only "expected" if the campaign has that
 * term. `fileReference` (optional) is the brief upload ref, threaded through for
 * the panel; it does not affect the status.
 *
 * Mapping (invariant #5):
 *   no_brief      → NO_BRIEF
 *   parse_failed  → PARSE_FAILED (error set)
 *   empty         → PARSE_FAILED — present-but-unreadable ≠ absent (a scanned/
 *                   image PDF that parsed to no text must never read as "no brief")
 *   ok + no usable content (blank text, no sections) → PARSE_FAILED (review §4:
 *                   a missing/defaulted "ok" status must not read as AVAILABLE)
 *   ok + all expected sections present → AVAILABLE
 *   ok + ≥1 expected section absent    → PARTIAL
 */
export function deriveBriefAvailability(
  resolved: ResolvedBrief,
  expectedSections: string[],
  fileReference?: string,
): BriefKnowledgeResult {
  const refPart = fileReference && fileReference.trim() ? { fileReference } : {};

  switch (resolved.status) {
    case "no_brief":
      return { status: "NO_BRIEF", ...refPart };
    case "parse_failed":
      return { status: "PARSE_FAILED", error: "agent unreadable / malformed parse", ...refPart };
    case "empty":
      // Present-but-unreadable (parsed to no extractable text) — NOT absent
      // (invariant #5). Caching is untouched: empty stays cached; this map is a
      // pure view over that cached result (§8-i).
      return { status: "PARSE_FAILED", error: "empty extraction (no readable text)", ...refPart };
    case "ok": {
      const sections = resolved.sections ?? {};
      // PLU-82 review §4 (Calvin): AVAILABLE must require actual usable content.
      // normalizeStatus defaults a MISSING/unknown agent status to "ok" (an old
      // agent that returns only flat text is a real parse) — but "ok" + blank
      // flatText + no usable sections is a malformed/blank response, not a
      // successful availability result. Treat it as PARSE_FAILED so a brief-
      // dependent question can honestly defer instead of trusting empty content.
      const hasUsableSection = Object.values(sections).some(
        (s) => s && typeof s.text === "string" && s.text.trim(),
      );
      if (!resolved.flatText.trim() && !hasUsableSection) {
        return {
          status: "PARSE_FAILED",
          error: "ok status but no usable content (blank text, no sections)",
          ...refPart,
        };
      }
      const missing = expectedSections.filter((k) => {
        const s = sections[k];
        return !s || typeof s.text !== "string" || !s.text.trim();
      });
      const textPart = resolved.flatText.trim() ? { text: resolved.flatText } : {};
      if (missing.length === 0) {
        return { status: "AVAILABLE", ...textPart, ...refPart };
      }
      return { status: "PARTIAL", missingSections: missing, ...textPart, ...refPart };
    }
    default: {
      // Exhaustiveness backstop — an unknown status is treated as unreadable
      // rather than silently "available".
      const _never: never = resolved.status;
      return { status: "PARSE_FAILED", error: `unknown status ${String(_never)}`, ...refPart };
    }
  }
}

/** Test hook: clear the in-process cache. */
export function _clearBriefCache(): void {
  _cache.clear();
}
