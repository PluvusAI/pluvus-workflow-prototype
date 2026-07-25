import type {
  ConversationObligation,
  Event,
  Message,
} from "../../db/schema.js";
import type { PriorNegotiationContext, NegotiationHistoryEntryLite } from "../types.js";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import { extractReplyText } from "./replyText.js";

// drafting-humanization (§Conversation State): the closed vocabulary a term may
// be flagged with in `changedFields`. Mirrors the agent-side vocabulary. Only the
// fee is negotiated per-turn in this system (commission/perk/deliverables/timeline
// are FIXED campaign config), so `computeChangedFields` only ever emits "fee" —
// but the vocabulary is kept complete for parity with the agent and forward use.
export type ChangedField = "fee" | "commission" | "deliverables" | "timeline" | "perk";
export type RelationshipWarmth = "new" | "warming" | "established";

// ---------------------------------------------------------------------------
// Negotiation history assembly (FIX-1 history threading + FIX-2 current offer)
// ---------------------------------------------------------------------------
// The agent service is stateless per call (key invariant). The executor — the
// only reader/writer of instance state — assembles the conversation so far from
// the append-only NEGOTIATION_TURN events and threads it into agent.negotiate().
//
// This is a pure function over already-fetched events so it can be unit-tested
// without a database.

type Payload = Record<string, unknown>;

const VALID_ACTIONS = new Set(["ACCEPT", "COUNTER", "REJECT", "ESCALATE", "PRESENT_OFFER"]);

function asPayload(p: unknown): Payload {
  return p && typeof p === "object" ? (p as Payload) : {};
}

/** Normalize an event payload's `outcome` (lowercase "counter" or uppercase
 *  "COUNTER" both appear historically) to the canonical action label. */
function normalizeAction(raw: unknown): NegotiationHistoryEntryLite["action"] | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase();
  return VALID_ACTIONS.has(upper) ? (upper as NegotiationHistoryEntryLite["action"]) : null;
}

function asNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function asString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Build the prior-negotiation context from an instance's events.
 *
 * @param events  All events for the instance (any order). Only NEGOTIATION_TURN
 *                events are considered.
 * @returns history (chronological by `occurredAt`) and the most-recently
 *          proposed rate as `currentOffer`.
 */
export function buildPriorContextFromEvents(events: Event[]): PriorNegotiationContext {
  const turns = events
    .filter((e) => e.type === "NEGOTIATION_TURN")
    .slice()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const history: NegotiationHistoryEntryLite[] = [];
  let currentOffer: number | undefined;

  for (const turn of turns) {
    const payload = asPayload(turn.payload);
    const action = normalizeAction(payload["outcome"]);
    if (!action) continue; // skip malformed/foreign payloads

    const round = asNumber(payload["round"]) ?? history.length;
    // The proposed rate is persisted as `rate` (added in FIX-2); tolerate its
    // absence for pre-FIX events.
    const rate = asNumber(payload["rate"]);
    const message = asString(payload["message"]);

    history.push({
      round,
      action,
      ...(rate !== undefined ? { rate } : {}),
      ...(message !== undefined ? { message } : {}),
    });

    // Track the last rate we actually put on the table (an offer we made).
    // ACCEPT/COUNTER/PRESENT_OFFER carry a proposed number; REJECT/ESCALATE do
    // not. PRESENT_OFFER (answering a "what's the rate?" question) is a genuine
    // offer on the table, so the next turn knows our standing number.
    if (rate !== undefined && (action === "ACCEPT" || action === "COUNTER" || action === "PRESENT_OFFER")) {
      currentOffer = rate;
    }
  }

  return { history, ...(currentOffer !== undefined ? { currentOffer } : {}) };
}

// ---------------------------------------------------------------------------
// PLU-85: both-sides transcript sourced from Message rows (what was communicated)
// ---------------------------------------------------------------------------
// buildPriorContextFromEvents (above) feeds /negotiate the DECISION history —
// event-sourced by design (why the system decided). It is LEFT UNCHANGED.
//
// The both-sides transcript threaded into /draft (HARD-N2) and /negotiate (F-H1)
// is a different thing: a record of what was actually COMMUNICATED. It must be
// built from `Message` rows, not events, because `event.payload.message` is the
// AI's decision-step DRAFT — it can diverge from the utterance the creator
// actually received (operator edit, template change, a reserved-but-unsent /
// stranded delayed send, an eventless operator/transactional send). Sourcing the
// transcript from events makes the model reason against a history that may never
// have happened. Sourcing it from sent Message rows fixes that.
//
// This builder therefore:
//   - takes OUR side from OUTBOUND Message rows that were actually delivered
//     (`sentAt !== null`) — reserved-but-unsent / stranded / rolled-back rows
//     are dropped (they have `sentAt === null`);
//   - takes the CREATOR side from INBOUND rows (unchanged), via extractReplyText;
//   - ENRICHES each outbound entry with `round`/`action`/`rate` by joining the
//     sent row to its owning NEGOTIATION_TURN event (a Message row has `body` but
//     not those fields) — text/timing are canonical, event fields enrich;
//   - orders by real delivery time (`sentAt` / `receivedAt`, `createdAt` fallback);
//   - carries the source `messageId` for auditability.
//
// `brandReplyMsgIds` are inbound rows that are actually the BRAND answering an
// escalation (A1/A2), not the creator — excluded here so the brand's "approve"
// never appears as a creator turn.

/** A dated item to sort our-turns and creator-messages into one timeline. */
interface DatedEntry {
  at: number;
  entry: DraftHistoryEntry;
}

/** Enrichment recovered from the owning NEGOTIATION_TURN event for a sent
 *  outbound row (a Message has `body` but not these). All optional — an eventless
 *  send (operator/manual/transactional) resolves to an empty enrichment and is
 *  still included, text-only. */
interface OutboundEnrichment {
  round?: number;
  action?: NegotiationHistoryEntryLite["action"];
  rate?: number;
}

/** The idempotencyKey outcome token → canonical action. The outbound send is
 *  reserved with `negotiation:<token>:<instanceId>:<round>[:<inboundId>]`
 *  (see negotiation.ts reserveAiReply). `close` is the courteous max-rounds
 *  close email — a REJECT from the creator's point of view. */
const KEY_TOKEN_TO_ACTION: Record<string, NegotiationHistoryEntryLite["action"]> = {
  counter_offer: "COUNTER",
  acceptance: "ACCEPT",
  close: "REJECT",
  present: "PRESENT_OFFER",
};

/** Parse `round` + `action` from an outbound row's negotiation idempotencyKey.
 *  Returns null for a non-negotiation / malformed / absent key (an eventless
 *  operator or transactional send), in which case the row is included text-only. */
function parseNegotiationKey(
  key: string | null,
): { action: NegotiationHistoryEntryLite["action"]; round: number } | null {
  if (!key || !key.startsWith("negotiation:")) return null;
  // negotiation:<token>:<instanceId>:<round>[:<inboundId>]
  const parts = key.split(":");
  if (parts.length < 4) return null;
  const token = parts[1] ?? "";
  const action = KEY_TOKEN_TO_ACTION[token];
  if (!action) return null;
  // The round is the segment AFTER the instanceId. For `present` an optional
  // trailing `:<inboundId>` may follow, so the round is parts[3] regardless.
  const round = asNumber(Number(parts[3]));
  if (round === undefined) return null;
  return { action, round };
}

/** Index NEGOTIATION_TURN events by `round` so a sent outbound row can recover
 *  its `rate` (and confirm the action) from the owning turn. Keyed by round;
 *  each round maps to that round's turns (usually one, but a round can carry a
 *  PRESENT_OFFER before the decision — hence an array, matched by action). */
function indexEventsByRound(events: Event[]): Map<number, { action: NegotiationHistoryEntryLite["action"] | null; rate?: number }[]> {
  const byRound = new Map<number, { action: NegotiationHistoryEntryLite["action"] | null; rate?: number }[]>();
  for (const e of events) {
    if (e.type !== "NEGOTIATION_TURN") continue;
    const payload = asPayload(e.payload);
    const round = asNumber(payload["round"]);
    if (round === undefined) continue;
    const action = normalizeAction(payload["outcome"]);
    const rate = asNumber(payload["rate"]);
    const list = byRound.get(round) ?? [];
    list.push({ action, ...(rate !== undefined ? { rate } : {}) });
    byRound.set(round, list);
  }
  return byRound;
}

/** Recover round/action/rate for a sent outbound row (§4.3, the enrich-join).
 *  Strategy A (primary): parse the idempotencyKey for round+action — these are
 *  exact and canonical. Then pull `rate` from the NEGOTIATION_TURN event at the
 *  same round whose action agrees with the key.
 *  Strategy B (fallback): the reserve key and its event's persisted `round` can
 *  differ by one on two paths (a max-rounds `close` keyed on the current round vs
 *  the event's `maxRounds`; a `present` past the free-present cap keyed on the
 *  current round vs the event's advanced round). When the exact round misses,
 *  recover `rate` from the NEAREST-round event with the same action, so those
 *  turns still enrich. Both are ACCEPT/COUNTER-free (REJECT carries no rate; a
 *  present rate is often absent), so this only ever fills an otherwise-blank rate.
 *  Graceful degradation: an eventless / unkeyed send returns an empty enrichment
 *  and is still rendered (text-only). */
function enrichOutbound(
  row: Message,
  eventsByRound: Map<number, { action: NegotiationHistoryEntryLite["action"] | null; rate?: number }[]>,
): OutboundEnrichment {
  const parsed = parseNegotiationKey(row.idempotencyKey);
  if (!parsed) return {};
  const { action, round } = parsed;
  // Strategy A: the event at this exact round whose action agrees with the key,
  // else the first turn at that round (don't hard-require action equality — the
  // key's action is authoritative and already returned).
  const turns = eventsByRound.get(round) ?? [];
  let rate = (turns.find((t) => t.action === action) ?? turns[0])?.rate;
  // Strategy B: no rate at the exact round → nearest-round event with the same
  // action (the ±1 keying-drift paths above). Never overrides an exact hit.
  if (rate === undefined) {
    let bestDelta = Infinity;
    for (const [r, list] of eventsByRound) {
      const hit = list.find((t) => t.action === action && t.rate !== undefined);
      if (!hit) continue;
      const delta = Math.abs(r - round);
      if (delta < bestDelta) {
        bestDelta = delta;
        rate = hit.rate;
      }
    }
  }
  return { round, action, ...(rate !== undefined ? { rate } : {}) };
}

/**
 * Build the both-sides transcript from Message rows (PLU-85).
 *
 * @param messages   ALL Message rows for the instance (both directions) — the
 *                   outbound rows are already loaded by `loadCreatorInbounds`.
 * @param excludedMessageIds  Legacy brand-reply externalMessageIds to exclude
 *                   from the creator side (a brand escalation reply persisted
 *                   INBOUND must not read as a creator turn).
 * @param events     NEGOTIATION_TURN events, used ONLY to enrich outbound entries
 *                   with round/action/rate. The events remain the separate
 *                   decision history (buildPriorContextFromEvents) untouched.
 */
export function buildDraftHistory(
  messages: Message[],
  excludedMessageIds: Set<string>,
  events: Event[],
): DraftHistoryEntry[] {
  const items: DatedEntry[] = [];
  const eventsByRound = indexEventsByRound(events);

  for (const m of messages) {
    if (m.direction === "OUTBOUND") {
      // Invariant #2: an outbound turn counts only if it was actually delivered.
      // Reserved-but-unsent (delay window), stranded/failed, and rolled-back
      // orphan rows all have `sentAt === null` and are dropped here.
      if (m.sentAt === null) continue;
      // We composed our own copy clean — use the body RAW (running the inbound
      // reply extractor on it could truncate legitimate content). §4.4.
      const body = m.body ?? "";
      if (!body.trim()) continue;
      const enrich = enrichOutbound(m, eventsByRound);
      const at = (m.sentAt ?? m.createdAt).getTime();
      items.push({
        at,
        entry: {
          role: "us",
          ...(enrich.round !== undefined ? { round: enrich.round } : {}),
          ...(enrich.action ? { action: enrich.action } : {}),
          ...(enrich.rate !== undefined ? { rate: enrich.rate } : {}),
          message: body,
          messageId: m.id,
        },
      });
      continue;
    }

    // INBOUND (creator side) — unchanged behavior.
    if (m.direction !== "INBOUND") continue;
    if (m.externalMessageId && excludedMessageIds.has(m.externalMessageId)) continue;
    const text = extractReplyText(m.body ?? "");
    if (!text.trim()) continue;
    // Prefer the received time; fall back to createdAt for older rows.
    const at = (m.receivedAt ?? m.createdAt).getTime();
    items.push({ at, entry: { role: "creator", message: text, messageId: m.id } });
  }

  items.sort((a, b) => a.at - b.at);
  return items.map((i) => i.entry);
}

// HARD-N2 answered-questions ledger. Each NEGOTIATION_TURN event persists the
// creator's questions for that turn (payload.creatorQuestions). A question the
// creator raised in an EARLIER round that we never carried forward should be
// re-surfaced, not silently dropped. We can't perfectly prove "answered", so the
// ledger is a conservative diff: prior-round questions that are NOT among this
// turn's questions are treated as still-open and re-listed for the copywriter
// (which will answer or honestly defer each). De-duplicated case-insensitively.
export function computeOpenQuestions(
  events: Event[],
  currentQuestions: string[] | undefined,
): string[] {
  const current = new Set((currentQuestions ?? []).map((q) => q.trim().toLowerCase()));
  const open: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "NEGOTIATION_TURN") continue;
    const payload = asPayload(e.payload);
    const qs = payload["creatorQuestions"];
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      if (typeof q !== "string") continue;
      const norm = q.trim();
      if (!norm) continue;
      const key = norm.toLowerCase();
      if (current.has(key) || seen.has(key)) continue;
      seen.add(key);
      open.push(norm);
    }
  }
  return open;
}

// ---------------------------------------------------------------------------
// PLU-111: Conversation-obligation plan builder + read (supersedes the diff)
// ---------------------------------------------------------------------------
// The obligation ledger (db/conversationObligations.ts) replaces the
// event-diff computeOpenQuestions above as the source of truth for "what's
// open". These are the PURE pieces the executor uses: normalize a question to
// its dedup key, decide inserts-vs-touches for a turn's questions against the
// existing open rows, and split non-terminal rows into the openQuestions /
// openCommitments the AI context reads. Kept here (pure, no DB) so they unit-
// test exactly like computeOpenQuestions. computeOpenQuestions itself is RETAINED
// as the empty-table fallback (§4.7) until old instances drain (a follow-up).

/**
 * The conservative dedup key for an obligation (§4.3): lowercase, trimmed,
 * punctuation-stripped, whitespace-collapsed. Collapses the trivial cross-turn
 * rephrases the agent's own per-turn _normalize_questions can't see, WITHOUT
 * fuzzy/semantic merging — two genuinely different asks keep distinct keys (a
 * wrong merge silently drops a real question, the worse failure, invariant #3).
 */
export function normalizeObligationKey(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    // strip punctuation/symbols but keep letters, numbers, and whitespace.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One planned obligation write for the turn — pure, applied later in-tx. */
export interface QuestionObligationPlanItem {
  /** "insert" mints a new OPEN row; "touch" updates an existing open row. */
  op: "insert" | "touch";
  /** Present on "touch": the id of the existing open row to update. */
  existingId?: string;
  originalText: string;
  normalizedKey: string;
  category?: string | undefined;
}

/**
 * Decide the create/update plan for a turn's creator questions against the
 * instance's existing NON-TERMINAL obligations (§4.3, §4.4). Pure — the executor
 * applies the plan inside stepInstance's transaction (§4.6).
 *
 *   - a question whose normalizedKey matches an existing open CREATOR_QUESTION
 *     row → "touch" (a re-ask of a still-open question; no new row).
 *   - otherwise → "insert" (a new open thread). A re-ask matching only a
 *     TERMINAL row is NOT in existingOpenRows, so it correctly inserts (the
 *     creator re-opened the thread).
 *
 * De-duplicates WITHIN the turn too: two incoming questions that normalize to
 * the same key produce a single plan item (the first wording wins).
 *
 * @param categoryOf optional best-effort bucket for a question (§4.4 / O5).
 */
export function buildQuestionObligationPlan(
  creatorQuestions: string[] | undefined,
  existingOpenRows: ConversationObligation[],
  categoryOf?: (question: string) => string | undefined,
): QuestionObligationPlanItem[] {
  const openByKey = new Map<string, ConversationObligation>();
  for (const row of existingOpenRows) {
    if (row.type !== "CREATOR_QUESTION") continue;
    // First open row per key wins the touch target (there's at most one under
    // the partial-unique index anyway).
    if (!openByKey.has(row.normalizedKey)) openByKey.set(row.normalizedKey, row);
  }

  const plan: QuestionObligationPlanItem[] = [];
  const seenThisTurn = new Set<string>();
  for (const raw of creatorQuestions ?? []) {
    if (typeof raw !== "string") continue;
    const originalText = raw.trim();
    if (!originalText) continue;
    const normalizedKey = normalizeObligationKey(originalText);
    if (!normalizedKey) continue;
    if (seenThisTurn.has(normalizedKey)) continue; // collapse intra-turn repeats
    seenThisTurn.add(normalizedKey);

    const category = categoryOf?.(originalText);
    const existing = openByKey.get(normalizedKey);
    if (existing) {
      plan.push({
        op: "touch",
        existingId: existing.id,
        originalText,
        normalizedKey,
        ...(category ? { category } : {}),
      });
    } else {
      plan.push({
        op: "insert",
        originalText,
        normalizedKey,
        ...(category ? { category } : {}),
      });
    }
  }
  return plan;
}

/** The AI-context read: non-terminal obligations split by type (§4.7). */
export interface OpenObligations {
  openQuestions: string[];
  openCommitments: string[];
}

/**
 * Split a set of NON-TERMINAL obligation rows into the openQuestions (fed to the
 * /draft must-answer checklist, unchanged field) and openCommitments (the new
 * "outstanding Pluvus commitments" block). Callers pass the rows from
 * listOpenObligationsByInstance; this is pure so it's trivially testable.
 * De-duplicated case-insensitively, order preserved (rows arrive chronological).
 */
export function buildOpenObligations(
  rows: ConversationObligation[],
): OpenObligations {
  const openQuestions: string[] = [];
  const openCommitments: string[] = [];
  const seenQ = new Set<string>();
  const seenC = new Set<string>();
  for (const row of rows) {
    const text = row.originalText.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (row.type === "CREATOR_QUESTION") {
      if (seenQ.has(key)) continue;
      seenQ.add(key);
      openQuestions.push(text);
    } else if (row.type === "PLUVUS_COMMITMENT") {
      if (seenC.has(key)) continue;
      seenC.add(key);
      openCommitments.push(text);
    }
  }
  return { openQuestions, openCommitments };
}

// ---------------------------------------------------------------------------
// PLU-114: structured obligations for campaign-knowledge retrieval (§4.4)
// ---------------------------------------------------------------------------
// The knowledge router (agent-side `select_knowledge_sections`) needs each open
// obligation's `category` + `originalText` to widen retrieval to the section it's
// on the hook to answer (invariant #5) — the flattened `openCommitments: string[]`
// drops the category, so this is a SEPARATE structured projection threaded
// alongside it. Both CREATOR_QUESTION and PLUVUS_COMMITMENT rows are relevant
// inputs (a still-open creator question about shipping AND an unfulfilled Pluvus
// shipping commitment both pull the shipping section). Read-only, category is
// best-effort (may be null → the router routes off originalText instead).

/** One obligation projected for the knowledge router: {category, originalText, id}. */
export interface StructuredObligation {
  id: string;
  originalText: string;
  category?: string;
}

/**
 * Project non-terminal obligation rows into the {category, originalText, id} shape
 * the PLU-114 knowledge router consumes. Pure; dedup by originalText (case-
 * insensitive) preserving chronological order — same dedup discipline as
 * buildOpenObligations. Empty in → empty out (no wire field attached, byte-
 * identical). NEVER a money input; retrieval only narrows what the model reads.
 */
export function buildStructuredObligations(
  rows: ConversationObligation[],
): StructuredObligation[] {
  const out: StructuredObligation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const text = row.originalText.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: row.id,
      originalText: text,
      ...(row.category ? { category: row.category } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// drafting-humanization (§Conversation State): the two STYLE hints for /draft
// ---------------------------------------------------------------------------
// Both are purely stylistic — the money decision never reads them — and both
// default so an unset value reproduces today's copy exactly. Pure functions over
// already-fetched context so they're unit-testable without a DB.

/**
 * Which offer terms actually CHANGED this turn, so the offer copy can state the
 * delta instead of restating the full state (§Repetition Reduction).
 *
 * Only the fixed FEE is negotiated per-turn here (commission / perk / deliverables
 * / timeline are fixed campaign config, never re-proposed), so this diffs the rate
 * we're putting on the table this turn against the last rate we offered
 * (`priorContext.currentOffer`, tracked by buildPriorContextFromEvents). Returns
 * ["fee"] when the fee is being presented for the FIRST time (no prior offer) or
 * differs from our last offer; [] when it's unchanged or absent — in which case
 * the agent omits the delta hint and falls back to "restate only what was asked",
 * i.e. today's behavior.
 */
export function computeChangedFields(
  priorContext: PriorNegotiationContext,
  proposedRate: number | undefined,
): ChangedField[] {
  if (proposedRate === undefined || !Number.isFinite(proposedRate)) return [];
  const lastOffer = priorContext.currentOffer;
  // First offer (no prior rate on the table) → the fee is news. A changed rate
  // vs our last offer → news. Same rate as last time → not news (don't restate).
  if (lastOffer === undefined || lastOffer !== proposedRate) return ["fee"];
  return [];
}

/**
 * Coarse relationship-warmth for the offer email's tone (§Progressive Conversation
 * Behaviour). Derived from round count + a cheap cooperativeness read, never from
 * anything confidential:
 *   "new"         — round <= 1 (first offer; today's round-1 tone).
 *   "warming"     — mid-thread and engaged (default once past round 1).
 *   "established" — a cooperative back-and-forth that's deep in the thread: the
 *                   creator has engaged over multiple rounds AND either moved
 *                   toward our number or we're near the round ceiling (closing out).
 *
 * `creatorMovedToward` is the caller's optional read of "did the creator concede
 * toward us" (e.g. their ask dropped). Absent/false is safe — warmth then steps up
 * to "established" only via thread depth, never below the round-derived rung. The
 * agent takes the WARMER of this hint and what `round` implies, so this can only
 * add warmth, never cool the email.
 */
export function computeRelationshipWarmth(args: {
  round: number;
  maxRounds: number;
  priorTurnCount: number;
  creatorMovedToward?: boolean;
}): RelationshipWarmth {
  const { round, maxRounds, priorTurnCount, creatorMovedToward } = args;
  if (round <= 1) return "new";
  // Engaged = we've actually exchanged prior turns (not a one-shot). Deep = we're
  // at least a third of the way through the round budget (maxRounds <= 0 means
  // unlimited, so depth alone can't trigger "established" there — cooperation can).
  const engaged = priorTurnCount >= 1;
  const deep = maxRounds > 0 && round >= Math.max(2, Math.ceil(maxRounds / 3));
  if (engaged && (creatorMovedToward === true || deep)) return "established";
  return "warming";
}
