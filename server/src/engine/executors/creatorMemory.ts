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
  const valueNumber = numeric ? coerceNumber(value) : null;
  // A numeric key whose value carries no parseable number is not grounded.
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
 * Deterministic per-key grounding (Calvin review #3). Runs AFTER the generic
 * evidence check, so `evidence` is already known to appear in the reply.
 *   MINIMUM_RATE     — must carry a parseable number (numeric grounding).
 *   MANAGER_CONTACT  — the value must reference a name or email present in the
 *                      evidence (not an invented contact).
 *   MANAGER_INVOLVED — the evidence must contain explicit manager/agent wording.
 * Every other key passes (the generic evidence check already grounds it).
 */
function passesStructuredCheck(
  key: MemoryFactKey,
  value: string,
  evidence: string,
): boolean {
  switch (key) {
    case "MINIMUM_RATE":
      return coerceNumber(value) !== null;
    case "MANAGER_CONTACT": {
      const email = extractEmail(evidence);
      if (email) return true;
      // Otherwise the recorded contact value must appear (name grounded in the reply).
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

function extractEmail(text: string): string | null {
  const m = text.match(EMAIL_RE);
  return m ? m[0] : null;
}

function coerceNumber(value: string): number | null {
  const digits = value.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
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
