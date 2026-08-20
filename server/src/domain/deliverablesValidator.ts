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
