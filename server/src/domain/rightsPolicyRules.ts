// ---------------------------------------------------------------------------
// PLU-172 — S8.C3 rights-family private-policy storage shape
// ---------------------------------------------------------------------------
// One rule schema shared by every DURATION-bearing rights-family term
// (usage rights, exclusivity, ad authorization, post retention,
// content-repurpose rights) rather than a separate mode+minimum column pair
// per term — the ticket's own list is closed to exactly these fields ("Do
// not add territory, channel, derivative-editing, or other legal-rights
// controls that the worksheet explicitly leaves outside the first
// prototype").
//
// Calvin review: script submission (S8.C5) does NOT share this shape.
// ALLOW_TO_MINIMUM has no meaning for a boolean-ish "require the script or
// not" term — there is no duration to shrink toward a minimum. It gets its
// own dedicated, non-duration mode (scriptWaiverModeSchema, below) and its
// own NegotiationPolicy column (scriptWaiverMode), not a rightsPolicyRules
// entry.

import { z } from "zod";

// PLU-172: kept as a literal list here (not imported from
// compensationShape.ts) to avoid a dependency cycle between these two small
// domain modules — domain/compensationShape.test.ts asserts the two lists
// (this one and compensationShape.ts's RIGHTS_TERM_KEYS) stay identical, so
// a divergence is a test failure, not a silent drift.
export const RIGHTS_TERMS = [
  "usageRights",
  "exclusivity",
  "adAuthorization",
  "postRetention",
  "contentRepurposeRights",
] as const;
export type RightsTerm = (typeof RIGHTS_TERMS)[number];

export const RIGHTS_NEGOTIATION_MODES = ["KEEP_REQUESTED", "ALLOW_TO_MINIMUM", "ASK_FOR_APPROVAL"] as const;
export type RightsNegotiationModeValue = (typeof RIGHTS_NEGOTIATION_MODES)[number];

export const DURATION_UNITS = ["DAYS", "LIFETIME", "COUNT"] as const;
export type DurationUnitValue = (typeof DURATION_UNITS)[number];

export const rightsPolicyRuleSchema = z
  .object({
    term: z.enum(RIGHTS_TERMS as unknown as [RightsTerm, ...RightsTerm[]]),
    mode: z.enum(RIGHTS_NEGOTIATION_MODES as unknown as [RightsNegotiationModeValue, ...RightsNegotiationModeValue[]]),
    // Only meaningful when mode = ALLOW_TO_MINIMUM. Duration semantics MATCH
    // the public term's own (a free-text duration today) — stored as a
    // value+unit pair rather than free text so a future evaluator can
    // compare it numerically instead of re-parsing prose.
    minimumValue: z.number().nonnegative().optional(),
    minimumUnit: z.enum(DURATION_UNITS as unknown as [DurationUnitValue, ...DurationUnitValue[]]).optional(),
  })
  .strict()
  // Review fix: a minimumValue with no minimumUnit is semantically
  // incomplete — 30 WHAT? days, a lifetime, a count? The original refine
  // only required minimumValue, so { mode: "ALLOW_TO_MINIMUM",
  // minimumValue: 30 } validated and could reach an immutable launch
  // snapshot with no way to interpret the number. Both fields are now
  // required together, with distinct error messages/paths so a caller
  // knows exactly which one is missing.
  .refine((r) => r.mode !== "ALLOW_TO_MINIMUM" || r.minimumValue !== undefined, {
    message: "minimumValue is required when mode is ALLOW_TO_MINIMUM",
    path: ["minimumValue"],
  })
  .refine((r) => r.mode !== "ALLOW_TO_MINIMUM" || r.minimumUnit !== undefined, {
    message: "minimumUnit is required when mode is ALLOW_TO_MINIMUM",
    path: ["minimumUnit"],
  });

export const rightsPolicyRulesSchema = z
  .array(rightsPolicyRuleSchema)
  .refine((rules) => new Set(rules.map((r) => r.term)).size === rules.length, {
    message: "each rights term may appear at most once",
  });

export type RightsPolicyRule = z.infer<typeof rightsPolicyRuleSchema>;

export type RightsPolicyRulesValidationResult =
  | { ok: true; rules: RightsPolicyRule[] }
  | { ok: false; error: string };

export function validateRightsPolicyRules(value: unknown): RightsPolicyRulesValidationResult {
  const result = rightsPolicyRulesSchema.safeParse(value);
  if (result.success) return { ok: true, rules: result.data };
  return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
}

/**
 * PLU-172: absence is conservative. A RightsTerm with NO entry in the rule
 * array (including an empty array, or the column being null/absent) reads
 * as mode = "KEEP_REQUESTED" for that term — never as "unrestricted." Every
 * reader of rightsPolicyRules MUST resolve a term through this function
 * rather than indexing the array directly, so the conservative-absence rule
 * can never be silently skipped by a new call site.
 */
export function resolveRightsMode(
  rules: readonly Pick<RightsPolicyRule, "term" | "mode">[],
  term: RightsTerm,
): RightsNegotiationModeValue {
  return rules.find((r) => r.term === term)?.mode ?? "KEEP_REQUESTED";
}

// ---------------------------------------------------------------------------
// Script submission waiver (S8.C5) — its own shape, not part of the rule
// array above (see this file's own header comment for why).
// ---------------------------------------------------------------------------

export const SCRIPT_WAIVER_MODES = ["KEEP_SUBMISSION_REQUIRED", "ALLOW_WAIVER", "ASK_FOR_APPROVAL"] as const;
export type ScriptWaiverModeValue = (typeof SCRIPT_WAIVER_MODES)[number];

export function isScriptWaiverMode(v: unknown): v is ScriptWaiverModeValue {
  return typeof v === "string" && (SCRIPT_WAIVER_MODES as readonly string[]).includes(v);
}
