// ---------------------------------------------------------------------------
// PLU-172 — S8.C1 deliverable-negotiation private-policy storage shape
// ---------------------------------------------------------------------------
// "Deliverable mode: KEEP_REQUESTED / ASK_FOR_APPROVAL / ALLOW_SELECTED_CHANGES,
// with explicit quantity and format permissions" — this module is the
// storage shape for the "explicit permissions" half; the mode enum itself
// lives on NegotiationPolicy.deliverableNegotiationMode (schema.ts).
//
// Reuses the SAME closed platform/format catalog every other deliverable
// shape in this codebase uses (deliverablesValidator.ts) — an
// allowFormatChangeTo entry is validated against PLATFORM_FORMAT_MATRIX the
// identical way ADD/REPLACE_FORMAT deltas are (deliverablesValidator.ts's
// deliverableDeltaSchema), so TIKTOK+REEL is rejected here for the same
// reason it's rejected everywhere else.

import { z } from "zod";
import {
  DELIVERABLE_FORMATS,
  DELIVERABLE_PLATFORMS,
  PLATFORM_FORMAT_MATRIX,
} from "./deliverablesValidator.js";
import type { DeliverableFormat, DeliverablePlatform } from "./deliverables.js";

const formatOptionSchema = z
  .object({
    platform: z.enum(DELIVERABLE_PLATFORMS as [DeliverablePlatform, ...DeliverablePlatform[]]),
    format: z.enum(DELIVERABLE_FORMATS as [DeliverableFormat, ...DeliverableFormat[]]),
  })
  .strict()
  .refine((f) => PLATFORM_FORMAT_MATRIX[f.platform].includes(f.format), {
    message: "invalid platform/format combination",
    path: ["format"],
  });

// One rule = "for this deliverable (or 'any'), these operations are
// pre-authorized, within these bounds." Explicit quantity/format
// permissions per the ticket's own wording. An empty array under
// ALLOW_SELECTED_CHANGES means no rule authorizes anything (fails closed —
// never "everything is allowed" by default).
export const deliverablePolicyRuleSchema = z
  .object({
    // "any" = applies to every item in the requested package; otherwise a
    // specific deliverable id from the pinned package. Validated for FORMAT
    // (a non-empty string) here — cross-checking that the id actually
    // exists in a specific campaign's package is a read-time concern for
    // whichever caller has that package in hand, not this schema's job.
    appliesTo: z.union([z.literal("any"), z.string().min(1)]),
    allowQuantityDecreaseTo: z.number().int().positive().optional(),
    allowFormatChangeTo: z.array(formatOptionSchema).optional(),
  })
  .strict();

export const deliverablePolicyRulesSchema = z.array(deliverablePolicyRuleSchema);
export type DeliverablePolicyRule = z.infer<typeof deliverablePolicyRuleSchema>;

export type DeliverablePolicyRulesValidationResult =
  | { ok: true; rules: DeliverablePolicyRule[] }
  | { ok: false; error: string };

export function validateDeliverablePolicyRules(value: unknown): DeliverablePolicyRulesValidationResult {
  const result = deliverablePolicyRulesSchema.safeParse(value);
  if (result.success) return { ok: true, rules: result.data };
  return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
}
