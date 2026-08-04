// ---------------------------------------------------------------------------
// PLU-113 — campaign-scoped creator memory: PURE extraction + evidence checks
// ---------------------------------------------------------------------------
// Everything here is a PURE function over the model's extracted facts + the actual
// creator reply — no DB, no I/O — so it is unit-testable in isolation. The executor
// calls verifyAndBuildMemoryWritePlan to turn this turn's `creatorFacts` (plus the
// already-validated creatorRequestedRate) into a write plan; the DB layer applies
// it in-tx via applyMemoryWritePlan. buildCreatorMemoryBlock turns the live head
// rows the context-builder loaded into the sanitized read payload.
//
// Calvin review #3 — verifiable evidence for every extracted fact: a fact is
// persisted ONLY when its evidenceText actually appears in the normalized creator
// reply (confidence alone is not evidence). Structured facts add deterministic
// checks: MINIMUM_RATE numeric grounding, MANAGER_CONTACT name/email presence,
// MANAGER_INVOLVED explicit wording.

import type { CampaignCreatorMemory } from "../../db/schema.js";
import type { ExtractedFact } from "../../adapters/negotiation/types.js";
import type { CreatorMemoryPayload } from "../conversationContext/types.js";
import {
  isMemoryFactKey,
  isNumericMemoryKey,
  memoryDedupKey,
  normalizeMemoryValue,
  singletonSentinel,
  type MemoryFactKey,
  type MemoryWritePlanItem,
} from "../memoryKeys.js";

export type { ExtractedFact };

export const DEFAULT_MEMORY_MIN_CONFIDENCE = 0.5;

export interface VerifyMemoryPlanArgs {
  /** The model's extracted facts this turn (may be undefined / empty). */
  creatorFacts?: ExtractedFact[] | undefined;
  /** The creator's actual reply text (the untrusted ground truth evidence must
   *  appear in). Empty string ⇒ nothing can be verified ⇒ empty plan. */
  creatorReply: string;
  /** The id of the inbound Message the reply came from — every fact's provenance. */
  sourceMessageId?: string | undefined;
  /**
   * The already-validated creator ask (MED-N3). Reused to populate REQUESTED_RATE
   * so the memory rate and the copy-side ack rate can't disagree. Any REQUESTED_RATE
   * the model also emitted is ignored in favor of this validated number.
   */
  creatorRequestedRate?: number | null | undefined;
  /** Facts below this confidence are dropped (default 0.5). */
  minConfidence?: number;
}

/**
 * Turn this turn's extracted facts into a verified memory write plan (PURE).
 *
 *   1. REQUESTED_RATE is derived from the validated creatorRequestedRate (not the
 *      model's own facts). Its evidence is the validated number itself (it already
 *      passed the MED-N3 substring check agent-side), so it needs no re-check here.
 *   2. Every other fact must (a) have a recognized key, (b) clear the confidence
 *      floor, and (c) pass server-side evidence verification against the reply.
 *   3. Structured keys add deterministic checks (numeric grounding, name/email,
 *      explicit wording). A fact that fails any check is DROPPED — not persisted as
 *      a durable model interpretation.
 *   4. Intra-turn dedup: facts that normalize to the same (key,value) collapse.
 *
 * With no sourceMessageId there is no provenance to attach, so only the validated
 * REQUESTED_RATE (which is self-evidencing) can still be written — but a fact with
 * no source message is dropped, because provenance is required (issue "Scope":
 * "Store the source Message for each extracted fact").
 */
export function verifyAndBuildMemoryWritePlan(
  args: VerifyMemoryPlanArgs,
): MemoryWritePlanItem[] {
  const minConfidence = args.minConfidence ?? DEFAULT_MEMORY_MIN_CONFIDENCE;
  const normalizedReply = normalizeMemoryValue(args.creatorReply);
  const plan: MemoryWritePlanItem[] = [];
  const seen = new Set<string>();

  const push = (item: MemoryWritePlanItem): void => {
    const dedupKey = `${item.key}::${item.normalizedValue}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    plan.push(item);
  };

  // 1. REQUESTED_RATE from the validated ask. Self-evidencing (already substring-
  //    validated agent-side); requires a source message for provenance.
  if (
    typeof args.creatorRequestedRate === "number" &&
    Number.isFinite(args.creatorRequestedRate) &&
    args.sourceMessageId
  ) {
    const value = String(args.creatorRequestedRate);
    push({
      key: "REQUESTED_RATE",
      value,
      valueNumber: args.creatorRequestedRate,
      normalizedValue: singletonSentinel("REQUESTED_RATE"),
      matchValue: normalizeMemoryValue(value),
      confidence: 1,
      sourceMessageId: args.sourceMessageId,
      evidenceText: value,
    });
  }

  // 2/3. The model's other extracted facts — verified.
  for (const raw of args.creatorFacts ?? []) {
    const item = verifyOneFact(raw, {
      normalizedReply,
      sourceMessageId: args.sourceMessageId,
      minConfidence,
    });
    if (item) push(item);
  }

  return plan;
}

interface VerifyCtx {
  normalizedReply: string;
  sourceMessageId?: string | undefined;
  minConfidence: number;
}

/** Verify a single extracted fact and turn it into a plan item, or drop it (null). */
function verifyOneFact(
  raw: ExtractedFact | undefined,
  ctx: VerifyCtx,
): MemoryWritePlanItem | null {
  if (!raw || typeof raw.value !== "string" || typeof raw.key !== "string") return null;
  if (!isMemoryFactKey(raw.key)) return null;
  const key: MemoryFactKey = raw.key;
  // REQUESTED_RATE is owned by the validated ask (above) — ignore the model's.
  if (key === "REQUESTED_RATE") return null;

  // Provenance is required — a fact with no source message cannot be traced.
  if (!ctx.sourceMessageId) return null;

  const value = raw.value.trim();
  if (!value) return null;

  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? raw.confidence
      : 0;
  if (confidence < ctx.minConfidence) return null; // drop low-confidence guesses

  // Evidence check (Calvin review #3): the model MUST supply a verbatim phrase from
  // the reply, and that phrase must actually appear in the normalized reply.
  const evidence = typeof raw.evidenceText === "string" ? raw.evidenceText.trim() : "";
  if (!evidence) return null;
  const normalizedEvidence = normalizeMemoryValue(evidence);
  if (!normalizedEvidence || !ctx.normalizedReply.includes(normalizedEvidence)) {
    return null; // unsupported by the actual reply — drop
  }

  // Deterministic structured checks.
  if (!passesStructuredCheck(key, value, evidence)) return null;

  const numeric = isNumericMemoryKey(key);
  const valueNumber = numeric ? parseRate(value) : null;
  // A numeric key whose value carries no single, unambiguous number is not grounded
  // (a range or compound figure is rejected rather than silently coerced).
  if (numeric && valueNumber === null) return null;

  const matchValue = normalizeMemoryValue(value);
  if (!matchValue) return null;

  return {
    key,
    value,
    valueNumber,
    normalizedValue: memoryDedupKey(key, matchValue),
    matchValue,
    confidence,
    sourceMessageId: ctx.sourceMessageId,
    evidenceText: evidence,
    ...(raw.category ? { category: raw.category } : {}),
  };
}

/**
 * Deterministic per-key grounding (Calvin review #3, hardened per founder review).
 * Runs AFTER the generic evidence check, so `evidence` is already known to appear
 * in the reply.
 *   MINIMUM_RATE     — the number in the stored value MUST equal the number in the
 *                      evidence. A model that stored $800 with evidence "the lowest
 *                      I can do is $500" is rejected — value and evidence must agree,
 *                      not merely both contain a number.
 *   MANAGER_CONTACT  — if the stored value is an email, it must exactly match an
 *                      email present in the evidence (no swapping john@ for the
 *                      sarah@ that was actually written). A name-only value must
 *                      itself appear in the evidence.
 *   MANAGER_INVOLVED — the evidence must contain explicit manager/agent wording.
 * Every other key passes (the generic evidence check already grounds it).
 */
function passesStructuredCheck(
  key: MemoryFactKey,
  value: string,
  evidence: string,
): boolean {
  switch (key) {
    case "MINIMUM_RATE": {
      // The stored value must parse to a single unambiguous number...
      const valueRate = parseRate(value);
      if (valueRate === null) return false;
      // ...and that number must be the one the creator actually wrote. We look for
      // it among the numbers present in the evidence, so "$500" in the reply cannot
      // ground a stored value of $800.
      return evidenceRates(evidence).includes(valueRate);
    }
    case "MANAGER_CONTACT": {
      const valueEmail = extractEmail(value);
      if (valueEmail) {
        // An email value must be the same email the evidence contains — case-
        // insensitively, since email locals/domains are compared case-folded here.
        return extractEmails(evidence).some(
          (e) => e.toLowerCase() === valueEmail.toLowerCase(),
        );
      }
      // Name-only contact: the recorded value must appear in the evidence.
      return normalizeMemoryValue(evidence).includes(normalizeMemoryValue(value));
    }
    case "MANAGER_INVOLVED":
      return MANAGER_WORDING.test(evidence);
    default:
      return true;
  }
}

const MANAGER_WORDING = /\b(manager|agent|agency|management|represent(?:s|ed|ative)?|my team)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const EMAIL_RE_G = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

function extractEmail(text: string): string | null {
  const m = text.match(EMAIL_RE);
  return m ? m[0] : null;
}

function extractEmails(text: string): string[] {
  return text.match(EMAIL_RE_G) ?? [];
}

// A rate token: digits with optional thousands separators and a decimal, an optional
// k/K multiplier, and a trailing "%" captured so a percentage can be told apart from a
// flat rate. Currency symbols and words around it are ignored — we match only the
// numeric core, so a range ("$500-$700") or compound figure ("$500 per video + 10%")
// surfaces as MULTIPLE tokens.
const RATE_TOKEN_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([kK])?(%)?/g;

/**
 * Every flat-rate number in a string, in order. A token with a trailing "%" is a
 * percentage, not a flat rate, and is skipped — so "$500 + 10%" yields [500]. "1k" →
 * 1000, "1.5k" → 1500, "1,500" → 1500.
 */
function extractRates(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(RATE_TOKEN_RE)) {
    if (m[4]) continue; // trailing % — a percentage, not a flat rate
    const intPart = m[1]!.replace(/,/g, "");
    const frac = m[2] ? `.${m[2]}` : "";
    const mult = m[3] ? 1000 : 1;
    const n = Number(intPart + frac) * mult;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Parse a single unambiguous flat rate from a STORED VALUE, or null.
 *
 * Handles: plain "$500", "1500", "1,500", "1k" → 1000, "1.5k" → 1500, "€500" → 500.
 * REJECTS (returns null) anything ambiguous — a range ("$500–$700"), a compound
 * figure ("$500 per video + 10%"), a bare percentage ("10%"), or empty — because
 * guessing a minimum rate wrong is worse than dropping the fact.
 *
 * Ambiguity for a stored value is stricter than for evidence: a percent sign ANYWHERE
 * makes the value compound ("$500 + 10%" is not a flat rate), so we reject outright.
 * The value must then resolve to exactly one flat-rate number.
 */
function parseRate(value: string): number | null {
  if (value.includes("%")) return null; // any percent ⇒ compound/ambiguous value
  const nums = extractRates(value);
  return nums.length === 1 ? nums[0]! : null;
}

/** The flat-rate numbers mentioned in evidence text (may be empty or many). */
function evidenceRates(evidence: string): number[] {
  // Evidence may legitimately contain several numbers; we don't reject on count —
  // the stored value must simply be one of them.
  return extractRates(evidence);
}

// ---------------------------------------------------------------------------
// Read payload — the sanitized DATA block threaded into /negotiate + /draft
// ---------------------------------------------------------------------------

/**
 * Turn the LIVE head rows the context-builder loaded into the read payload PLU-81's
 * CreatorMemoryPayload declares. PURE. requestedRate / minimumRate are CONTEXT (what
 * the creator said they want), NOT the offer figure — the agent block labels them
 * so. For a CONFLICTED singleton, the current value is used and the conflict pair
 * (prior value) surfaces in `conflicts` so the model sees "was X, now Y". Returns
 * null when there is nothing live — the caller omits the block so the prompt is
 * byte-identical (flag-off / empty-memory parity).
 */
export function buildCreatorMemoryBlock(
  rows: CampaignCreatorMemory[],
): CreatorMemoryPayload | null {
  const live = rows.filter((r) => r.status === "ACTIVE" || r.status === "CONFLICTED");
  if (live.length === 0) return null;

  const payload: CreatorMemoryPayload = {
    logisticsConstraints: [],
    objections: [],
    deliverablePreferences: [],
    compensationPreferences: [],
    conflicts: [],
  };

  for (const r of live) {
    switch (r.key as MemoryFactKey) {
      case "REQUESTED_RATE":
        if (r.valueNumber !== null) payload.requestedRate = r.valueNumber;
        break;
      case "MINIMUM_RATE":
        if (r.valueNumber !== null) payload.minimumRate = r.valueNumber;
        break;
      case "AVAILABILITY":
        payload.availability = r.value;
        break;
      case "LOGISTICS_CONSTRAINT":
        payload.logisticsConstraints.push(r.value);
        break;
      case "OBJECTION":
        payload.objections.push(r.value);
        break;
      case "DELIVERABLE_PREFERENCE":
        payload.deliverablePreferences.push(r.value);
        break;
      case "COMPENSATION_PREFERENCE":
        payload.compensationPreferences.push(r.value);
        break;
      case "MANAGER_INVOLVED":
        payload.managerInvolved = parseBoolish(r.value);
        break;
      case "MANAGER_CONTACT":
        payload.managerContact = r.value;
        break;
    }
    if (r.status === "CONFLICTED" && r.conflictValue) {
      payload.conflicts.push({
        field: r.key,
        priorValue: r.conflictValue,
        newValue: r.value,
        source: "creator",
      });
    }
  }

  return payload;
}

function parseBoolish(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1";
}
