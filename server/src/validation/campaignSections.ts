// ---------------------------------------------------------------------------
// PLU-139 — validation + normalization for the sectioned campaign Draft intake.
// ---------------------------------------------------------------------------
// Turns the three untrusted nested request groups (details / brandIdentity /
// creatorRequirement) into typed insert patches, rejecting bad enums, negative
// ints, and non-string-array lists at the trust boundary. Returns a discriminated
// { valid: true, value } | { valid: false, error } like the sibling
// campaignSendingSettings validator, so the route stays thin.

import type {
  BrandIdentityInsert,
  CampaignDetailsInsert,
  CompensationStructure,
  CreatorRequirementInsert,
  PriceStrategy,
} from "../db/schema.js";

export type SectionValidation<T> =
  | { valid: true; value: Partial<T> }
  | { valid: false; error: string };

const COMPENSATION_STRUCTURES: readonly CompensationStructure[] = [
  "PAID",
  "GIFTING",
  "AFFILIATE",
  "HYBRID",
];
const PRICE_STRATEGIES: readonly PriceStrategy[] = [
  "REQUEST_RATE_CARD",
  "PROPOSE_STARTING_AMOUNT",
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A jsonb string[] column: must be an array of strings when present. */
function stringArray(
  value: unknown,
  field: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  return { ok: true, value };
}

/** A non-negative integer column (fees are cents, rates are percent, days ≥ 0). */
function nonNegInt(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative integer` };
  }
  return { ok: true, value };
}

function optString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

/**
 * Assign a nullable string column: present-and-string → trimmed-or-null; present-
 * and-null → null; absent → untouched (so a PATCH only writes what it names).
 */
function assignString(
  body: Record<string, unknown>,
  key: string,
  out: Record<string, unknown>,
): void {
  if (key in body) out[key] = optString(body[key]);
}

// ---------------------------------------------------------------------------
// CampaignDetails
// ---------------------------------------------------------------------------

const DETAILS_STRING_KEYS = [
  "feeCurrency",
  "giftDescription",
  "giftAccessMethod",
  "commissionMode",
  "commissionDurationKind",
  "publicPaymentTerms",
  "objective",
  "summary",
  "usageRights",
  "exclusivity",
  "postDeadline",
] as const;
const DETAILS_INT_KEYS = [
  "proposedFeeCents",
  "commissionRate",
  "commissionDurationValue",
  "attributionWindowDays",
  "usageRightsDurationDays",
  "exclusivityDurationDays",
  "adAuthorizationDays",
  "postRetentionDays",
  "contentRepurposeDays",
] as const;
const DETAILS_BOOL_KEYS = [
  "additiveGifting",
  "giftIsCompensation",
  "giftIsPhysical",
] as const;
const DETAILS_LIST_KEYS = [
  "keyMessages",
  "prohibitedClaims",
  "contentRequirements",
  "platforms",
] as const;

export function validateDetailsGroup(
  raw: unknown,
): SectionValidation<CampaignDetailsInsert> {
  if (!isObject(raw)) return { valid: false, error: "details must be an object" };
  const out: Record<string, unknown> = {};

  if ("compensationStructure" in raw) {
    const s = raw["compensationStructure"];
    if (!COMPENSATION_STRUCTURES.includes(s as CompensationStructure)) {
      return {
        valid: false,
        error: `compensationStructure must be one of: ${COMPENSATION_STRUCTURES.join(", ")}`,
      };
    }
    out["compensationStructure"] = s;
  }
  if ("priceStrategy" in raw) {
    const s = raw["priceStrategy"];
    if (s === null) {
      out["priceStrategy"] = null;
    } else if (!PRICE_STRATEGIES.includes(s as PriceStrategy)) {
      return {
        valid: false,
        error: `priceStrategy must be one of: ${PRICE_STRATEGIES.join(", ")}`,
      };
    } else {
      out["priceStrategy"] = s;
    }
  }
  for (const key of DETAILS_STRING_KEYS) assignString(raw, key, out);
  for (const key of DETAILS_INT_KEYS) {
    if (!(key in raw)) continue;
    if (raw[key] === null) {
      out[key] = null;
      continue;
    }
    const r = nonNegInt(raw[key], key);
    if (!r.ok) return { valid: false, error: r.error };
    out[key] = r.value;
  }
  for (const key of DETAILS_BOOL_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (v === null) out[key] = null;
    else if (typeof v === "boolean") out[key] = v;
    else return { valid: false, error: `${key} must be a boolean` };
  }
  for (const key of DETAILS_LIST_KEYS) {
    if (!(key in raw)) continue;
    if (raw[key] === null) {
      out[key] = null;
      continue;
    }
    const r = stringArray(raw[key], key);
    if (!r.ok) return { valid: false, error: r.error };
    out[key] = r.value;
  }
  // deliverables is a jsonb array of objects (presentation-only) — accept an array
  // or null, don't over-validate the inner shape here (A2 owns the field UI).
  if ("deliverables" in raw) {
    const v = raw["deliverables"];
    if (v === null || Array.isArray(v)) out["deliverables"] = v;
    else return { valid: false, error: "deliverables must be an array" };
  }

  return { valid: true, value: out as Partial<CampaignDetailsInsert> };
}

// ---------------------------------------------------------------------------
// BrandIdentity — all nullable strings.
// ---------------------------------------------------------------------------

const BRAND_STRING_KEYS = [
  "brandName",
  "brandDescription",
  "websiteUrl",
  "productUrl",
  "productDescription",
  "logoUrl",
  "primaryColor",
  "secondaryColor",
  "typography",
] as const;

export function validateBrandIdentityGroup(
  raw: unknown,
): SectionValidation<BrandIdentityInsert> {
  if (!isObject(raw)) return { valid: false, error: "brandIdentity must be an object" };
  const out: Record<string, unknown> = {};
  for (const key of BRAND_STRING_KEYS) assignString(raw, key, out);
  return { valid: true, value: out as Partial<BrandIdentityInsert> };
}

// ---------------------------------------------------------------------------
// CreatorRequirement — informational; strings, non-neg ints, string[] lists.
// ---------------------------------------------------------------------------

const CREATOR_STRING_KEYS = [
  "niche",
  "audience",
  "contentStyle",
  "safetyNotes",
] as const;
const CREATOR_INT_KEYS = ["minFollowers", "maxFollowers"] as const;
const CREATOR_LIST_KEYS = ["platforms", "geographies", "languages"] as const;

export function validateCreatorRequirementGroup(
  raw: unknown,
): SectionValidation<CreatorRequirementInsert> {
  if (!isObject(raw)) {
    return { valid: false, error: "creatorRequirement must be an object" };
  }
  const out: Record<string, unknown> = {};
  for (const key of CREATOR_STRING_KEYS) assignString(raw, key, out);
  for (const key of CREATOR_INT_KEYS) {
    if (!(key in raw)) continue;
    if (raw[key] === null) {
      out[key] = null;
      continue;
    }
    const r = nonNegInt(raw[key], key);
    if (!r.ok) return { valid: false, error: r.error };
    out[key] = r.value;
  }
  for (const key of CREATOR_LIST_KEYS) {
    if (!(key in raw)) continue;
    if (raw[key] === null) {
      out[key] = null;
      continue;
    }
    const r = stringArray(raw[key], key);
    if (!r.ok) return { valid: false, error: r.error };
    out[key] = r.value;
  }
  return { valid: true, value: out as Partial<CreatorRequirementInsert> };
}
