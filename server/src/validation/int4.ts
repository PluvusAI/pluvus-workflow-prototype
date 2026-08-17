import type { Response } from "express";

// PostgreSQL int4 max is 2147483647; a larger value overflows the column
// (SQLSTATE 22003). The lower bound is pinned to 0 rather than int4's true
// -2147483648 floor because every field this guards (minFollowers,
// floorCents, ceilingCents, preferredFeeCents, maxRounds,
// giftValueFlexibilityCents) is a non-negative quantity — a follower count,
// a money amount, or a round count. No caller needs a separate "can't be
// negative" check on top of this.
export const INT4_MIN = 0;
export const INT4_MAX = 2147483647;

/**
 * Rejects a value that isn't a valid int4 for these fields: not a number,
 * not an integer, or outside [INT4_MIN, INT4_MAX]. Without this, a bad value
 * passes the route's JS-level `number`-typed destructure and only fails at
 * INSERT/UPDATE with SQLSTATE 22003, which the route's catch-all turns into
 * a 500 instead of a clean 400.
 *
 * Writes the 400 response itself so call sites can do:
 *   if (!validateInt4(value, "fieldName", res)) return;
 */
export function validateInt4(value: unknown, name: string, res: Response): value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < INT4_MIN ||
    value > INT4_MAX
  ) {
    res.status(400).json({ error: `${name} must be an integer between ${INT4_MIN} and ${INT4_MAX}` });
    return false;
  }
  return true;
}
