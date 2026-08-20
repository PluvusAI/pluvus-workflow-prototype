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

export const deliverableSchema = z
  .object({
    id: z.string().min(1),
    platform: z.enum(DELIVERABLE_PLATFORMS as [DeliverablePlatform, ...DeliverablePlatform[]]),
    format: z.enum(DELIVERABLE_FORMATS as [DeliverableFormat, ...DeliverableFormat[]]),
    quantity: z.number().int().positive(),
    requirements: requirementsSchema.nullable().optional(),
    customLabel: z.string().min(1).nullable().optional(),
    notes: z.string().nullable().optional(),
  })
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
