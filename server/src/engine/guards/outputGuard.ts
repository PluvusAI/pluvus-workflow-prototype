// ---------------------------------------------------------------------------
// Outbound draft output guard (FIX-4)
// ---------------------------------------------------------------------------
// A mandatory net before any AI-generated email is sent to a creator. The
// negotiation prompt instructs the model to NEVER reveal the internal floor or
// ceiling, but a prompt rule is not a control: one model slip or one prompt
// injection and the budget bounds go out the door. This guard scans the
// rendered draft for those numbers (and any configured internal terms) and
// blocks the send on a hit so the executor can route to MANUAL_REVIEW instead.
//
// Pure function — no IO — so it is fully unit-testable without a DB or network.

import { resolveBand } from "../band.js";

export interface GuardDraft {
  subject?: string | null;
  body: string;
}

export interface GuardConstraints {
  /** Internal minimum we must never disclose. */
  floor?: number | undefined;
  /** Internal maximum we must never disclose. */
  ceiling?: number | undefined;
  /**
   * The rate we deliberately intend to present this turn (the offer being
   * made). It is allowlisted so a legitimate offer that happens to coincide
   * with a bound is not falsely blocked.
   */
  allowedRate?: number | undefined;
  /**
   * Additional rates that may legitimately appear in the draft even when they
   * coincide with a bound. The primary use is the CREATOR'S OWN STATED ASK: if
   * the creator proposed $500 and our ceiling is also $500, echoing their number
   * back ("we hear you'd like $500") is not a leak — they said it first, so it
   * discloses nothing internal. A bound the creator NEVER mentioned still blocks.
   * `allowedRate` (our presented offer) is always treated as allowlisted too.
   */
  allowedRates?: number[] | undefined;
  /**
   * The brand-set commission % for this campaign (hybrid deals). It is NON-
   * negotiable: the outbound draft may only ever state THIS percentage as the
   * commission. If the draft states any OTHER commission % (e.g. the model caved
   * to a creator's "make it 15%"), that is a promise the brand never authorized —
   * the draft is blocked. Undefined disables the check (cash-only / no commission).
   */
  commissionRate?: number | undefined;
  /** Extra internal strings that must never appear (case-insensitive). */
  internalTerms?: string[] | undefined;
}

export interface GuardHit {
  kind: "floor" | "ceiling" | "term" | "commission" | "amount";
  value: string;
}

export type GuardResult = { ok: true } | { ok: false; hits: GuardHit[] };

// EASY-S2: the guard-leak markers written to event payloads (and served raw by
// the observability timeline) must NOT carry the actual band value. Record only
// the KIND of thing that leaked (ceiling / floor / a specific term) with the
// value redacted — an operator can see "a ceiling value leaked into a draft"
// without the internal number itself sitting raw in event payloads for anyone
// with DB/log access. Endpoint auth is the parent system's job (CRITICAL-5
// removal); this masking is the component's own contribution to not leaking the
// band value. `${kind}:<redacted>` preserves the existing "kind:value" shape.
export function maskGuardHits(hits: GuardHit[]): string[] {
  return hits.map((h) => `${h.kind}:<redacted>`);
}

// Match a specific number as a standalone money-ish token: optional leading $,
// optional thousands separators, optional .00 — but NOT as a substring of a
// larger number (so 500 does not match inside 1500). Word boundaries on both
// sides via surrounding non-digit assertions.
function numberAppears(text: string, n: number): boolean {
  // Build patterns for the integer with and without thousands separators.
  const plain = String(n);
  const grouped = n.toLocaleString("en-US"); // e.g. 1,000
  const alternatives = new Set<string>([plain, grouped]);

  for (const num of alternatives) {
    // Escape regex metachars in the grouped form (the comma is literal).
    const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (?<![\d.,]) — not preceded by a digit/sep (avoids matching 2500 for 500)
    // (?:\.\d+)?  — tolerate a trailing decimal part
    // (?![\d])    — not followed by another digit
    const re = new RegExp(`(?<![\\d.,])\\$?${escaped}(?:\\.\\d+)?(?![\\d])`);
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Word-number matching (MED-S1)
// ---------------------------------------------------------------------------
// "our ceiling is five hundred dollars" leaked straight past the digit-only
// scan. We render the bound as English words and match it with flexible
// separators (spaces / hyphens / an optional "and"), so "five hundred",
// "Five-Hundred", and "four hundred and seventy five" all register. Bounds are
// small round integers in practice; anything outside 1..999,999 (or fractional)
// simply isn't word-matched — the digit scan still covers it.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function wordsBelowThousand(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(ONES[hundreds]!, "hundred");
  if (rest) {
    if (rest < 20) words.push(ONES[rest]!);
    else {
      words.push(TENS[Math.floor(rest / 10)]!);
      if (rest % 10) words.push(ONES[rest % 10]!);
    }
  }
  return words;
}

/** The word renderings of a positive integer — the canonical form plus the
 *  spoken "<tens> hundred" form for round hundreds (1500 → "fifteen hundred"). */
function wordVariants(n: number): string[][] {
  if (!Number.isInteger(n) || n <= 0 || n >= 1_000_000) return [];
  const variants: string[][] = [];
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const canonical: string[] = [];
  if (thousands) canonical.push(...wordsBelowThousand(thousands), "thousand");
  if (rest) canonical.push(...wordsBelowThousand(rest));
  variants.push(canonical);
  // Spoken form: 1100..9900 in whole hundreds ("fifteen hundred" = 1500).
  if (n % 100 === 0 && n >= 1100 && n <= 9900) {
    variants.push([...wordsBelowThousand(n / 100), "hundred"]);
  }
  return variants;
}

function numberAppearsAsWords(text: string, n: number): boolean {
  const variants = wordVariants(n);
  if (variants.length === 0) return false;
  const lower = text.toLowerCase();
  return variants.some((words) => {
    const pattern = "\\b" + words.join("(?:[\\s-]+(?:and[\\s-]+)?)") + "\\b";
    return new RegExp(pattern).test(lower);
  });
}

// Every explicit "$" amount in the text, as numeric values (thousands separators
// tolerated). Used by the MED-S1 allowlist-only rule: an outbound draft may state
// ONLY the money figures we deliberately put there.
const DOLLAR_AMOUNT_RE = /\$\s*(\d[\d,]*(?:\.\d+)?)/g;

function dollarAmountsMentioned(text: string): number[] {
  const found = new Set<number>();
  let m: RegExpExecArray | null;
  DOLLAR_AMOUNT_RE.lastIndex = 0;
  while ((m = DOLLAR_AMOUNT_RE.exec(text)) !== null) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(n)) found.add(n);
  }
  return [...found];
}

// Find every percentage in the text that is used as a COMMISSION rate, i.e. a
// number immediately followed by "%" (or "percent") that sits near the word
// "commission". Returns the distinct numeric values found. Used to enforce that
// the only commission % the draft states is the brand's configured one — the
// creator cannot negotiate the commission, so a different % is an unauthorized
// promise, not a leak. Deliberately narrow (must be adjacent to "commission")
// so an unrelated percentage — "30-day usage rights", "grew 15%" — is ignored.
function commissionPercentsMentioned(text: string): number[] {
  const found = new Set<number>();
  // A percentage token: 15%, 15 %, 15.5%, 15 percent.
  const pct = "(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)";
  // The percentage within ~40 chars BEFORE or AFTER the word "commission".
  const patterns = [
    new RegExp(`${pct}[^.]{0,40}?commission`, "gi"),
    new RegExp(`commission[^.]{0,40}?${pct}`, "gi"),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) found.add(n);
    }
  }
  return [...found];
}

/**
 * Scan a rendered outbound draft for disclosure of internal bounds.
 *
 * Returns `{ ok: true }` when the draft is clean, or `{ ok: false, hits }`
 * listing every leak found. The `allowedRate` is excluded from floor/ceiling
 * matching so a legitimate on-policy offer is never blocked.
 */
export function scanOutboundDraft(draft: GuardDraft, constraints: GuardConstraints): GuardResult {
  const haystack = `${draft.subject ?? ""}\n${draft.body}`;
  const hits: GuardHit[] = [];

  const { floor, ceiling, allowedRate, allowedRates, commissionRate, internalTerms } = constraints;

  // A bound is allowlisted (not a leak) when it equals the rate we are
  // intentionally presenting this turn (`allowedRate`) OR any rate in
  // `allowedRates` — chiefly the creator's own stated ask, which they disclosed
  // to us, so repeating it discloses nothing internal.
  const allow = new Set<number>();
  if (allowedRate !== undefined) allow.add(allowedRate);
  for (const r of allowedRates ?? []) allow.add(r);

  // MED-S1: a bound leaks in digits OR in words ("five hundred dollars").
  if (
    floor !== undefined &&
    !allow.has(floor) &&
    (numberAppears(haystack, floor) || numberAppearsAsWords(haystack, floor))
  ) {
    hits.push({ kind: "floor", value: String(floor) });
  }
  if (
    ceiling !== undefined &&
    !allow.has(ceiling) &&
    (numberAppears(haystack, ceiling) || numberAppearsAsWords(haystack, ceiling))
  ) {
    hits.push({ kind: "ceiling", value: String(ceiling) });
  }

  // MED-S1 allowlist-only rule: EVERY explicit "$" amount in the draft must be a
  // figure we deliberately put on the table — the presented/agreed rate
  // (`allowedRate`) or an `allowedRates` entry (the creator's own stated ask +
  // any $ value appearing in brand-authored copy like the perk description).
  // Anything else — a fabricated "$2,000 upfront bonus", an invented number that
  // equals neither bound — is a promise nobody authorized and blocks the send.
  // (A leaked bound is caught here too even when it slipped the checks above.)
  for (const amount of dollarAmountsMentioned(haystack)) {
    if (!allow.has(amount)) {
      hits.push({ kind: "amount", value: `$${amount} (not an authorized figure)` });
    }
  }

  const lower = haystack.toLowerCase();
  for (const term of internalTerms ?? []) {
    const t = term.trim().toLowerCase();
    if (t.length > 0 && lower.includes(t)) {
      hits.push({ kind: "term", value: term });
    }
  }

  // Commission is brand-set and NON-negotiable: the draft may only ever state the
  // configured commission %. Any OTHER commission % is a promise the creator
  // pushed for and the model wrongly conceded — block it. Skipped when no
  // commission is configured (cash-only deals never mention a commission rate).
  if (commissionRate !== undefined) {
    for (const pct of commissionPercentsMentioned(haystack)) {
      if (pct !== commissionRate) {
        hits.push({ kind: "commission", value: `${pct}% (expected ${commissionRate}%)` });
      }
    }
  }

  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}

/**
 * Pull guard constraints out of a node config's price band (termFloor/termCeiling
 * or minBudget/maxBudget), with an optional allowlisted rate and extra internal
 * terms.
 */
export function guardConstraintsFromConfig(
  config: Record<string, unknown>,
  allowedRate?: number,
  creatorRate?: number,
  // PLU-128: trusted brand-authored PUBLIC copy whose explicit "$" amounts are
  // authorized to appear in outbound (rewardDescription / deliverables / timeline
  // / brandDescription). Contributes ONLY $ values to `allowedRates` — never the
  // floor/ceiling/commission/internal terms, which stay sourced from `config`.
  // Defaults to `config` so existing single-config callers (followUp, negotiation,
  // rewardSetup, contentBrief) keep byte-identical behavior: they pass a
  // negotiation config that carries none of these fields, so the extraction stays
  // a no-op for them. Initial outreach passes the MERGED outreach config here so a
  // legitimate public value ("a $200 gift box") is not treated as a leak.
  publicCopyConfig: Record<string, unknown> = config,
): GuardConstraints {
  // Resolve floor/ceiling from EITHER termFloor/termCeiling or minBudget/
  // maxBudget so a UI-built workflow's bounds are still scanned for leaks (the
  // guard previously saw no band for UI configs — see resolveBand).
  const { floor, ceiling } = resolveBand(config);
  const internalTerms = Array.isArray(config["internalTerms"])
    ? (config["internalTerms"] as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  // The creator's own stated ask is allowlisted: echoing a number they gave us
  // is not a disclosure of an internal bound, even when the two coincide. This
  // is what lets a deal close/counter AT the ceiling or floor without the guard
  // falsely flagging the creator's number as a leak.
  //
  // Note on the ceiling-guessing concern (MED-S1 "reconsider"): this allowlist
  // is kept deliberately. The creator wrote the number first, so echoing it
  // discloses nothing internal; removing it would force every legitimate
  // at-bound negotiation into MANUAL_REVIEW. What a guessed-ceiling reply can
  // extract is at most an echo — the model is still prompt-forbidden from
  // CONFIRMING that a number is the bound, and the internal-terms scan blocks
  // "ceiling"/"maximum budget" style wording when configured.
  //
  // MED-S1: with the new allowlist-only "$" rule, any $ figure the BRAND put in
  // its own public copy (perk blurb "a $200 gift box", deliverables, timeline)
  // must also be allowed — those strings are threaded into the email verbatim
  // by design and are not leaks.
  const allowedRates: number[] = [];
  if (typeof creatorRate === "number" && Number.isFinite(creatorRate)) {
    allowedRates.push(creatorRate);
  }
  for (const key of ["rewardDescription", "deliverables", "timeline", "brandDescription"]) {
    const v = publicCopyConfig[key];
    if (typeof v === "string" && v) {
      for (const amount of extractConfigDollarAmounts(v)) allowedRates.push(amount);
    }
  }

  // Brand-set commission % (hybrid deals). Non-negotiable — the guard blocks a
  // draft that states any other commission %. Absent for cash-only campaigns.
  const commissionRate =
    typeof config["commissionRate"] === "number" && Number.isFinite(config["commissionRate"])
      ? (config["commissionRate"] as number)
      : undefined;

  return {
    ...(floor !== undefined ? { floor } : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
    ...(allowedRate !== undefined ? { allowedRate } : {}),
    ...(allowedRates.length > 0 ? { allowedRates } : {}),
    ...(commissionRate !== undefined ? { commissionRate } : {}),
    ...(internalTerms ? { internalTerms } : {}),
  };
}

// $ amounts appearing in a brand-authored config string (perk blurb etc.) —
// these are public-by-design and allowlisted for the MED-S1 "$" rule.
function extractConfigDollarAmounts(text: string): number[] {
  return dollarAmountsMentioned(text);
}
