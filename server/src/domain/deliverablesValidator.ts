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
// Legacy id backfill — shared by every call site that must accept a
// pre-id-requirement row without rejecting it.
// ---------------------------------------------------------------------------
// PLU-169 (1f): deliverableSchema requires `id: string().min(1)`, but a
// campaign's `CampaignDetails.deliverableQuantities` can still hold rows
// created before that requirement existed — the one-time backfill script
// (deliverables:backfill-ids) fixes these in bulk, but nothing guarantees it
// has run for every campaign at any given moment a call site here validates.
// Review fix: an already-launched, IMMUTABLE CampaignTermsSnapshot can never
// be reached by that script at all (see resolveFinalDeliverables' own doc
// comment), and the campaigns.ts PATCH route was rejecting an otherwise
// unrelated edit to a legacy, NOT-YET-BACKFILLED campaign with a 400 (the
// intake resends the complete deliverableQuantities array on every group
// PATCH, so a stale id-less row surfaces the error on any save). Mint a
// fresh id for any item missing one, BEFORE validation runs, so a call site
// can both (a) accept the row instead of 400ing on it, and (b) — if it
// persists the RETURNED, now-normalized array back to storage, as
// campaigns.ts's PATCH route does — incrementally self-heal a campaign's
// legacy rows the first time anyone happens to save it, without waiting on
// the separate backfill script. Non-object items pass through untouched so
// the shared validator produces the real error for them.
export function normalizeLegacyDeliverableIds(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const r = item as Record<string, unknown>;
    if (typeof r["id"] === "string" && r["id"].length > 0) return r;
    return { ...r, id: createId() };
  });
}
