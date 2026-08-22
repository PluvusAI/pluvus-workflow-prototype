// ---------------------------------------------------------------------------
// PLU-169 (1f) — the ONE place platform/format rules live
// ---------------------------------------------------------------------------
// zod, following the existing precedent (routes/attributionLogic.ts) — the
// first platform/format validator in this codebase. Reused at three points
// (PLU-169 doc, "Validator design"): the campaigns.ts PATCH route (replacing
// today's bare "is an array" check), buildFinalAgreementInput (defense in
// depth), and — once it exists — the negotiation-delta apply step (a
// separate, future ticket per decision #5).
//
// Adding a new platform/format later is ONE entry in PLATFORM_FORMAT_MATRIX —
// no negotiation-logic change required.

import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import type { Deliverable, DeliverableFormat, DeliverablePlatform } from "./deliverables.js";
import { canonicalJsonKey } from "./jsonCanonicalize.js";

export const DELIVERABLE_PLATFORMS: readonly DeliverablePlatform[] = [
  "instagram",
  "tiktok",
  "youtube",
  "linkedin",
  "twitter",
  "other",
];

export const DELIVERABLE_FORMATS: readonly DeliverableFormat[] = [
  "reel",
  "story",
  "carousel",
  "video",
  "dedicated",
  "integrated",
  "post",
  "other",
];

// PLU-169 decision #8: "other" pairs ONLY with platform "other" — a fully
// custom, platform-less slot. Every other pairing here mirrors the 8 existing
// DELIVERABLE_CARDS (sections.ts) exactly, so no already-saved row can fail
// this validator on rollout.
export const PLATFORM_FORMAT_MATRIX: Record<DeliverablePlatform, readonly DeliverableFormat[]> = {
  instagram: ["reel", "carousel", "story"],
  tiktok: ["video"],
  youtube: ["dedicated", "integrated"],
  linkedin: ["post", "video"],
  twitter: ["post"],
  other: ["other"],
};

const requirementsSchema = z
  .object({
    durationSeconds: z
      .object({
        min: z.number().nonnegative().optional(),
        max: z.number().nonnegative().optional(),
      })
      .optional(),
  })
  .strict();

// The raw (un-refined) object shape — kept separate from deliverableSchema
// (below) so PLU-172's ADD-delta variant can build its own, differently-
// shaped version (an optional `id`) via `.omit()`/`.extend()`. Zod's `.omit`
// only exists on a plain ZodObject, not on the ZodEffects a `.refine()` call
// produces — reusing deliverableSchema itself for that would require
// stripping refinements back off, which isn't possible either.
const deliverableObjectSchema = z.object({
  id: z.string().min(1),
  platform: z.enum(DELIVERABLE_PLATFORMS as [DeliverablePlatform, ...DeliverablePlatform[]]),
  format: z.enum(DELIVERABLE_FORMATS as [DeliverableFormat, ...DeliverableFormat[]]),
  quantity: z.number().int().positive(),
  requirements: requirementsSchema.nullable().optional(),
  customLabel: z.string().min(1).nullable().optional(),
  notes: z.string().nullable().optional(),
});

// The two invariants every deliverable-shaped object must satisfy — applied
// here AND, identically, to the ADD-delta's newDeliverableSchema further
// down, so an ADD can't smuggle in an otherwise-invalid deliverable through
// a looser check. Deliberately NOT factored into a shared generic helper:
// `.refine()` on a generically-typed zod schema (`T extends ZodType<Base>`)
// collapses the INFERRED shape back down to the generic's own constraint
// type, silently dropping sibling properties (like `id`) from what
// TypeScript thinks the schema produces — tried and reverted here, see git
// history. A few duplicated lines beat zod type inference that lies.

export const deliverableSchema = deliverableObjectSchema
  .strict()
  .refine((d) => PLATFORM_FORMAT_MATRIX[d.platform].includes(d.format), {
    message: "invalid platform/format combination",
    path: ["format"],
  })
  .refine((d) => d.platform !== "other" || Boolean(d.customLabel && d.customLabel.trim().length > 0), {
    message: 'customLabel is required when platform is "other"',
    path: ["customLabel"],
  });

export const deliverablesSchema = z
  .array(deliverableSchema)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
    message: "deliverable ids must be unique",
  });

export type DeliverablesValidationResult =
  | { ok: true; deliverables: Deliverable[] }
  | { ok: false; error: string };

/** Thin, typed wrapper so call sites don't need to know zod's result shape. */
export function validateDeliverables(value: unknown): DeliverablesValidationResult {
  const result = deliverablesSchema.safeParse(value);
  if (result.success) {
    return { ok: true, deliverables: result.data as Deliverable[] };
  }
  return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
}

// ---------------------------------------------------------------------------
// PLU-172 — the frozen negotiation-delta contract
// ---------------------------------------------------------------------------
// "Freeze a typed DeliverableDelta[] inside CounterDelta rather than asking
// the model to return a complete replacement package for every reply." This
// is the delta shape itself (PolicyDecision/CounterDelta, which WRAP this,
// live in domain/policyDecision.ts). Reuses DeliverablePlatform/
// DeliverableFormat/PLATFORM_FORMAT_MATRIX verbatim — an ADD or
// REPLACE_FORMAT delta is validated against the EXACT same matrix a
// requested/final package already uses.
//
// Types only — no apply/evaluation logic lives here. The apply-step rules
// this schema alone cannot enforce (an id must exist in the PINNED package,
// two deltas can't target the same id, an ADD can't reuse an existing id)
// are frozen as a contract for that future apply step
// (docs/plu-172-private-policy-contract-plan.md §5.3), since this schema has
// no view of any specific campaign's package to check against.

export const DELIVERABLE_DELTA_OPERATIONS = ["SET_QUANTITY", "REPLACE_FORMAT", "ADD", "REMOVE"] as const;
export type DeliverableDeltaOperation = (typeof DELIVERABLE_DELTA_OPERATIONS)[number];

// How confidently a delta was normalized from raw model/creator text BEFORE
// it reaches this schema. Regex/alias normalization (IG -> instagram)
// happens upstream; this field records whether that normalization was
// exact, required an alias-table lookup, or is uncertain enough that a
// human/agent should treat the proposal as ambiguous rather than
// authoritative. Distinct from PolicyDecision's outcome — this is about
// whether the PROPOSAL was understood; PolicyDecision is about whether it's
// ALLOWED.
export const DELTA_NORMALIZATION_STATES = ["EXACT", "ALIASED", "AMBIGUOUS"] as const;
export type DeltaNormalizationState = (typeof DELTA_NORMALIZATION_STATES)[number];

const deltaBase = z.object({
  normalization: z.enum(DELTA_NORMALIZATION_STATES),
  /** Verbatim source text this delta was derived from, for audit — same
   *  evidence-text discipline as the negotiation adapter's ExtractedFact.
   *  Never authoritative on its own. */
  sourceText: z.string().optional(),
});

// The ADD variant's embedded new deliverable — same shape/invariants as
// deliverableSchema, but id is OPTIONAL (minted if absent, same convention
// as normalizeLegacyDeliverables). Built from the raw object schema (not
// deliverableSchema itself — see that const's own comment on why) so
// `.omit` is available, then given the SAME two invariant refinements
// deliverableSchema has above so an ADD can't smuggle in an otherwise-
// invalid deliverable through a looser check.
const newDeliverableSchema = deliverableObjectSchema
  .omit({ id: true })
  .extend({ id: z.string().min(1).optional() })
  .strict()
  .refine((d) => PLATFORM_FORMAT_MATRIX[d.platform].includes(d.format), {
    message: "invalid platform/format combination",
    path: ["format"],
  })
  .refine((d) => d.platform !== "other" || Boolean(d.customLabel && d.customLabel.trim().length > 0), {
    message: 'customLabel is required when platform is "other"',
    path: ["customLabel"],
  });

// discriminatedUnion requires every variant to be a plain ZodObject (not a
// ZodEffects) — so the REPLACE_FORMAT platform/format-matrix check can't be
// a `.refine()` on that one variant directly (that was tried and rejected;
// see git history if resurrecting this pattern). It's applied instead as a
// `.superRefine()` on the whole union below, which any variant can run
// operation-conditional logic in without breaking discriminatedUnion's
// variant-type requirement.
const deliverableDeltaUnion = z.discriminatedUnion("operation", [
  deltaBase
    .extend({
      operation: z.literal("SET_QUANTITY"),
      sourceDeliverableId: z.string().min(1),
      quantity: z.number().int().positive(),
    })
    .strict(),
  deltaBase
    .extend({
      operation: z.literal("REPLACE_FORMAT"),
      sourceDeliverableId: z.string().min(1),
      platform: z.enum(DELIVERABLE_PLATFORMS as [DeliverablePlatform, ...DeliverablePlatform[]]),
      format: z.enum(DELIVERABLE_FORMATS as [DeliverableFormat, ...DeliverableFormat[]]),
    })
    .strict(),
  deltaBase
    .extend({
      operation: z.literal("ADD"),
      // A caller-supplied id colliding with an existing package item is an
      // apply-step concern (§5.3), not something this schema (with no view
      // of any package) can check.
      deliverable: newDeliverableSchema,
    })
    .strict(),
  deltaBase
    .extend({
      operation: z.literal("REMOVE"),
      sourceDeliverableId: z.string().min(1),
    })
    .strict(),
]);

export const deliverableDeltaSchema = deliverableDeltaUnion.superRefine((d, ctx) => {
  if (d.operation === "REPLACE_FORMAT" && !PLATFORM_FORMAT_MATRIX[d.platform].includes(d.format)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid platform/format combination",
      path: ["format"],
    });
  }
});

export type DeliverableDelta = z.infer<typeof deliverableDeltaSchema>;
export const deliverableDeltasSchema = z.array(deliverableDeltaSchema);

export type DeliverableDeltaValidationResult =
  | { ok: true; deltas: DeliverableDelta[] }
  | { ok: false; error: string };

export function validateDeliverableDeltas(value: unknown): DeliverableDeltaValidationResult {
  const result = deliverableDeltasSchema.safeParse(value);
  if (result.success) return { ok: true, deltas: result.data };
  return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
}

// ---------------------------------------------------------------------------
// Legacy migration — shared by every call site that must accept a
// pre-current-schema row without rejecting it.
// ---------------------------------------------------------------------------
// deliverableSchema requires `id: string().min(1)`, but a campaign's
// `CampaignDetails.deliverableQuantities` can still hold rows created before
// that requirement existed — the one-time backfill script
// (deliverables:backfill-ids) fixes these in bulk, but nothing guarantees it
// has run for every campaign at any given moment a call site here validates.
// Review fix: an already-launched, IMMUTABLE CampaignTermsSnapshot can never
// be reached by that script at all (see resolveFinalDeliverables' own doc
// comment), and the campaigns.ts PATCH route was rejecting an otherwise
// unrelated edit to a legacy, NOT-YET-BACKFILLED campaign with a 400 (the
// intake resends the complete deliverableQuantities array on every group
// PATCH, so a stale row surfaces the error on any save). Migrate every item
// into current-schema shape BEFORE validation runs, so a call site can both
// (a) accept the row instead of 400ing on it, and (b) — if it persists the
// RETURNED, now-normalized array back to storage, as campaigns.ts's PATCH
// route does — incrementally self-heal a campaign's legacy rows the first
// time anyone happens to save it, without waiting on the separate backfill
// script. Non-object items pass through untouched so the shared validator
// produces the real error for them.
//
// Review fix (round 2): id was the ONLY thing the original version of this
// function fixed — a legacy row with a free-form/unsupported platform or
// format string, a platform/format pairing not in PLATFORM_FORMAT_MATRIX, or
// a missing/zero/negative quantity still failed `deliverablesSchema` even
// after normalization, 400ing the SAME "unrelated edit to an old campaign"
// case this function exists to fix, just via a different validation rule.
// Two migrations now run alongside the id mint:
//   - platform/format: an unrecognized platform, unrecognized format, or a
//     combination not in PLATFORM_FORMAT_MATRIX is rebucketed into the
//     flexible platform:"other"/format:"other" slot (already a supported,
//     validator-approved escape hatch for exactly this "doesn't fit the
//     closed catalog" case), with a customLabel synthesized from the
//     original platform/format text so the content survives instead of
//     being silently discarded. A row already using "other"/"other" is left
//     alone — its combination is already valid, so its existing customLabel
//     is never touched.
//   - quantity: missing, non-numeric, zero, negative, or non-integer
//     collapses to 1 (the row's existence is real signal even when its
//     exact historical count wasn't recorded validly) rather than blocking
//     the whole save.
// Both migrations are idempotent — re-running against an already-valid item
// is a no-op — and, like the id mint, are opportunistic: they don't require
// knowing what changed in this save vs. a prior one, just that the RESULT is
// schema-valid.
//
// `legacyKeyToId` is also returned so a caller that has a companion
// structure keyed by the SAME legacy "<platform>:<format>" composite
// (campaigns.ts's `deliverablePricing`, S7.P1 — see PricingGrid's own
// `keyOf` fallback) can remap it onto the freshly minted id in the SAME
// save. Without that, minting a new id here while leaving the companion
// structure keyed by the old composite orphans its value: the UI looks the
// row's price up by its (now current) id, finds nothing, shows blank, and a
// subsequent edit writes a fresh entry under the new id while the old one
// sits unreachable forever.
export interface NormalizeLegacyDeliverablesResult {
  items: unknown;
  /** Old "<platform>:<format>" composite key -> newly minted id, one entry
   *  per item that was missing an id. Keyed by the ORIGINAL platform/format
   *  (before any other-bucketing migration below), matching whatever
   *  `deliverablePricing` actually has stored. Empty when nothing was
   *  legacy (the common case for anything created after this ticket
   *  shipped). When two legacy items happen to share the same
   *  platform+format (already an ambiguous state under the old
   *  composite-keyed pricing scheme — its one price could only ever have
   *  described one of them), only the FIRST is mapped; this doesn't
   *  regress anything, since that ambiguity predates this function. */
  legacyKeyToId: Map<string, string>;
}

function isKnownPlatform(v: unknown): v is DeliverablePlatform {
  return typeof v === "string" && (DELIVERABLE_PLATFORMS as readonly string[]).includes(v);
}

function isKnownFormat(v: unknown): v is DeliverableFormat {
  return typeof v === "string" && (DELIVERABLE_FORMATS as readonly string[]).includes(v);
}

/** Migrate a legacy platform/format into current-schema shape, preserving
 *  the original values as a customLabel when they don't fit the closed
 *  catalog. Returns `null` when the pair is ALREADY valid (caller leaves
 *  platform/format/customLabel untouched in that case). */
function migrateLegacyPlatformFormat(
  platform: unknown,
  format: unknown,
): { platform: "other"; format: "other"; customLabel: string } | null {
  const validCombo =
    isKnownPlatform(platform) &&
    isKnownFormat(format) &&
    (PLATFORM_FORMAT_MATRIX[platform] as readonly string[]).includes(format);
  if (validCombo) return null;
  const originalPlatform = typeof platform === "string" ? platform.trim() : "";
  const originalFormat = typeof format === "string" ? format.trim() : "";
  const label = [originalPlatform, originalFormat].filter((s) => s.length > 0).join(" ");
  return { platform: "other", format: "other", customLabel: label.length > 0 ? label : "Legacy deliverable" };
}

/** Migrate a legacy quantity into current-schema shape: a missing, non-
 *  numeric, zero, negative, or non-integer value collapses to 1. */
function migrateLegacyQuantity(quantity: unknown): number {
  if (typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0) return quantity;
  if (typeof quantity === "string" && quantity.trim() !== "") {
    const parsed = Number.parseInt(quantity, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  if (typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0) {
    return Math.max(1, Math.round(quantity));
  }
  return 1;
}

export function normalizeLegacyDeliverables(value: unknown): NormalizeLegacyDeliverablesResult {
  if (!Array.isArray(value)) return { items: value, legacyKeyToId: new Map() };
  const legacyKeyToId = new Map<string, string>();
  const items = value.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const r = item as Record<string, unknown>;

    const hasId = typeof r["id"] === "string" && r["id"].length > 0;
    const id = hasId ? (r["id"] as string) : createId();
    if (!hasId && typeof r["platform"] === "string" && typeof r["format"] === "string") {
      const key = `${r["platform"]}:${r["format"]}`;
      if (!legacyKeyToId.has(key)) legacyKeyToId.set(key, id);
    }

    const platformFormatMigration = migrateLegacyPlatformFormat(r["platform"], r["format"]);
    const quantity = migrateLegacyQuantity(r["quantity"]);

    return {
      ...r,
      id,
      quantity,
      ...(platformFormatMigration ?? {}),
    };
  });
  return { items, legacyKeyToId };
}

// Review fix: fold every `deliverablePricing` entry still keyed by a legacy
// "<platform>:<format>" composite onto the id `normalizeLegacyDeliverables`
// just minted for that same row, so the price survives the id migration
// instead of being orphaned. A value already present under the NEW id wins
// over the stale composite-keyed one (the user may have already re-priced
// that row after an id was minted on a prior save). Non-object input passes
// through untouched — the caller's own object/null validation handles that.
export function remapLegacyDeliverablePricingKeys(
  pricing: unknown,
  legacyKeyToId: Map<string, string>,
): unknown {
  if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) return pricing;
  if (legacyKeyToId.size === 0) return pricing;
  const input = pricing as Record<string, unknown>;
  const remapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!legacyKeyToId.has(key)) remapped[key] = value;
  }
  for (const [oldKey, newId] of legacyKeyToId) {
    if (Object.prototype.hasOwnProperty.call(input, oldKey) && !(newId in remapped)) {
      remapped[newId] = input[oldKey];
    }
  }
  return remapped;
}

// ---------------------------------------------------------------------------
// Review fix (round 3) — the PATCH route's single save-time entry point
// ---------------------------------------------------------------------------
// normalizeLegacyDeliverables() alone can't tell "a legacy row already
// stored for this campaign, being resent unchanged by the intake's own
// 'send the complete array on every save' convention" from "a row THIS
// save is introducing or editing right now." Calling it on every submitted
// item unconditionally (the PATCH route's original approach) let a
// genuinely fresh, malformed submission — a bare `[{}]`, or a real row with
// `quantity: 0` — get silently coerced into a fabricated valid deliverable
// (an "other"/"other" slot, or quantity forced to 1) and persisted with a
// 200 instead of rejected with a 400: a creator obligation the brand never
// actually specified, flowing into FinalAgreement/Content Brief as if real.
//
// Fix: normalize ONLY an item that is byte-for-byte identical
// (key-order-independent) to something already stored for this campaign;
// every other item is validated AS SUBMITTED, strictly, with no coercion.
// canonicalJsonKey is shared with domain/draftRevision.ts (PLU-172), which
// needs the identical key-order-independent comparison for its approval
// hash — see jsonCanonicalize.ts's own doc comment.

export type ResolveDeliverableSaveResult =
  | { ok: true; deliverables: Deliverable[]; legacyKeyToId: Map<string, string> }
  | { ok: false; error: string };

/**
 * `existing` is the campaign's CURRENTLY stored deliverableQuantities raw
 * array (before this save) — pass [] for a campaign with none yet. Each
 * existing row can satisfy at most ONE submitted item's "this is unchanged"
 * claim (a multiset match), so two genuinely fresh, identical-looking items
 * can't both hide behind a single stored row.
 */
export function resolveDeliverableSave(
  submitted: unknown[],
  existing: unknown[],
): ResolveDeliverableSaveResult {
  const existingCounts = new Map<string, number>();
  for (const item of existing) {
    const key = canonicalJsonKey(item);
    existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
  }

  const resultItems: unknown[] = [];
  const legacyKeyToId = new Map<string, string>();
  for (const item of submitted) {
    const key = canonicalJsonKey(item);
    const remaining = existingCounts.get(key) ?? 0;
    if (remaining > 0) {
      // Genuinely carried forward unchanged — safe to self-heal.
      existingCounts.set(key, remaining - 1);
      const { items: normalizedOne, legacyKeyToId: mintedOne } = normalizeLegacyDeliverables([item]);
      resultItems.push((normalizedOne as unknown[])[0]);
      for (const [k, v] of mintedOne) legacyKeyToId.set(k, v);
    } else {
      // New or edited by THIS request — no coercion; reject loudly if invalid.
      const single = deliverableSchema.safeParse(item);
      if (!single.success) {
        return { ok: false, error: single.error.issues.map((i) => i.message).join("; ") };
      }
      resultItems.push(single.data);
    }
  }

  const result = validateDeliverables(resultItems);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, deliverables: result.deliverables, legacyKeyToId };
}
