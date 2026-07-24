// ---------------------------------------------------------------------------
// Deal-structure description for outreach copy
// ---------------------------------------------------------------------------
// The first email should explain WHAT KIND of deal this is — fixed fee,
// commission, or both — instead of vague filler. We derive a short, number-free
// sentence from the NEGOTIATION node's config so the draft model states the real
// offer and never has to invent terms.
//
// Deal type is inferred from the config the Workflow Builder templates produce:
//   - commission present AND a fixed-fee budget  -> hybrid  (fee + commission)
//   - commission present, no/zero fixed budget   -> affiliate (commission only)
//   - a fixed-fee budget, no commission          -> fixed fee
// No dollar figures are included — the band/rate is negotiated later, and the
// output guard must never see floor/ceiling here.

/**
 * The deal shape inferred from the NEGOTIATION node config, split into:
 *   - `type`    — a short human label ("hybrid partnership" / "affiliate
 *                 partnership" / "fixed-fee collaboration") for {{collaborationType}}
 *   - `summary` — the full price-free sentence (same wording describeDeal
 *                 returns) for {{offerSummary}} and outreach copy.
 * Both are undefined when the config carries no discernible deal shape.
 */
export interface DealShape {
  type: string;
  summary: string;
}

/**
 * Structured version of describeDeal: derive the deal type label AND the
 * price-free summary sentence from the NEGOTIATION node config. Returns
 * undefined when no deal shape is discernible (same condition describeDeal
 * returns undefined). No dollar figures — the band/rate is negotiated later.
 */
export function dealShape(negotiationConfig: Record<string, unknown> | undefined): DealShape | undefined {
  if (!negotiationConfig) return undefined;

  const commission =
    typeof negotiationConfig["commissionRate"] === "number" && negotiationConfig["commissionRate"] > 0
      ? (negotiationConfig["commissionRate"] as number)
      : undefined;

  // A "fixed fee" exists when the campaign carries a budget band at all
  // (minBudget/maxBudget or termFloor/termCeiling with any positive number).
  const hasFixedFee =
    isPositive(negotiationConfig["maxBudget"]) ||
    isPositive(negotiationConfig["minBudget"]) ||
    isPositive(rateOf(negotiationConfig["termCeiling"])) ||
    isPositive(rateOf(negotiationConfig["termFloor"]));

  if (commission !== undefined && hasFixedFee) {
    return {
      type: "hybrid partnership",
      summary:
        `a hybrid partnership — you receive a fixed fee for your content, ` +
        `PLUS a ${commission}% commission on the sales you drive. ` +
        `(The exact fee is discussed once you reply.)`,
    };
  }
  if (commission !== undefined && !hasFixedFee) {
    return {
      type: "affiliate partnership",
      summary:
        `a performance-based affiliate partnership — you earn a ${commission}% ` +
        `commission on every sale you drive through your unique link. ` +
        `(No upfront fee.)`,
    };
  }
  if (hasFixedFee) {
    return {
      type: "fixed-fee collaboration",
      summary:
        `a fixed-fee collaboration — a flat fee for an agreed piece of content. ` +
        `(The exact fee is discussed once you reply.)`,
    };
  }
  return undefined;
}

/**
 * Back-compat sentence form used by the outreach/negotiation draft prompts.
 * Returns just the `summary` from dealShape (or undefined).
 */
export function describeDeal(negotiationConfig: Record<string, unknown> | undefined): string | undefined {
  return dealShape(negotiationConfig)?.summary;
}

function isPositive(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function rateOf(term: unknown): number | undefined {
  if (term && typeof term === "object") {
    const r = (term as Record<string, unknown>)["rate"];
    if (typeof r === "number") return r;
  }
  return undefined;
}
