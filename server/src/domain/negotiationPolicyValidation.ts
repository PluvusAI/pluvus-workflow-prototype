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

export type NegotiationPolicyValidationResult =
  | { ok: true }
  | { ok: false; code: NegotiationPolicyValidationCode; error: string };

// ---------------------------------------------------------------------------
// Review fix — "validate public fee/commission/unit changes together with
// the stored policy before committing the details update"
// ---------------------------------------------------------------------------
// The below-public-offer rule ("a private limit must not undercut the
// public offer it's meant to allow negotiating above") is symmetric: it can
// be violated by EITHER side moving — a NegotiationPolicy patch lowering
// the limit below an unchanged public offer (validateNegotiationPolicyPatch,
// below), or a CampaignDetails patch raising the public offer above an
// unchanged limit (validateCampaignDetailsAgainstPolicy, further down).
// Both resolve their own "effective state" (their own patch merged with
// whatever's currently stored on THEIR side) and hand it to this ONE
// checker — a single authoritative comparison, not two independently
// hand-written copies that could quietly drift apart from each other.
export interface EffectiveFeeCommissionState {
  feeMode: string | null;
  ceilingCents: number | null;
  publicPriceStrategy: string | null;
  publicStartingFeeCents: number | null;
  commissionNegotiationMode: string | null;
  commissionCeilingRate: number | null;
  commissionCeilingAmountCents: number | null;
  /** "percent" | "flat" | null (campaignDetails.commissionMode) — the UNIT
   *  a change to this field is exactly what makes "unit changes" (the
   *  review's own phrase) a real hazard: flipping it can silently swap
   *  which of commissionCeilingRate/commissionCeilingAmountCents governs,
   *  without either side's raw number changing at all. */
  publicCommissionMode: string | null;
  publicCommissionRate: number | null;
}

export function checkFeeCommissionConsistency(
  state: EffectiveFeeCommissionState,
): NegotiationPolicyValidationResult {
  // S8.P1: "when a public starting fee exists, the maximum cannot be below it."
  if (state.feeMode === "ALLOW_WITHIN_LIMIT" && state.ceilingCents != null) {
    if (
      state.publicPriceStrategy === "PROPOSE_STARTING_FEE" &&
      state.publicStartingFeeCents != null &&
      state.ceilingCents < state.publicStartingFeeCents
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
    // for PLU-175's evaluator to enforce, not this validator's job.
  }

  // S8.A1: same "cannot be below the public amount" rule, branched on the
  // PUBLIC unit so a rate is never compared against a flat-dollar figure or
  // vice versa.
  if (state.commissionNegotiationMode === "ALLOW_WITHIN_LIMIT") {
    const publicIsFlat = state.publicCommissionMode === "flat";
    if (publicIsFlat) {
      if (
        state.commissionCeilingAmountCents != null &&
        state.publicCommissionRate != null &&
        state.commissionCeilingAmountCents < state.publicCommissionRate
      ) {
        return {
          ok: false,
          code: "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION",
          error: "commissionCeilingAmountCents cannot be below the public flat commission amount",
        };
      }
    } else if (
      state.commissionCeilingRate != null &&
      state.publicCommissionRate != null &&
      state.commissionCeilingRate < state.publicCommissionRate
    ) {
      return {
        ok: false,
        code: "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION",
        error: "commissionCeilingRate cannot be below the public commission",
      };
    }
  }

  return { ok: true };
}

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

export function validateNegotiationPolicyPatch(
  patch: NegotiationPolicyPatchInput,
  ctx: NegotiationPolicyValidationContext,
): NegotiationPolicyValidationResult {
  // S8.P1/S8.A1 "cannot be below the public amount" — delegated to the
  // shared checker (checkFeeCommissionConsistency, above) so this direction
  // (policy patch moving) and the CampaignDetails direction
  // (validateCampaignDetailsAgainstPolicy, below — public offer moving) can
  // never independently drift on the actual comparison rule.
  //
  // Review fix: the original check gated on `patch.feeMode ===
  // "ALLOW_WITHIN_LIMIT"` literally — so once a policy already had
  // feeMode=ALLOW_WITHIN_LIMIT stored, a LATER patch that lowered
  // ceilingCents WITHOUT resubmitting feeMode skipped this check entirely
  // (patch.feeMode was undefined, not "ALLOW_WITHIN_LIMIT"), letting an
  // invalid limit through to persistence and, eventually, the immutable
  // launch snapshot. Fixed by resolving BOTH the effective mode and the
  // effective limit from the patch, falling back to the currently-stored
  // value for whichever one this patch doesn't touch. Only actually run
  // when THIS patch touches a relevant field, so an unrelated edit (e.g.
  // postingMaxDelayDays) never re-validates fee/commission data it didn't
  // touch, even if that stored data happens to already be invalid.
  const touchesFee = patch.feeMode !== undefined || patch.ceilingCents !== undefined;
  const touchesCommission =
    patch.commissionNegotiationMode !== undefined ||
    patch.commissionCeilingRate !== undefined ||
    patch.commissionCeilingAmountCents !== undefined;
  if (touchesFee || touchesCommission) {
    // checkFeeCommissionConsistency returns the FIRST violation it finds
    // (fee before commission) — it's meant for callers (like
    // validateCampaignDetailsAgainstPolicy, below) where both halves are
    // always relevant to the same patch. Here, only one half might be. If
    // the untouched half's stale, pre-existing data were passed through as
    // real gate values, a fee-only patch with already-bad stored commission
    // data would have its fee violation returned first, masking that same
    // check for a commission-only patch — or worse, an untouched-but-broken
    // fee entry would short-circuit past a REAL new commission violation
    // this patch is introducing, letting it through. Neutralized instead:
    // the untouched side's gating field is forced to a value that can never
    // trip its own check (feeMode/commissionNegotiationMode default to
    // anything other than "ALLOW_WITHIN_LIMIT"), so only the touched side
    // can ever produce a violation here.
    const consistency = checkFeeCommissionConsistency({
      feeMode: touchesFee ? patch.feeMode ?? ctx.existingFeeMode : null,
      ceilingCents: touchesFee ? (patch.ceilingCents === undefined ? ctx.existingCeilingCents : patch.ceilingCents) : null,
      publicPriceStrategy: ctx.publicPriceStrategy,
      publicStartingFeeCents: ctx.publicStartingFeeCents,
      commissionNegotiationMode: touchesCommission
        ? patch.commissionNegotiationMode ?? ctx.existingCommissionNegotiationMode
        : null,
      commissionCeilingRate: touchesCommission
        ? patch.commissionCeilingRate === undefined
          ? ctx.existingCommissionCeilingRate
          : patch.commissionCeilingRate
        : null,
      commissionCeilingAmountCents: touchesCommission
        ? patch.commissionCeilingAmountCents === undefined
          ? ctx.existingCommissionCeilingAmountCents
          : patch.commissionCeilingAmountCents
        : null,
      publicCommissionMode: ctx.publicCommissionMode,
      publicCommissionRate: ctx.publicCommissionRate,
    });
    if (!consistency.ok) {
      return consistency;
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

// ---------------------------------------------------------------------------
// Review fix — "This draft-locked write updates CampaignDetails without
// validating the existing negotiation policy against the prospective public
// terms." A campaign with a 50,000-cent public fee and a matching
// ALLOW_WITHIN_LIMIT/50,000-cent private ceiling accepted a details PATCH
// raising the public fee to 60,000 cents with nothing catching it; launch
// then froze the now-stale 50,000-cent private limit into its immutable
// snapshot. This is the OTHER direction of the same invariant
// validateNegotiationPolicyPatch already protects (a NegotiationPolicy patch
// moving the limit below an unchanged public offer) — here it's the public
// offer moving above an unchanged limit. checkFeeCommissionConsistency
// (above) is the single shared comparison both directions call.
// ---------------------------------------------------------------------------

/** Only the CampaignDetails fields that can move the public side of the
 *  fee/commission consistency check — the "public fee, commission, and
 *  unit changes" the review calls out by name. */
export interface CampaignDetailsPatchInput {
  priceStrategy?: string | null | undefined;
  publicStartingFeeCents?: number | null | undefined;
  /** "percent" | "flat" | null — the "unit" half of the review's report. */
  commissionMode?: string | null | undefined;
  publicCommissionRate?: number | null | undefined;
}

/** The live data this validation compares a CampaignDetails patch against —
 *  a projection of the CURRENTLY-STORED CampaignDetails (fallback for
 *  whichever public field this patch doesn't touch) plus the currently-
 *  stored NegotiationPolicy (read-only here — this check never writes to
 *  the policy, it only asks whether the policy's existing limits still make
 *  sense against the prospective public terms). */
export interface CampaignDetailsValidationContext {
  existingPriceStrategy: string | null;
  existingPublicStartingFeeCents: number | null;
  existingCommissionMode: string | null;
  existingPublicCommissionRate: number | null;
  policyFeeMode: string | null;
  policyCeilingCents: number | null;
  policyCommissionNegotiationMode: string | null;
  policyCommissionCeilingRate: number | null;
  policyCommissionCeilingAmountCents: number | null;
}

export function validateCampaignDetailsAgainstPolicy(
  patch: CampaignDetailsPatchInput,
  ctx: CampaignDetailsValidationContext,
): NegotiationPolicyValidationResult {
  // Same "only check the side this patch actually touches" gating as
  // validateNegotiationPolicyPatch, mirrored: a patch that only touches
  // priceStrategy/publicStartingFeeCents must not be blocked by pre-existing,
  // untouched, already-invalid commission data (or vice versa) — the mode
  // fields (read from the POLICY, never from this patch) are neutralized to
  // a value that can't trip checkFeeCommissionConsistency's gate when the
  // corresponding public field isn't part of this patch.
  const touchesFeeSide = patch.priceStrategy !== undefined || patch.publicStartingFeeCents !== undefined;
  const touchesCommissionSide = patch.commissionMode !== undefined || patch.publicCommissionRate !== undefined;
  return checkFeeCommissionConsistency({
    feeMode: touchesFeeSide ? ctx.policyFeeMode : null,
    ceilingCents: touchesFeeSide ? ctx.policyCeilingCents : null,
    publicPriceStrategy: patch.priceStrategy === undefined ? ctx.existingPriceStrategy : patch.priceStrategy,
    publicStartingFeeCents:
      patch.publicStartingFeeCents === undefined ? ctx.existingPublicStartingFeeCents : patch.publicStartingFeeCents,
    commissionNegotiationMode: touchesCommissionSide ? ctx.policyCommissionNegotiationMode : null,
    commissionCeilingRate: touchesCommissionSide ? ctx.policyCommissionCeilingRate : null,
    commissionCeilingAmountCents: touchesCommissionSide ? ctx.policyCommissionCeilingAmountCents : null,
    publicCommissionMode: patch.commissionMode === undefined ? ctx.existingCommissionMode : patch.commissionMode,
    publicCommissionRate:
      patch.publicCommissionRate === undefined ? ctx.existingPublicCommissionRate : patch.publicCommissionRate,
  });
}

/** True when the patch touches any field that could move the public side of
 *  the fee/commission consistency check — the route's cheap short-circuit
 *  for skipping the (otherwise two-query: CampaignDetails + NegotiationPolicy)
 *  DB fetch this validation needs. */
export function needsCampaignDetailsCrossFieldCheck(patch: CampaignDetailsPatchInput): boolean {
  return (
    patch.priceStrategy !== undefined ||
    patch.publicStartingFeeCents !== undefined ||
    patch.commissionMode !== undefined ||
    patch.publicCommissionRate !== undefined
  );
}
