// ---------------------------------------------------------------------------
// PLU-172 — cross-field validation for the negotiation-policy PATCH route
// ---------------------------------------------------------------------------
// Pure logic, no DB/Express — extracted from routes/campaigns.ts so this
// business logic is testable with plain fixtures (the SAME rationale as
// deliverablesValidator.ts's resolveDeliverableSave: entangling ~100 lines
// of cross-field rules inside an Express handler makes them untestable
// without a live DB or elaborate mocking; a pure function makes them
// trivial to test and easier to read).
//
// Checks two things the ticket's worksheet states explicitly:
//   1. "cannot be below the public amount" — a private limit must not
//      undercut the public offer it's meant to allow negotiating ABOVE.
//   2. "[a limit] exists only for [its authorizing mode]" — a limit field
//      submitted without its mode actually authorizing it is rejected here
//      (write time), not just silently excluded later (activation time —
//      see compensationShape.ts's projectActivePrivatePolicyFields, the
//      READ-time twin of this WRITE-time check).

export type NegotiationPolicyValidationCode =
  | "FEE_LIMIT_BELOW_PUBLIC_OFFER"
  | "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION"
  | "LIMIT_SET_WITHOUT_AUTHORIZING_MODE";

/** Only the fields THIS validation reads — a subset of the PATCH body. */
export interface NegotiationPolicyPatchInput {
  feeMode?: string | undefined;
  ceilingCents?: number | null | undefined;
  commissionNegotiationMode?: string | undefined;
  commissionCeilingRate?: number | null | undefined;
  commissionCeilingAmountCents?: number | null | undefined;
  commissionDurationMode?: string | undefined;
  commissionDurationLimitValue?: number | null | undefined;
  commissionDurationLimitUnit?: string | null | undefined;
  postingNegotiationMode?: string | undefined;
  postingMaxDelayDays?: number | null | undefined;
  giftSubstitutionMode?: string | undefined;
  giftApprovedSubstitutes?: unknown;
  giftCashReplacementMode?: string | undefined;
  giftCashReplacementLimitCents?: number | null | undefined;
  deliverableNegotiationMode?: string | undefined;
  deliverablePolicyRules?: unknown;
}

/** The live data this validation compares the patch against — a projection
 *  of CampaignDetails + the currently-stored NegotiationPolicy (for a mode
 *  fallback when the patch edits only the limit, not the mode itself). */
export interface NegotiationPolicyValidationContext {
  publicPriceStrategy: string | null;
  publicStartingFeeCents: number | null;
  /** "percent" | "flat" | null (campaignDetails.commissionMode). */
  publicCommissionMode: string | null;
  publicCommissionRate: number | null;
  existingCommissionDurationMode: string | null;
  existingPostingNegotiationMode: string | null;
  existingGiftSubstitutionMode: string | null;
  existingGiftCashReplacementMode: string | null;
  existingDeliverableNegotiationMode: string | null;
}

export type NegotiationPolicyValidationResult =
  | { ok: true }
  | { ok: false; code: NegotiationPolicyValidationCode; error: string };

export function validateNegotiationPolicyPatch(
  patch: NegotiationPolicyPatchInput,
  ctx: NegotiationPolicyValidationContext,
): NegotiationPolicyValidationResult {
  // S8.P1: "when a public starting fee exists, the maximum cannot be below
  // it." Only checked when ceilingCents is PART OF THIS PATCH — an
  // unrelated edit to an already-compliant policy must not re-run this
  // check against a value that isn't changing.
  if (patch.feeMode === "ALLOW_WITHIN_LIMIT" && patch.ceilingCents != null) {
    if (
      ctx.publicPriceStrategy === "PROPOSE_STARTING_FEE" &&
      ctx.publicStartingFeeCents != null &&
      patch.ceilingCents < ctx.publicStartingFeeCents
    ) {
      return {
        ok: false,
        code: "FEE_LIMIT_BELOW_PUBLIC_OFFER",
        error: "ceilingCents cannot be below the public starting fee",
      };
    }
    // REQUEST_RATE_CARD has no public numeric fee to compare against —
    // nothing to reject here; the RUNTIME rule that a submitted rate must
    // still not auto-approve without an explicit limit is frozen in
    // domain/policyDecision.ts (REQUEST_RATE_CARD_REQUIRES_EXPLICIT_LIMIT)
    // for PLU-175's evaluator to enforce, not this route's job.
  }

  // S8.A1: same "cannot be below the public amount" rule, branched on the
  // PUBLIC unit (campaignDetails.commissionMode: "percent" | "flat") so a
  // rate is never compared against a flat-dollar figure or vice versa.
  if (patch.commissionNegotiationMode === "ALLOW_WITHIN_LIMIT") {
    const publicIsFlat = ctx.publicCommissionMode === "flat";
    if (publicIsFlat) {
      if (
        patch.commissionCeilingAmountCents != null &&
        ctx.publicCommissionRate != null &&
        patch.commissionCeilingAmountCents < ctx.publicCommissionRate
      ) {
        return {
          ok: false,
          code: "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION",
          error: "commissionCeilingAmountCents cannot be below the public flat commission amount",
        };
      }
    } else if (
      patch.commissionCeilingRate != null &&
      ctx.publicCommissionRate != null &&
      patch.commissionCeilingRate < ctx.publicCommissionRate
    ) {
      return {
        ok: false,
        code: "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION",
        error: "commissionCeilingRate cannot be below the public commission",
      };
    }
  }

  // Reject a NEW-field limit submitted without its authorizing mode — read
  // the mode from THIS patch when it's part of the request, else fall back
  // to whatever's already stored (a limit-only edit against an
  // already-authorizing mode must still be accepted).
  const effectiveCommissionDurationMode = patch.commissionDurationMode ?? ctx.existingCommissionDurationMode;
  if (
    (patch.commissionDurationLimitValue != null || patch.commissionDurationLimitUnit != null) &&
    effectiveCommissionDurationMode !== "ALLOW_WITHIN_LIMIT"
  ) {
    return {
      ok: false,
      code: "LIMIT_SET_WITHOUT_AUTHORIZING_MODE",
      error: "commissionDurationLimitValue/commissionDurationLimitUnit may only be set when commissionDurationMode is ALLOW_WITHIN_LIMIT",
    };
  }

  const effectivePostingMode = patch.postingNegotiationMode ?? ctx.existingPostingNegotiationMode;
  if (patch.postingMaxDelayDays != null && effectivePostingMode !== "ALLOW_DELAY_DAYS") {
    return {
      ok: false,
      code: "LIMIT_SET_WITHOUT_AUTHORIZING_MODE",
      error: "postingMaxDelayDays may only be set when postingNegotiationMode is ALLOW_DELAY_DAYS",
    };
  }

  const effectiveGiftSubstitutionMode = patch.giftSubstitutionMode ?? ctx.existingGiftSubstitutionMode;
  if (
    patch.giftApprovedSubstitutes != null &&
    effectiveGiftSubstitutionMode !== "ALLOW_EQUIVALENT_APPROVED_OPTION"
  ) {
    return {
      ok: false,
      code: "LIMIT_SET_WITHOUT_AUTHORIZING_MODE",
      error: "giftApprovedSubstitutes may only be set when giftSubstitutionMode is ALLOW_EQUIVALENT_APPROVED_OPTION",
    };
  }

  const effectiveDeliverableMode = patch.deliverableNegotiationMode ?? ctx.existingDeliverableNegotiationMode;
  if (
    patch.deliverablePolicyRules != null &&
    effectiveDeliverableMode !== "ALLOW_SELECTED_CHANGES"
  ) {
    return {
      ok: false,
      code: "LIMIT_SET_WITHOUT_AUTHORIZING_MODE",
      error: "deliverablePolicyRules may only be set when deliverableNegotiationMode is ALLOW_SELECTED_CHANGES",
    };
  }

  // Calvin review (item 6): giftCashReplacementLimitCents is a DEDICATED
  // new column (not a reuse of the pre-existing giftValueFlexibilityCents),
  // so it gets the same write-time gate as every other new limit field.
  const effectiveGiftCashReplacementMode = patch.giftCashReplacementMode ?? ctx.existingGiftCashReplacementMode;
  if (
    patch.giftCashReplacementLimitCents != null &&
    effectiveGiftCashReplacementMode !== "ALLOW_UP_TO_AMOUNT"
  ) {
    return {
      ok: false,
      code: "LIMIT_SET_WITHOUT_AUTHORIZING_MODE",
      error: "giftCashReplacementLimitCents may only be set when giftCashReplacementMode is ALLOW_UP_TO_AMOUNT",
    };
  }

  return { ok: true };
}

/** True when the patch touches any field this validator reads — the route's
 *  cheap short-circuit for skipping the (otherwise two-query) DB fetch this
 *  validation needs when the patch doesn't concern any of these fields. */
export function needsNegotiationPolicyCrossFieldCheck(patch: NegotiationPolicyPatchInput): boolean {
  return (
    patch.feeMode !== undefined ||
    patch.ceilingCents !== undefined ||
    patch.commissionNegotiationMode !== undefined ||
    patch.commissionCeilingRate !== undefined ||
    patch.commissionCeilingAmountCents !== undefined ||
    patch.commissionDurationMode !== undefined ||
    patch.commissionDurationLimitValue !== undefined ||
    patch.commissionDurationLimitUnit !== undefined ||
    patch.postingNegotiationMode !== undefined ||
    patch.postingMaxDelayDays !== undefined ||
    patch.giftSubstitutionMode !== undefined ||
    patch.giftApprovedSubstitutes !== undefined ||
    patch.giftCashReplacementMode !== undefined ||
    patch.giftCashReplacementLimitCents !== undefined ||
    patch.deliverableNegotiationMode !== undefined ||
    patch.deliverablePolicyRules !== undefined
  );
}
