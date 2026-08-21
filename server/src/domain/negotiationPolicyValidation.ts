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
  // Review fix: the fee/commission "cannot be below the public offer"
  // checks need the CURRENTLY-STORED mode and limit too, not just the
  // patch's — a patch that edits only the limit (mode already stored as
  // ALLOW_WITHIN_LIMIT) or only the mode (limit already stored, stale)
  // must still be validated against the real effective state.
  existingFeeMode: string | null;
  existingCeilingCents: number | null;
  existingCommissionNegotiationMode: string | null;
  existingCommissionCeilingRate: number | null;
  existingCommissionCeilingAmountCents: number | null;
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
  // it."
  //
  // Review fix: the original check gated on `patch.feeMode ===
  // "ALLOW_WITHIN_LIMIT"` literally — so once a policy already had
  // feeMode=ALLOW_WITHIN_LIMIT stored, a LATER patch that lowered
  // ceilingCents WITHOUT resubmitting feeMode skipped this check entirely
  // (patch.feeMode was undefined, not "ALLOW_WITHIN_LIMIT"), letting an
  // invalid limit through to persistence and, eventually, the immutable
  // launch snapshot. Fixed by resolving BOTH the effective mode and the
  // effective limit from the patch, falling back to the currently-stored
  // value for whichever one this patch doesn't touch — the same
  // patch-or-existing pattern already used below for the
  // "limit without an authorizing mode" checks. Gated on whether THIS patch
  // touches feeMode or ceilingCents at all, so an unrelated field edit
  // (e.g. postingMaxDelayDays) never re-validates fee data it didn't touch.
  if (patch.feeMode !== undefined || patch.ceilingCents !== undefined) {
    const effectiveFeeMode = patch.feeMode ?? ctx.existingFeeMode;
    const effectiveCeilingCents = patch.ceilingCents === undefined ? ctx.existingCeilingCents : patch.ceilingCents;
    if (effectiveFeeMode === "ALLOW_WITHIN_LIMIT" && effectiveCeilingCents != null) {
      if (
        ctx.publicPriceStrategy === "PROPOSE_STARTING_FEE" &&
        ctx.publicStartingFeeCents != null &&
        effectiveCeilingCents < ctx.publicStartingFeeCents
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
  }

  // S8.A1: same "cannot be below the public amount" rule, branched on the
  // PUBLIC unit (campaignDetails.commissionMode: "percent" | "flat") so a
  // rate is never compared against a flat-dollar figure or vice versa.
  //
  // Review fix: same effective-mode/effective-limit resolution as the fee
  // check above — a patch that edits only commissionCeilingRate/
  // commissionCeilingAmountCents against an ALREADY-ALLOW_WITHIN_LIMIT
  // policy (mode not resubmitted) must still be validated.
  if (
    patch.commissionNegotiationMode !== undefined ||
    patch.commissionCeilingRate !== undefined ||
    patch.commissionCeilingAmountCents !== undefined
  ) {
    const effectiveCommissionMode = patch.commissionNegotiationMode ?? ctx.existingCommissionNegotiationMode;
    if (effectiveCommissionMode === "ALLOW_WITHIN_LIMIT") {
      const publicIsFlat = ctx.publicCommissionMode === "flat";
      if (publicIsFlat) {
        const effectiveAmountCents =
          patch.commissionCeilingAmountCents === undefined
            ? ctx.existingCommissionCeilingAmountCents
            : patch.commissionCeilingAmountCents;
        if (
          effectiveAmountCents != null &&
          ctx.publicCommissionRate != null &&
          effectiveAmountCents < ctx.publicCommissionRate
        ) {
          return {
            ok: false,
            code: "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION",
            error: "commissionCeilingAmountCents cannot be below the public flat commission amount",
          };
        }
      } else {
        const effectiveRate =
          patch.commissionCeilingRate === undefined ? ctx.existingCommissionCeilingRate : patch.commissionCeilingRate;
        if (effectiveRate != null && ctx.publicCommissionRate != null && effectiveRate < ctx.publicCommissionRate) {
          return {
            ok: false,
            code: "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION",
            error: "commissionCeilingRate cannot be below the public commission",
          };
        }
      }
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
