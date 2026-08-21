import { Router } from "express";
import type { Request, Response } from "express";
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignWithWorkflows,
  findCampaignById,
  deleteCampaign,
  launchCampaign,
  duplicateCampaign,
  computeReadiness,
  CampaignNotFoundError,
  CampaignDetailsMissingError,
  NegotiationPolicyMissingError,
  CompensationReviewPendingError,
  CompensationIncompleteError,
} from "../db/campaigns.js";
import {
  CampaignLockedError,
  getCampaignDetails,
  getCampaignDetailsByCampaignIds,
  upsertCampaignDetails,
} from "../db/campaignDetails.js";
import {
  getNegotiationPolicy,
  upsertNegotiationPolicy,
  upsertNegotiationPolicyValidated,
  NegotiationPolicyValidationError,
} from "../db/negotiationPolicy.js";
import {
  validateDeliverables,
  normalizeLegacyDeliverables,
  remapLegacyDeliverablePricingKeys,
  resolveDeliverableSave,
} from "../domain/deliverablesValidator.js";
import { validateDeliverablePolicyRules } from "../domain/deliverablePolicyRules.js";
import {
  validateRightsPolicyRules,
  SCRIPT_WAIVER_MODES,
  isScriptWaiverMode,
} from "../domain/rightsPolicyRules.js";
import type { NegotiationPolicyValidationCode as CrossFieldValidationCode } from "../domain/negotiationPolicyValidation.js";
import { getBrandIdentity, upsertBrandIdentity } from "../db/brandIdentity.js";
import {
  getCreatorRequirement,
  upsertCreatorRequirement,
} from "../db/creatorRequirement.js";
import {
  getLatestBriefExtraction,
  insertBriefExtraction,
} from "../db/campaignBriefExtraction.js";
import {
  createWorkflow,
  updateWorkflow,
} from "../db/workflows.js";
import { findEmailAccountById } from "../db/emailAccounts.js";
import { getTemplate } from "../templates/index.js";
import { readStoredFile } from "../storage/localFileStorage.js";
import { agentBaseUrl, agentPostJson } from "../adapters/agentServiceClient.js";
import {
  expectedBriefParseMode,
  expectedParserVersion,
} from "../engine/executors/briefKnowledge.js";
import { validateTargetUrl } from "../validation/targetUrl.js";
import { validateInt4 } from "../validation/int4.js";
import {
  validateCreateSendingSettings,
  validatePatchSendingSettings,
} from "../validation/campaignSendingSettings.js";
import type { Campaign, CampaignDetails, JsonValue } from "../db/schema.js";

const router = Router();

// PLU-135 (1a): the API's JSON contract is unchanged — creator-facing fields
// still appear flat on the campaign object even though they now live in a
// separate CampaignDetails row underneath. One flatten function, reused by
// every handler that returns a campaign, so the merge shape can't drift
// between list/get/create/patch responses.
function flattenCampaign(campaign: Campaign, details: CampaignDetails | null) {
  return {
    id: campaign.id,
    name: campaign.name,
    brand: campaign.brand,
    // PLU-135 (1a): DRAFT | ACTIVE. ACTIVE means launched — CampaignDetails
    // below reflects the frozen CampaignTermsSnapshot in every practical
    // sense (writes are rejected once ACTIVE), not the "live draft" language
    // above literally implies once a campaign reaches this state.
    status: campaign.status,
    // PLU-136: lives on CampaignDetails (moved from Campaign so it's
    // captured by CampaignTermsSnapshot) — classification only, never gates
    // launch/negotiation by itself; see validateCompensationReadiness for
    // what actually gates launch per structure.
    campaignType: details?.campaignType ?? null,
    includesGifting: details?.includesGifting ?? false,
    giftDisposition: details?.giftDisposition ?? null,
    priceStrategy: details?.priceStrategy ?? null,
    publicStartingFeeCents: details?.publicStartingFeeCents ?? null,
    publicCommissionRate: details?.publicCommissionRate ?? null,
    commissionDurationDays: details?.commissionDurationDays ?? null,
    commissionConditions: details?.commissionConditions ?? null,
    compensationReviewStatus: details?.compensationReviewStatus ?? null,
    duplicatedFromCampaignId: campaign.duplicatedFromCampaignId,
    objective: details?.objective ?? null,
    notes: campaign.notes,
    notifyEmail: campaign.notifyEmail,
    brandDescription: details?.brandDescription ?? null,
    deliverables: details?.deliverables ?? null,
    timeline: details?.timeline ?? null,
    rewardDescription: details?.productOrOffer ?? null,
    shipsPhysicalProduct: details?.shipsPhysicalProduct ?? false,
    usageRights: details?.usageRights ?? null,
    exclusivity: details?.exclusivity ?? null,
    paymentTerms: details?.publicPaymentTerms ?? null,
    attributionWindow: details?.attributionWindow ?? null,
    keyMessages: details?.keyMessages ?? null,
    contentRequirements: details?.contentRequirements ?? null,
    // PLU-139 (2a): worksheet Stage-1 fields.
    productName: details?.productName ?? null,
    productType: details?.productType ?? null,
    creatorAccessNeeded: details?.creatorAccessNeeded ?? null,
    uniqueSellingPoints: details?.uniqueSellingPoints ?? null,
    whyTrust: details?.whyTrust ?? null,
    howToUse: details?.howToUse ?? null,
    brandAssets: details?.brandAssets ?? null,
    brandMaterialsRef: details?.brandMaterialsRef ?? null,
    deliverableQuantities: details?.deliverableQuantities ?? null,
    deliverablePricing: details?.deliverablePricing ?? null,
    followerRanges: details?.followerRanges ?? null,
    fieldProvenance: details?.fieldProvenance ?? null,
    briefDeliveryMethod: details?.briefDeliveryMethod ?? null,
    briefHighlight: details?.briefHighlight ?? null,
    creativeConcept: details?.creativeConcept ?? null,
    referenceVideos: details?.referenceVideos ?? null,
    scriptSubmission: details?.scriptSubmission ?? null,
    adAuthorization: details?.adAuthorization ?? null,
    linkInBioDuration: details?.linkInBioDuration ?? null,
    postRetention: details?.postRetention ?? null,
    instagramCollab: details?.instagramCollab ?? null,
    requireApproval: details?.requireApproval ?? null,
    commissionMode: details?.commissionMode ?? null,
    variableCommission: details?.variableCommission ?? null,
    giftDeliveryMethod: details?.giftDeliveryMethod ?? null,
    promoCode: details?.promoCode ?? null,
    giftContactEmail: details?.giftContactEmail ?? null,
    requiresShippingInfo: details?.requiresShippingInfo ?? null,
    affiliateTrackingUrl: details?.affiliateTrackingUrl ?? null,
    trackingLinkMode: details?.trackingLinkMode ?? null,
    trackingDestinationUrl: details?.trackingDestinationUrl ?? null,
    trackingParameter: details?.trackingParameter ?? null,
    targetUrl: campaign.targetUrl,
    hiddenParamKey: campaign.hiddenParamKey,
    postAcceptanceMode: campaign.postAcceptanceMode,
    dailyInitialOutreachLimit: campaign.dailyInitialOutreachLimit,
    outreachPacingMinMinutes: campaign.outreachPacingMinMinutes,
    outreachPacingMaxMinutes: campaign.outreachPacingMaxMinutes,
    negotiationReplyPacingMinMinutes: campaign.negotiationReplyPacingMinMinutes,
    negotiationReplyPacingMaxMinutes: campaign.negotiationReplyPacingMaxMinutes,
    emailAccountId: campaign.emailAccountId,
  };
}

// GET /campaigns — list all campaigns with workflow counts
router.get("/", async (_req: Request, res: Response) => {
  try {
    const campaigns = await listCampaigns();
    const detailsByCampaignId = await getCampaignDetailsByCampaignIds(
      campaigns.map((c) => c.id),
    );
    res.json(
      campaigns.map((c) => ({
        ...flattenCampaign(c, detailsByCampaignId.get(c.id) ?? null),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        workflowCount: c._count.workflows,
      })),
    );
  } catch (err) {
    console.error("[campaigns] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// Lightweight email shape check — good enough to reject obvious typos without
// pulling in a validation lib. The notifyEmail is optional; only validated when
// a non-empty value is supplied.
function isEmailish(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// PLU-70. Anything not explicitly "operator_handoff" resolves to the existing
// behavior — an unknown/garbage value must never silently opt a campaign INTO
// pausing deals, and omitting the field must leave existing campaigns alone.
const POST_ACCEPTANCE_MODES = ["local_payment", "operator_handoff"] as const;
type PostAcceptanceModeValue = (typeof POST_ACCEPTANCE_MODES)[number];

function isPostAcceptanceMode(v: unknown): v is PostAcceptanceModeValue {
  return typeof v === "string" && (POST_ACCEPTANCE_MODES as readonly string[]).includes(v);
}

// PLU-136 compensation contract: same reject-unrecognized-value-loudly
// pattern as isPostAcceptanceMode above, for each new enum field.
const CAMPAIGN_TYPES = ["PAID", "AFFILIATE", "HYBRID", "GIFT_ONLY"] as const;
type CampaignTypeValue = (typeof CAMPAIGN_TYPES)[number];
function isCampaignType(v: unknown): v is CampaignTypeValue {
  return typeof v === "string" && (CAMPAIGN_TYPES as readonly string[]).includes(v);
}

const GIFT_DISPOSITIONS = ["KEEP", "LOAN", "RETURN"] as const;
type GiftDispositionValue = (typeof GIFT_DISPOSITIONS)[number];
function isGiftDisposition(v: unknown): v is GiftDispositionValue {
  return typeof v === "string" && (GIFT_DISPOSITIONS as readonly string[]).includes(v);
}

const PRICE_STRATEGIES = ["REQUEST_RATE_CARD", "PROPOSE_STARTING_FEE"] as const;
type PriceStrategyValue = (typeof PRICE_STRATEGIES)[number];
function isPriceStrategy(v: unknown): v is PriceStrategyValue {
  return typeof v === "string" && (PRICE_STRATEGIES as readonly string[]).includes(v);
}

// PLU-172: one guard factory instead of 9 hand-written copies of the same
// "typeof v === string && values.includes(v)" check — the Page-8 mode
// enums all follow the identical shape isCampaignType/isPriceStrategy
// above already established.
function makeEnumGuard<T extends string>(values: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);
}

const FEE_NEGOTIATION_MODES = ["KEEP_PUBLIC_OFFER", "ALLOW_WITHIN_LIMIT", "ASK_FOR_APPROVAL"] as const;
const isFeeNegotiationMode = makeEnumGuard(FEE_NEGOTIATION_MODES);

const COMMISSION_NEGOTIATION_MODES = ["KEEP_PUBLIC_COMMISSION", "ALLOW_WITHIN_LIMIT", "ASK_FOR_APPROVAL"] as const;
const isCommissionNegotiationMode = makeEnumGuard(COMMISSION_NEGOTIATION_MODES);

const COMMISSION_DURATION_MODES = ["KEEP_PUBLIC_DURATION", "ALLOW_WITHIN_LIMIT", "ASK_FOR_APPROVAL"] as const;
const isCommissionDurationMode = makeEnumGuard(COMMISSION_DURATION_MODES);

const DURATION_UNITS = ["DAYS", "LIFETIME", "COUNT"] as const;
const isDurationUnit = makeEnumGuard(DURATION_UNITS);

const GIFT_SUBSTITUTION_MODES = ["KEEP_OFFERED_BENEFIT", "ALLOW_EQUIVALENT_APPROVED_OPTION", "ASK_FOR_APPROVAL"] as const;
const isGiftSubstitutionMode = makeEnumGuard(GIFT_SUBSTITUTION_MODES);

const GIFT_CASH_REPLACEMENT_MODES = ["REJECT", "ASK_FOR_APPROVAL", "ALLOW_UP_TO_AMOUNT"] as const;
const isGiftCashReplacementMode = makeEnumGuard(GIFT_CASH_REPLACEMENT_MODES);

const DELIVERABLE_NEGOTIATION_MODES = ["KEEP_REQUESTED", "ASK_FOR_APPROVAL", "ALLOW_SELECTED_CHANGES"] as const;
const isDeliverableNegotiationMode = makeEnumGuard(DELIVERABLE_NEGOTIATION_MODES);

const POSTING_NEGOTIATION_MODES = ["KEEP_DEADLINE", "ALLOW_DELAY_DAYS", "ASK_FOR_APPROVAL"] as const;
const isPostingNegotiationMode = makeEnumGuard(POSTING_NEGOTIATION_MODES);

const OUT_OF_POLICY_ACTIONS = ["ASK_FOR_APPROVAL", "REJECT_REQUEST"] as const;
const isOutOfPolicyAction = makeEnumGuard(OUT_OF_POLICY_ACTIONS);

function isStringArrayOrNull(v: unknown): v is string[] | null {
  return v === null || (Array.isArray(v) && v.every((x) => typeof x === "string"));
}

// PLU-172 (review item 4 — "Stable API errors"): every new validation branch
// this ticket adds returns a machine-readable `code` alongside the human
// `error` message, so a client can branch on the FAILURE REASON rather than
// parsing prose. A plain string union (not a thrown Error class, unlike
// CampaignLockedError/CompensationIncompleteError) — this is a single
// route's field-validation branch, not a reusable domain error a caller
// catches by type. Extends the pure cross-field validator's own 3 codes
// (domain/negotiationPolicyValidation.ts — the single source of truth for
// those) with one more this route adds locally for its enum/shape guards.
type NegotiationPolicyValidationCode = CrossFieldValidationCode | "INVALID_FIELD_VALUE";

function negotiationPolicyValidationError(
  res: Response,
  code: NegotiationPolicyValidationCode,
  error: string,
): void {
  res.status(400).json({ error, code });
}

// Accepted on create/patch so a future explicit-selection UI can set
// CONFIRMED directly — the review UI/queue itself is PLU-144's job, this
// route only needs to not block the field existing.
const COMPENSATION_REVIEW_STATUSES = ["NEEDS_REVIEW", "CONFIRMED"] as const;
type CompensationReviewStatusValue = (typeof COMPENSATION_REVIEW_STATUSES)[number];
function isCompensationReviewStatus(v: unknown): v is CompensationReviewStatusValue {
  return typeof v === "string" && (COMPENSATION_REVIEW_STATUSES as readonly string[]).includes(v);
}

// POST /campaigns — create a campaign
router.post("/", async (req: Request, res: Response) => {
  const {
    name,
    brand,
    objective,
    notes,
    notifyEmail,
    brandDescription,
    deliverables,
    timeline,
    rewardDescription,
    shipsPhysicalProduct,
    usageRights,
    exclusivity,
    paymentTerms,
    attributionWindow,
    targetUrl,
    hiddenParamKey,
    postAcceptanceMode,
    emailAccountId,
    campaignType,
    includesGifting,
    giftDisposition,
    priceStrategy,
    publicStartingFeeCents,
    publicCommissionRate,
    commissionDurationDays,
    commissionConditions,
    compensationReviewStatus,
  } = req.body as {
    name?: string;
    brand?: string;
    objective?: string;
    notes?: string;
    notifyEmail?: string;
    brandDescription?: string;
    deliverables?: string;
    timeline?: string;
    rewardDescription?: string;
    shipsPhysicalProduct?: boolean;
    // HARD-K1 knowledge fields.
    usageRights?: string;
    exclusivity?: string;
    paymentTerms?: string;
    attributionWindow?: string;
    targetUrl?: string;
    hiddenParamKey?: string;
    postAcceptanceMode?: string;
    // PLU-121: the campaign's default sending mailbox (a ConnectedEmailAccount id).
    emailAccountId?: string;
    // PLU-136 compensation contract fields.
    campaignType?: string;
    includesGifting?: boolean;
    giftDisposition?: string;
    priceStrategy?: string;
    publicStartingFeeCents?: number;
    publicCommissionRate?: number;
    commissionDurationDays?: number;
    commissionConditions?: string;
    compensationReviewStatus?: string;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!brand || typeof brand !== "string" || !brand.trim()) {
    res.status(400).json({ error: "brand is required" });
    return;
  }
  const trimmedNotify =
    typeof notifyEmail === "string" ? notifyEmail.trim() : "";
  if (trimmedNotify && !isEmailish(trimmedNotify)) {
    res.status(400).json({ error: "notifyEmail must be a valid email address" });
    return;
  }

  // BUG-SEC5: reject an open-redirect / SSRF-prone targetUrl before it is stored.
  // Only http(s) with a host is accepted; javascript:/data:/file:/unparseable are
  // rejected. An absent/empty value is allowed (a campaign may have no target).
  const targetUrlCheck = validateTargetUrl(typeof targetUrl === "string" ? targetUrl : null);
  if (!targetUrlCheck.valid) {
    res.status(422).json({ error: targetUrlCheck.reason ?? "invalid targetUrl" });
    return;
  }

  // Reject an unrecognized mode loudly rather than defaulting it — a typo here
  // would otherwise silently give the brand the wrong post-acceptance behavior.
  if (postAcceptanceMode !== undefined && !isPostAcceptanceMode(postAcceptanceMode)) {
    res.status(400).json({
      error: `postAcceptanceMode must be one of: ${POST_ACCEPTANCE_MODES.join(", ")}`,
    });
    return;
  }

  // PLU-136: same reject-unrecognized-value-loudly posture for every new
  // compensation-contract enum.
  if (campaignType !== undefined && !isCampaignType(campaignType)) {
    res.status(400).json({ error: `campaignType must be one of: ${CAMPAIGN_TYPES.join(", ")}` });
    return;
  }
  if (giftDisposition !== undefined && !isGiftDisposition(giftDisposition)) {
    res.status(400).json({
      error: `giftDisposition must be one of: ${GIFT_DISPOSITIONS.join(", ")}`,
    });
    return;
  }
  if (priceStrategy !== undefined && !isPriceStrategy(priceStrategy)) {
    res.status(400).json({
      error: `priceStrategy must be one of: ${PRICE_STRATEGIES.join(", ")}`,
    });
    return;
  }
  if (
    compensationReviewStatus !== undefined &&
    !isCompensationReviewStatus(compensationReviewStatus)
  ) {
    res.status(400).json({
      error: `compensationReviewStatus must be one of: ${COMPENSATION_REVIEW_STATUSES.join(", ")}`,
    });
    return;
  }

  const sendingSettings = validateCreateSendingSettings(req.body as Record<string, unknown>);
  if (!sendingSettings.valid) {
    res.status(400).json({ error: sendingSettings.error });
    return;
  }

  // PLU-121: when a default sender is supplied, it must reference a real
  // connected account — reject an unknown id rather than silently storing a
  // dangling pointer that would fall back to the default account at enrollment.
  const trimmedAccountId =
    typeof emailAccountId === "string" ? emailAccountId.trim() : "";
  try {
    if (trimmedAccountId) {
      const account = await findEmailAccountById(trimmedAccountId);
      if (!account || account.status !== "active") {
        res.status(400).json({
          error: "emailAccountId must reference an active connected account",
        });
        return;
      }
    }

    // PLU-135 (1a): execution-level fields go to Campaign; every creator-facing
    // field below goes to its CampaignDetails row instead — see flattenCampaign
    // for the merge back into one JSON response.
    const campaign = await createCampaign({
      name: name.trim(),
      brand: brand.trim(),
      notes: typeof notes === "string" ? notes.trim() || null : null,
      notifyEmail: trimmedNotify || null,
      targetUrl: typeof targetUrl === "string" ? targetUrl.trim() || null : null,
      hiddenParamKey:
        typeof hiddenParamKey === "string" && hiddenParamKey.trim()
          ? hiddenParamKey.trim()
          : "_from",
      // Omitted → the column default (local_payment) applies, so a client that
      // predates this field creates a campaign that behaves exactly as before.
      ...(isPostAcceptanceMode(postAcceptanceMode) ? { postAcceptanceMode } : {}),
      ...sendingSettings.value,
      // PLU-121: the chosen default sender. Omitted → null → enrollment falls back
      // to the default connected account.
      ...(trimmedAccountId ? { emailAccountId: trimmedAccountId } : {}),
    });
    const details = await upsertCampaignDetails(campaign.id, {
      objective: typeof objective === "string" ? objective.trim() || null : null,
      brandDescription: typeof brandDescription === "string" ? brandDescription.trim() || null : null,
      deliverables: typeof deliverables === "string" ? deliverables.trim() || null : null,
      timeline: typeof timeline === "string" ? timeline.trim() || null : null,
      productOrOffer:
        typeof rewardDescription === "string" ? rewardDescription.trim() || null : null,
      shipsPhysicalProduct: shipsPhysicalProduct === true,
      // HARD-K1 knowledge fields — stated as fact by the agent when the creator
      // asks, deferred honestly when blank.
      usageRights: typeof usageRights === "string" ? usageRights.trim() || null : null,
      exclusivity: typeof exclusivity === "string" ? exclusivity.trim() || null : null,
      publicPaymentTerms:
        typeof paymentTerms === "string" ? paymentTerms.trim() || null : null,
      attributionWindow:
        typeof attributionWindow === "string" ? attributionWindow.trim() || null : null,
      // PLU-136 compensation contract — omitted fields fall back to their
      // column defaults (campaignType: PAID, includesGifting: false,
      // compensationReviewStatus: NEEDS_REVIEW).
      ...(isCampaignType(campaignType) ? { campaignType } : {}),
      includesGifting: includesGifting === true,
      ...(isGiftDisposition(giftDisposition) ? { giftDisposition } : {}),
      ...(isPriceStrategy(priceStrategy) ? { priceStrategy } : {}),
      publicStartingFeeCents:
        typeof publicStartingFeeCents === "number" ? publicStartingFeeCents : null,
      publicCommissionRate:
        typeof publicCommissionRate === "number" ? publicCommissionRate : null,
      commissionDurationDays:
        typeof commissionDurationDays === "number" ? commissionDurationDays : null,
      commissionConditions:
        typeof commissionConditions === "string" ? commissionConditions.trim() || null : null,
      ...(isCompensationReviewStatus(compensationReviewStatus)
        ? { compensationReviewStatus }
        : {}),
    });
    res.status(201).json({
      ...flattenCampaign(campaign, details),
      targetUrl: campaign.targetUrl,
      hiddenParamKey: campaign.hiddenParamKey,
      postAcceptanceMode: campaign.postAcceptanceMode,
      dailyInitialOutreachLimit: campaign.dailyInitialOutreachLimit,
      outreachPacingMinMinutes: campaign.outreachPacingMinMinutes,
      outreachPacingMaxMinutes: campaign.outreachPacingMaxMinutes,
      negotiationReplyPacingMinMinutes: campaign.negotiationReplyPacingMinMinutes,
      negotiationReplyPacingMaxMinutes: campaign.negotiationReplyPacingMaxMinutes,
      emailAccountId: campaign.emailAccountId,
      createdAt: campaign.createdAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] create error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// GET /campaigns/:id — campaign detail with workflows
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await getCampaignWithWorkflows(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const details = await getCampaignDetails(campaign.id);
    res.json({
      ...flattenCampaign(campaign, details),
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
      workflows: campaign.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        versionCount: w._count.versions,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[campaigns] get error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /campaigns/:id/workflows — create a workflow under a campaign
router.post("/:id/workflows", async (req: Request, res: Response) => {
  const { name, templateKey } = req.body as {
    name?: string;
    templateKey?: string;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!templateKey || typeof templateKey !== "string") {
    res.status(400).json({ error: "templateKey is required" });
    return;
  }

  const template = getTemplate(templateKey);
  if (!template) {
    res.status(400).json({
      error: `unknown templateKey '${templateKey}'. Valid keys: affiliate, hybrid, fixed_fee`,
    });
    return;
  }

  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const details = await getCampaignDetails(campaign.id);

    // Stamp brandName/senderName into every node's config so {{brandName}}
    // resolves correctly when draft() is called at send time.
    // PLU-137/138: deliverables/timeline/rewardDescription (productOrOffer) are
    // material campaign terms — REMOVED from this stamp. CampaignTermsSnapshot
    // is authoritative for them on read (effectiveTerms.ts); stamping them here
    // would only recreate the stale competing copy the cutover removes.
    const nodes = (JSON.parse(JSON.stringify(template.nodes)) as typeof template.nodes).map(
      (node) => ({
        ...node,
        config: {
          brandName: campaign.brand,
          senderName: campaign.brand,
          ...(details?.brandDescription ? { brandDescription: details.brandDescription } : {}),
          ...(details?.shipsPhysicalProduct ? { shipsPhysicalProduct: true } : {}),
          ...node.config,
        },
      }),
    );

    const workflow = await createWorkflow({
      name: name.trim(),
      status: "DRAFT",
      draftNodes: nodes,
      campaignId: campaign.id,
    });

    res.status(201).json({
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      campaignId: workflow.campaignId,
      templateKey,
      draftNodes: workflow.draftNodes,
      createdAt: workflow.createdAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] create workflow error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PATCH /campaigns/:id — update editable campaign fields (notifyEmail, etc.)
router.patch("/:id", async (req: Request, res: Response) => {
  const {
    name,
    brand,
    notifyEmail,
    objective,
    notes,
    brandDescription,
    deliverables,
    timeline,
    rewardDescription,
    shipsPhysicalProduct,
    postAcceptanceMode,
    emailAccountId,
    campaignType,
    includesGifting,
    giftDisposition,
    priceStrategy,
    publicStartingFeeCents,
    publicCommissionRate,
    commissionDurationDays,
    commissionConditions,
    compensationReviewStatus,
    paymentTerms,
    attributionWindow,
    keyMessages,
    contentRequirements,
    // PLU-139 (2a): worksheet Stage-1 fields.
    productName,
    productType,
    creatorAccessNeeded,
    uniqueSellingPoints,
    whyTrust,
    howToUse,
    brandAssets,
    brandMaterialsRef,
    deliverableQuantities,
    deliverablePricing,
    followerRanges,
    fieldProvenance,
    briefDeliveryMethod,
    briefHighlight,
    creativeConcept,
    referenceVideos,
    scriptSubmission,
    adAuthorization,
    linkInBioDuration,
    postRetention,
    instagramCollab,
    requireApproval,
    commissionMode,
    variableCommission,
    giftDeliveryMethod,
    promoCode,
    giftContactEmail,
    requiresShippingInfo,
    affiliateTrackingUrl,
    trackingLinkMode,
    trackingDestinationUrl,
    trackingParameter,
  } = req.body as {
    name?: string;
    brand?: string;
    notifyEmail?: string | null;
    objective?: string | null;
    notes?: string | null;
    brandDescription?: string | null;
    deliverables?: string | null;
    timeline?: string | null;
    rewardDescription?: string | null;
    shipsPhysicalProduct?: boolean;
    postAcceptanceMode?: string;
    emailAccountId?: string | null;
    // PLU-136 compensation contract fields.
    campaignType?: string;
    includesGifting?: boolean;
    giftDisposition?: string | null;
    priceStrategy?: string | null;
    publicStartingFeeCents?: number | null;
    publicCommissionRate?: number | null;
    commissionDurationDays?: number | null;
    commissionConditions?: string | null;
    compensationReviewStatus?: string;
    // Public offer fields the create path already accepts but PATCH did not,
    // so the sectioned intake (PATCH-based autosave) could never edit them.
    paymentTerms?: string | null;
    attributionWindow?: string | null;
    keyMessages?: string | null;
    // CampaignDetails column that existed but had no read/write path at all
    // (not in flatten/create/PATCH) — the last unreachable content field.
    contentRequirements?: string | null;
    // PLU-139 (2a): worksheet Stage-1 fields.
    productName?: string | null;
    productType?: string | null;
    creatorAccessNeeded?: boolean | null;
    uniqueSellingPoints?: string | null;
    whyTrust?: string | null;
    howToUse?: string | null;
    brandAssets?: string | null;
    brandMaterialsRef?: string | null;
    deliverableQuantities?: unknown;
    deliverablePricing?: unknown;
    followerRanges?: unknown;
    fieldProvenance?: unknown;
    briefDeliveryMethod?: string | null;
    briefHighlight?: string | null;
    creativeConcept?: string | null;
    referenceVideos?: string | null;
    scriptSubmission?: string | null;
    adAuthorization?: string | null;
    linkInBioDuration?: string | null;
    postRetention?: string | null;
    instagramCollab?: boolean | null;
    requireApproval?: boolean | null;
    commissionMode?: string | null;
    variableCommission?: string | null;
    giftDeliveryMethod?: string | null;
    promoCode?: string | null;
    giftContactEmail?: string | null;
    requiresShippingInfo?: boolean | null;
    affiliateTrackingUrl?: string | null;
    trackingLinkMode?: string | null;
    trackingDestinationUrl?: string | null;
    trackingParameter?: string | null;
  };

  const patch: Parameters<typeof updateCampaign>[1] = {};
  // PLU-135 (1a): the creator-facing fields below now live in CampaignDetails,
  // patched separately from the Campaign row itself.
  const detailsPatch: Parameters<typeof upsertCampaignDetails>[1] = {};

  const sendingSettings = validatePatchSendingSettings(
    req.body as Record<string, unknown>,
  );
  if (!sendingSettings.valid) {
    res.status(400).json({ error: sendingSettings.error });
    return;
  }
  Object.assign(patch, sendingSettings.value);

  // name/brand are editable in the intake's first section (PLU-139). Both are
  // launch-hard, so when present they must be non-blank — reject rather than
  // null them (a blank name/brand can't be a valid campaign).
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    patch.name = name.trim();
  }
  if (brand !== undefined) {
    if (typeof brand !== "string" || !brand.trim()) {
      res.status(400).json({ error: "brand must be a non-empty string" });
      return;
    }
    patch.brand = brand.trim();
  }

  if (notifyEmail !== undefined) {
    const trimmed = typeof notifyEmail === "string" ? notifyEmail.trim() : "";
    if (trimmed && !isEmailish(trimmed)) {
      res.status(400).json({ error: "notifyEmail must be a valid email address" });
      return;
    }
    patch.notifyEmail = trimmed || null;
  }
  if (objective !== undefined) {
    detailsPatch.objective = typeof objective === "string" ? objective.trim() || null : null;
  }
  if (notes !== undefined) {
    patch.notes = typeof notes === "string" ? notes.trim() || null : null;
  }
  if (brandDescription !== undefined) {
    detailsPatch.brandDescription =
      typeof brandDescription === "string" ? brandDescription.trim() || null : null;
  }
  if (deliverables !== undefined) {
    detailsPatch.deliverables =
      typeof deliverables === "string" ? deliverables.trim() || null : null;
  }
  if (timeline !== undefined) {
    detailsPatch.timeline = typeof timeline === "string" ? timeline.trim() || null : null;
  }
  if (rewardDescription !== undefined) {
    detailsPatch.productOrOffer =
      typeof rewardDescription === "string" ? rewardDescription.trim() || null : null;
  }
  if (shipsPhysicalProduct !== undefined) {
    detailsPatch.shipsPhysicalProduct = shipsPhysicalProduct === true;
  }
  if (postAcceptanceMode !== undefined) {
    if (!isPostAcceptanceMode(postAcceptanceMode)) {
      res.status(400).json({
        error: `postAcceptanceMode must be one of: ${POST_ACCEPTANCE_MODES.join(", ")}`,
      });
      return;
    }
    // Changing this affects the default for FUTURE enrollments only. Executions
    // already running carry their own stamped mode and are untouched.
    patch.postAcceptanceMode = postAcceptanceMode;
  }

  // PLU-136 compensation contract fields — all live on CampaignDetails, same
  // reject-unrecognized-value-loudly posture as postAcceptanceMode above.
  // NOTE: once a campaign is ACTIVE these all get rejected downstream by
  // CampaignLockedError (upsertCampaignDetails) exactly like every other
  // CampaignDetails field — no special-casing needed here.
  if (campaignType !== undefined) {
    if (!isCampaignType(campaignType)) {
      res.status(400).json({ error: `campaignType must be one of: ${CAMPAIGN_TYPES.join(", ")}` });
      return;
    }
    detailsPatch.campaignType = campaignType;
  }
  if (includesGifting !== undefined) {
    detailsPatch.includesGifting = includesGifting === true;
  }
  if (giftDisposition !== undefined) {
    if (giftDisposition !== null && !isGiftDisposition(giftDisposition)) {
      res.status(400).json({
        error: `giftDisposition must be one of: ${GIFT_DISPOSITIONS.join(", ")}`,
      });
      return;
    }
    detailsPatch.giftDisposition = giftDisposition;
  }
  if (priceStrategy !== undefined) {
    if (priceStrategy !== null && !isPriceStrategy(priceStrategy)) {
      res.status(400).json({
        error: `priceStrategy must be one of: ${PRICE_STRATEGIES.join(", ")}`,
      });
      return;
    }
    detailsPatch.priceStrategy = priceStrategy;
  }
  if (publicStartingFeeCents !== undefined) {
    detailsPatch.publicStartingFeeCents = publicStartingFeeCents;
  }
  if (publicCommissionRate !== undefined) {
    detailsPatch.publicCommissionRate = publicCommissionRate;
  }
  if (commissionDurationDays !== undefined) {
    detailsPatch.commissionDurationDays = commissionDurationDays;
  }
  if (commissionConditions !== undefined) {
    detailsPatch.commissionConditions =
      typeof commissionConditions === "string" ? commissionConditions.trim() || null : null;
  }
  if (paymentTerms !== undefined) {
    detailsPatch.publicPaymentTerms =
      typeof paymentTerms === "string" ? paymentTerms.trim() || null : null;
  }
  if (attributionWindow !== undefined) {
    detailsPatch.attributionWindow =
      typeof attributionWindow === "string" ? attributionWindow.trim() || null : null;
  }
  if (keyMessages !== undefined) {
    detailsPatch.keyMessages =
      typeof keyMessages === "string" ? keyMessages.trim() || null : null;
  }
  if (contentRequirements !== undefined) {
    detailsPatch.contentRequirements =
      typeof contentRequirements === "string" ? contentRequirements.trim() || null : null;
  }

  // PLU-139 (2a): worksheet Stage-1 fields. Plain free-text and boolean columns
  // (closed-set values are validated in the UI pre-PLU-159; the server accepts
  // any string so PLU-159 can change the option sets without a server change).
  // Each is applied only when present, and trimmed/coerced-to-null like every
  // other CampaignDetails field.
  const trimToNull = (v: unknown): string | null =>
    typeof v === "string" ? v.trim() || null : null;
  const boolOrNull = (v: unknown): boolean | null =>
    typeof v === "boolean" ? v : null;
  const stringFields139 = {
    productName,
    productType,
    uniqueSellingPoints,
    whyTrust,
    howToUse,
    brandAssets,
    brandMaterialsRef,
    briefDeliveryMethod,
    briefHighlight,
    creativeConcept,
    referenceVideos,
    scriptSubmission,
    adAuthorization,
    linkInBioDuration,
    postRetention,
    commissionMode,
    variableCommission,
    giftDeliveryMethod,
    promoCode,
    giftContactEmail,
    affiliateTrackingUrl,
    trackingLinkMode,
    trackingDestinationUrl,
    trackingParameter,
  } as const;
  for (const [key, value] of Object.entries(stringFields139)) {
    if (value !== undefined) {
      (detailsPatch as Record<string, unknown>)[key] = trimToNull(value);
    }
  }
  const boolFields139 = {
    creatorAccessNeeded,
    instagramCollab,
    requireApproval,
    requiresShippingInfo,
  } as const;
  for (const [key, value] of Object.entries(boolFields139)) {
    if (value !== undefined) {
      (detailsPatch as Record<string, unknown>)[key] = boolOrNull(value);
    }
  }
  // Review fix: populated below when deliverableQuantities normalization
  // actually mints a new id for a legacy row — used to keep deliverablePricing
  // (S7.P1, keyed by the SAME legacy composite key) from orphaning.
  let legacyDeliverableKeyToId = new Map<string, string>();
  if (deliverableQuantities !== undefined) {
    // PLU-169 (1f): full structural + platform/format-combination validation
    // at the trust boundary (deliverablesValidator.ts) — replaces the old
    // bare "is an array" check now that this field has a real downstream
    // consumer (FinalAgreement.finalDeliverables). null clears the field;
    // an empty array is valid (a campaign can have zero deliverables
    // recorded yet).
    //
    // Review fix: a campaign can still hold deliverableQuantities rows
    // created before `id` was required (the one-time backfill script fixes
    // these in bulk, but nothing guarantees it has run for THIS campaign
    // yet). The intake resends the complete array on every group-level PATCH
    // — including an edit to a totally unrelated field — so validating the
    // raw input rejected any legacy, not-yet-backfilled campaign with a 400
    // until an operator ran the backfill. Normalize legacy rows BEFORE
    // validating, and persist the NORMALIZED array (not the raw input) so
    // the fix becomes stable from this save forward — this campaign
    // incrementally self-heals the first time anyone happens to save it,
    // without waiting on the separate backfill script.
    //
    // Review fix (round 2): the id mint alone wasn't enough — a legacy row
    // predating the CLOSED platform/format catalog (a free-form platform
    // string, an unsupported platform/format pairing) or carrying a zero/
    // missing quantity still failed `deliverablesSchema` after the id fix,
    // 400ing the exact same "unrelated edit to an old campaign" case for a
    // different reason. normalizeLegacyDeliverables now migrates those too
    // (see its own doc comment for exactly what "migrate" means for each).
    //
    // Review fix (round 3): the two fixes above normalized EVERY submitted
    // item unconditionally — with no way to tell "a pre-existing legacy row
    // this save is just carrying forward unchanged" from "a row THIS request
    // is introducing or editing right now." That let a genuinely fresh,
    // malformed submission (e.g. a bare `[{}]`, or a real row with
    // `quantity: 0`) get silently coerced into a fabricated valid deliverable
    // (an "other"/"other" slot, or quantity forced to 1) and saved with a 200
    // instead of rejected with a 400 — inventing a creator obligation the
    // brand never actually specified, which then flows into
    // FinalAgreement/Content Brief as if it were real. resolveDeliverableSave
    // normalizes ONLY an item that is byte-for-byte identical
    // (order-independent) to something already stored for this campaign;
    // every other item — new, edited, or malformed — is validated AS
    // SUBMITTED, strictly, with no coercion.
    let normalizedDeliverables: JsonValue | null = deliverableQuantities as JsonValue | null;
    if (deliverableQuantities !== null) {
      if (!Array.isArray(deliverableQuantities)) {
        res.status(400).json({ error: "deliverableQuantities must be an array or null" });
        return;
      }
      const existingDetails = await getCampaignDetails(req.params["id"]!);
      const existingItems = Array.isArray(existingDetails?.deliverableQuantities)
        ? (existingDetails!.deliverableQuantities as unknown[])
        : [];
      const saveResult = resolveDeliverableSave(deliverableQuantities, existingItems);
      if (!saveResult.ok) {
        res.status(400).json({ error: `deliverableQuantities: ${saveResult.error}` });
        return;
      }
      legacyDeliverableKeyToId = saveResult.legacyKeyToId;
      normalizedDeliverables = saveResult.deliverables as unknown as JsonValue;
    }
    (detailsPatch as Record<string, unknown>)["deliverableQuantities"] = normalizedDeliverables;
  }

  // S7.P1 pricing map — keyed by deliverable id (or, for a legacy row not yet
  // normalized, the "<platform>:<format>" composite — see PricingGrid's own
  // `keyOf` fallback). Review fix: if THIS save just minted new ids for
  // legacy deliverableQuantities rows above, remap any pricing entry still
  // keyed by the OLD composite onto the new id before persisting — otherwise
  // that row's price displays blank (PricingGrid looks it up by the row's
  // current id) and a subsequent edit writes a fresh entry under the new id
  // while the old one sits orphaned forever.
  if (deliverablePricing !== undefined) {
    if (
      deliverablePricing !== null &&
      (typeof deliverablePricing !== "object" || Array.isArray(deliverablePricing))
    ) {
      res.status(400).json({ error: "deliverablePricing must be an object or null" });
      return;
    }
    (detailsPatch as Record<string, unknown>)["deliverablePricing"] =
      deliverablePricing === null
        ? null
        : (remapLegacyDeliverablePricingKeys(deliverablePricing, legacyDeliverableKeyToId) as JsonValue);
  } else if (legacyDeliverableKeyToId.size > 0) {
    // deliverablePricing wasn't part of THIS patch, but ids were just minted
    // for legacy deliverableQuantities rows — the EXISTING stored pricing map
    // (if any) would otherwise go stale the moment this save commits, with no
    // further save guaranteed to ever touch it again. Load and remap it too.
    const existingDetails = await getCampaignDetails(req.params["id"]!);
    if (existingDetails?.deliverablePricing) {
      (detailsPatch as Record<string, unknown>)["deliverablePricing"] = remapLegacyDeliverablePricingKeys(
        existingDetails.deliverablePricing,
        legacyDeliverableKeyToId,
      ) as JsonValue;
    }
  }

  // S3.11 follower-ranges map / field provenance — plain JSON objects, no
  // deliverable-id concerns. Accept an object or null; reject arrays/scalars
  // at the trust boundary.
  const jsonObjectFields139 = { followerRanges, fieldProvenance } as const;
  for (const [key, value] of Object.entries(jsonObjectFields139)) {
    if (value === undefined) continue;
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      res.status(400).json({ error: `${key} must be an object or null` });
      return;
    }
    (detailsPatch as Record<string, unknown>)[key] = value as JsonValue | null;
  }

  if (compensationReviewStatus !== undefined) {
    if (!isCompensationReviewStatus(compensationReviewStatus)) {
      res.status(400).json({
        error: `compensationReviewStatus must be one of: ${COMPENSATION_REVIEW_STATUSES.join(", ")}`,
      });
      return;
    }
    detailsPatch.compensationReviewStatus = compensationReviewStatus;
  }

  try {
    if (emailAccountId !== undefined) {
      // PLU-121: null/"" clears the default sender (back to the default account);
      // a non-empty value must reference a real, active connected account. Like
      // the mode, this changes only FUTURE enrollments — running instances keep
      // their pin.
      const trimmed = typeof emailAccountId === "string" ? emailAccountId.trim() : "";
      if (trimmed) {
        const account = await findEmailAccountById(trimmed);
        if (!account || account.status !== "active") {
          res.status(400).json({
            error: "emailAccountId must reference an active connected account",
          });
          return;
        }
        patch.emailAccountId = trimmed;
      } else {
        patch.emailAccountId = null;
      }
    }

    const existing = await findCampaignById(req.params["id"]!);
    if (!existing) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const campaign =
      Object.keys(patch).length > 0
        ? await updateCampaign(req.params["id"]!, patch)
        : existing;
    const details =
      Object.keys(detailsPatch).length > 0
        ? await upsertCampaignDetails(req.params["id"]!, detailsPatch)
        : await getCampaignDetails(req.params["id"]!);
    res.json({
      ...flattenCampaign(campaign, details),
      updatedAt: campaign.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof CampaignLockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[campaigns] update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PLU-136 gap fix: upsertNegotiationPolicy (db/negotiationPolicy.ts) had zero
// callers anywhere in the codebase — nothing could ever set floor/ceiling/
// commission bounds or the nonNegotiableTerms marker
// validateCompensationReadiness()'s "explicitly marked non-negotiable"
// branch depends on (db/campaigns.ts), making that branch permanently dead
// code: a brand offering "$500, non-negotiable, no range" had no way to
// express that and was forced to fake floorCents=ceilingCents=50000 instead.
// This is NOT a negotiation-policy editor UI (that's still 1c/1d's job,
// same posture as everywhere else in this codebase) — just the missing API
// seam so the marker (and the rest of the policy) can actually be written.
const NON_NEGOTIABLE_CATEGORIES = ["fee", "commission", "gift"] as const;
function isValidCategoryList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        typeof x === "string" &&
        (NON_NEGOTIABLE_CATEGORIES as readonly string[]).includes(x.toLowerCase()),
    )
  );
}

// GET /campaigns/:id/negotiation-policy — the private negotiation bounds.
router.get("/:id/negotiation-policy", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const policy = await getNegotiationPolicy(req.params["id"]!);
    if (!policy) {
      res.status(404).json({ error: "no NegotiationPolicy set for this campaign yet" });
      return;
    }
    res.json({
      ...policy,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] get negotiation policy error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PATCH /campaigns/:id/negotiation-policy — insert-or-update the one
// NegotiationPolicy row a campaign owns. Locked (409) once ACTIVE, same as
// CampaignDetails — an in-flight negotiation must never see its bounds
// change mid-conversation.
router.patch("/:id/negotiation-policy", async (req: Request, res: Response) => {
  const {
    floorCents,
    ceilingCents,
    preferredFeeCents,
    commissionFloorRate,
    commissionCeilingRate,
    preferredCommissionRate,
    maxRounds,
    openingOfferPosition,
    overCeilingTolerance,
    negotiationGuidance,
    giftSubstitutionAllowed,
    giftValueFlexibilityCents,
    negotiableTerms,
    nonNegotiableTerms,
    // PLU-172 — Page-8 negotiation-authority fields.
    feeMode,
    commissionNegotiationMode,
    commissionCeilingAmountCents,
    commissionDurationMode,
    commissionDurationLimitValue,
    commissionDurationLimitUnit,
    giftSubstitutionMode,
    giftApprovedSubstitutes,
    giftCashReplacementMode,
    giftCashReplacementLimitCents,
    deliverableNegotiationMode,
    deliverablePolicyRules,
    postingNegotiationMode,
    postingMaxDelayDays,
    rightsPolicyRules,
    scriptWaiverMode,
    outOfPolicyAction,
  } = req.body as {
    floorCents?: number | null;
    ceilingCents?: number | null;
    preferredFeeCents?: number | null;
    commissionFloorRate?: number | null;
    commissionCeilingRate?: number | null;
    preferredCommissionRate?: number | null;
    maxRounds?: number | null;
    openingOfferPosition?: number | null;
    overCeilingTolerance?: number | null;
    negotiationGuidance?: string | null;
    giftSubstitutionAllowed?: boolean | null;
    giftValueFlexibilityCents?: number | null;
    negotiableTerms?: unknown;
    nonNegotiableTerms?: unknown;
    feeMode?: string;
    commissionNegotiationMode?: string;
    commissionCeilingAmountCents?: number | null;
    commissionDurationMode?: string;
    commissionDurationLimitValue?: number | null;
    commissionDurationLimitUnit?: string | null;
    giftSubstitutionMode?: string;
    giftApprovedSubstitutes?: unknown;
    giftCashReplacementMode?: string;
    giftCashReplacementLimitCents?: number | null;
    deliverableNegotiationMode?: string;
    deliverablePolicyRules?: unknown;
    postingNegotiationMode?: string;
    postingMaxDelayDays?: number | null;
    rightsPolicyRules?: unknown;
    scriptWaiverMode?: string;
    outOfPolicyAction?: string;
  };

  // negotiableTerms/nonNegotiableTerms follow the category-list convention
  // validateCompensationReadiness() reads (db/campaigns.ts,
  // isMarkedNonNegotiable): an array of "fee"|"commission"|"gift". Reject
  // anything else loudly rather than silently storing a shape the readiness
  // check can never recognize.
  if (
    negotiableTerms !== undefined &&
    negotiableTerms !== null &&
    !isValidCategoryList(negotiableTerms)
  ) {
    res.status(400).json({
      error: `negotiableTerms must be an array of: ${NON_NEGOTIABLE_CATEGORIES.join(", ")}`,
    });
    return;
  }
  if (
    nonNegotiableTerms !== undefined &&
    nonNegotiableTerms !== null &&
    !isValidCategoryList(nonNegotiableTerms)
  ) {
    res.status(400).json({
      error: `nonNegotiableTerms must be an array of: ${NON_NEGOTIABLE_CATEGORIES.join(", ")}`,
    });
    return;
  }

  // PLU-172 — mode enums: reject-unrecognized-value-loudly, same posture as
  // campaignType/priceStrategy above.
  if (feeMode !== undefined && !isFeeNegotiationMode(feeMode)) {
    negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", `feeMode must be one of: ${FEE_NEGOTIATION_MODES.join(", ")}`);
    return;
  }
  if (commissionNegotiationMode !== undefined && !isCommissionNegotiationMode(commissionNegotiationMode)) {
    negotiationPolicyValidationError(
      res,
      "INVALID_FIELD_VALUE",
      `commissionNegotiationMode must be one of: ${COMMISSION_NEGOTIATION_MODES.join(", ")}`,
    );
    return;
  }
  if (commissionDurationMode !== undefined && !isCommissionDurationMode(commissionDurationMode)) {
    negotiationPolicyValidationError(
      res,
      "INVALID_FIELD_VALUE",
      `commissionDurationMode must be one of: ${COMMISSION_DURATION_MODES.join(", ")}`,
    );
    return;
  }
  if (
    commissionDurationLimitUnit !== undefined &&
    commissionDurationLimitUnit !== null &&
    !isDurationUnit(commissionDurationLimitUnit)
  ) {
    negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", `commissionDurationLimitUnit must be one of: ${DURATION_UNITS.join(", ")}`);
    return;
  }
  if (giftSubstitutionMode !== undefined && !isGiftSubstitutionMode(giftSubstitutionMode)) {
    negotiationPolicyValidationError(
      res,
      "INVALID_FIELD_VALUE",
      `giftSubstitutionMode must be one of: ${GIFT_SUBSTITUTION_MODES.join(", ")}`,
    );
    return;
  }
  if (giftCashReplacementMode !== undefined && !isGiftCashReplacementMode(giftCashReplacementMode)) {
    negotiationPolicyValidationError(
      res,
      "INVALID_FIELD_VALUE",
      `giftCashReplacementMode must be one of: ${GIFT_CASH_REPLACEMENT_MODES.join(", ")}`,
    );
    return;
  }
  if (deliverableNegotiationMode !== undefined && !isDeliverableNegotiationMode(deliverableNegotiationMode)) {
    negotiationPolicyValidationError(
      res,
      "INVALID_FIELD_VALUE",
      `deliverableNegotiationMode must be one of: ${DELIVERABLE_NEGOTIATION_MODES.join(", ")}`,
    );
    return;
  }
  if (postingNegotiationMode !== undefined && !isPostingNegotiationMode(postingNegotiationMode)) {
    negotiationPolicyValidationError(
      res,
      "INVALID_FIELD_VALUE",
      `postingNegotiationMode must be one of: ${POSTING_NEGOTIATION_MODES.join(", ")}`,
    );
    return;
  }
  if (outOfPolicyAction !== undefined && !isOutOfPolicyAction(outOfPolicyAction)) {
    negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", `outOfPolicyAction must be one of: ${OUT_OF_POLICY_ACTIONS.join(", ")}`);
    return;
  }
  // Calvin review (item 9): its own dedicated mode — NOT rightsNegotiationModeEnum.
  if (scriptWaiverMode !== undefined && !isScriptWaiverMode(scriptWaiverMode)) {
    negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", `scriptWaiverMode must be one of: ${SCRIPT_WAIVER_MODES.join(", ")}`);
    return;
  }

  // PLU-172 — the two validated rule arrays + the free-text substitute list.
  if (giftApprovedSubstitutes !== undefined && !isStringArrayOrNull(giftApprovedSubstitutes)) {
    negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", "giftApprovedSubstitutes must be an array of strings or null");
    return;
  }
  if (deliverablePolicyRules !== undefined && deliverablePolicyRules !== null) {
    const result = validateDeliverablePolicyRules(deliverablePolicyRules);
    if (!result.ok) {
      negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", `deliverablePolicyRules: ${result.error}`);
      return;
    }
  }
  if (rightsPolicyRules !== undefined && rightsPolicyRules !== null) {
    const result = validateRightsPolicyRules(rightsPolicyRules);
    if (!result.ok) {
      negotiationPolicyValidationError(res, "INVALID_FIELD_VALUE", `rightsPolicyRules: ${result.error}`);
      return;
    }
  }

  // floorCents/ceilingCents/preferredFeeCents/maxRounds/giftValueFlexibilityCents
  // back PostgreSQL `integer` (int4) columns: a value outside int4 range passes
  // this route's `number`-typed destructure above but overflows at
  // INSERT/UPDATE (SQLSTATE 22003), which the catch-all below would turn into
  // a 500 instead of a 400. Same int4 guard as minFollowers on
  // /:id/creator-requirement, generalized into validateInt4.
  if (floorCents !== undefined && floorCents !== null && !validateInt4(floorCents, "floorCents", res)) {
    return;
  }
  if (
    ceilingCents !== undefined &&
    ceilingCents !== null &&
    !validateInt4(ceilingCents, "ceilingCents", res)
  ) {
    return;
  }
  if (
    preferredFeeCents !== undefined &&
    preferredFeeCents !== null &&
    !validateInt4(preferredFeeCents, "preferredFeeCents", res)
  ) {
    return;
  }
  if (maxRounds !== undefined && maxRounds !== null && !validateInt4(maxRounds, "maxRounds", res)) {
    return;
  }
  if (
    giftValueFlexibilityCents !== undefined &&
    giftValueFlexibilityCents !== null &&
    !validateInt4(giftValueFlexibilityCents, "giftValueFlexibilityCents", res)
  ) {
    return;
  }
  if (
    commissionCeilingAmountCents !== undefined &&
    commissionCeilingAmountCents !== null &&
    !validateInt4(commissionCeilingAmountCents, "commissionCeilingAmountCents", res)
  ) {
    return;
  }
  if (
    commissionDurationLimitValue !== undefined &&
    commissionDurationLimitValue !== null &&
    !validateInt4(commissionDurationLimitValue, "commissionDurationLimitValue", res)
  ) {
    return;
  }
  if (
    postingMaxDelayDays !== undefined &&
    postingMaxDelayDays !== null &&
    !validateInt4(postingMaxDelayDays, "postingMaxDelayDays", res)
  ) {
    return;
  }
  if (
    giftCashReplacementLimitCents !== undefined &&
    giftCashReplacementLimitCents !== null &&
    !validateInt4(giftCashReplacementLimitCents, "giftCashReplacementLimitCents", res)
  ) {
    return;
  }

  // PLU-172 — cross-field validation against the public offer, and
  // write-time rejection of a limit whose mode doesn't authorize it (item
  // 9's "ideally reject the combination at write time too"). The actual
  // rules live in domain/negotiationPolicyValidation.ts (pure, unit-tested
  // there).
  //
  // Review fix ("policy validation is not atomic with its write"): this
  // used to read CampaignDetails/NegotiationPolicy and validate HERE, then
  // separately call upsertNegotiationPolicy — two steps with no lock held
  // across them, so two concurrent PATCHes could each validate against a
  // stale view of the OTHER's not-yet-committed change (e.g. one sets
  // feeMode=ALLOW_WITHIN_LIMIT, the other concurrently sets a ceilingCents
  // below the public fee — each looks valid in isolation against what it
  // read, both commit, the combination is invalid). The read + validate now
  // happens INSIDE db/negotiationPolicy.ts's upsertNegotiationPolicyValidated,
  // in the SAME transaction and behind the SAME Campaign-row lock as the
  // write itself — see that function's own doc comment for the full
  // reasoning. This route no longer validates before calling it; it just
  // builds the patch and lets the atomic function validate+write+throw.
  const patch: Parameters<typeof upsertNegotiationPolicy>[1] = {};
  if (floorCents !== undefined) patch.floorCents = floorCents;
  if (ceilingCents !== undefined) patch.ceilingCents = ceilingCents;
  if (preferredFeeCents !== undefined) patch.preferredFeeCents = preferredFeeCents;
  if (commissionFloorRate !== undefined) patch.commissionFloorRate = commissionFloorRate;
  if (commissionCeilingRate !== undefined) patch.commissionCeilingRate = commissionCeilingRate;
  if (preferredCommissionRate !== undefined) patch.preferredCommissionRate = preferredCommissionRate;
  if (maxRounds !== undefined) patch.maxRounds = maxRounds;
  if (openingOfferPosition !== undefined) patch.openingOfferPosition = openingOfferPosition;
  if (overCeilingTolerance !== undefined) patch.overCeilingTolerance = overCeilingTolerance;
  if (negotiationGuidance !== undefined) {
    patch.negotiationGuidance =
      typeof negotiationGuidance === "string" ? negotiationGuidance.trim() || null : null;
  }
  if (giftSubstitutionAllowed !== undefined) patch.giftSubstitutionAllowed = giftSubstitutionAllowed;
  if (giftValueFlexibilityCents !== undefined) {
    patch.giftValueFlexibilityCents = giftValueFlexibilityCents;
  }
  if (negotiableTerms !== undefined) patch.negotiableTerms = negotiableTerms as JsonValue | null;
  if (nonNegotiableTerms !== undefined) {
    patch.nonNegotiableTerms = nonNegotiableTerms as JsonValue | null;
  }

  // PLU-172 — already validated (enum guards + schema.safeParse + cross-field
  // checks) above; a straight assignment here, same convention as every
  // field above it.
  if (feeMode !== undefined) patch.feeMode = feeMode as (typeof FEE_NEGOTIATION_MODES)[number];
  if (commissionNegotiationMode !== undefined) {
    patch.commissionNegotiationMode = commissionNegotiationMode as (typeof COMMISSION_NEGOTIATION_MODES)[number];
  }
  if (commissionCeilingAmountCents !== undefined) patch.commissionCeilingAmountCents = commissionCeilingAmountCents;
  if (commissionDurationMode !== undefined) {
    patch.commissionDurationMode = commissionDurationMode as (typeof COMMISSION_DURATION_MODES)[number];
  }
  if (commissionDurationLimitValue !== undefined) patch.commissionDurationLimitValue = commissionDurationLimitValue;
  if (commissionDurationLimitUnit !== undefined) {
    patch.commissionDurationLimitUnit = commissionDurationLimitUnit as (typeof DURATION_UNITS)[number] | null;
  }
  if (giftSubstitutionMode !== undefined) {
    patch.giftSubstitutionMode = giftSubstitutionMode as (typeof GIFT_SUBSTITUTION_MODES)[number];
  }
  if (giftApprovedSubstitutes !== undefined) patch.giftApprovedSubstitutes = giftApprovedSubstitutes as JsonValue | null;
  if (giftCashReplacementMode !== undefined) {
    patch.giftCashReplacementMode = giftCashReplacementMode as (typeof GIFT_CASH_REPLACEMENT_MODES)[number];
  }
  if (giftCashReplacementLimitCents !== undefined) {
    patch.giftCashReplacementLimitCents = giftCashReplacementLimitCents;
  }
  if (deliverableNegotiationMode !== undefined) {
    patch.deliverableNegotiationMode = deliverableNegotiationMode as (typeof DELIVERABLE_NEGOTIATION_MODES)[number];
  }
  if (deliverablePolicyRules !== undefined) patch.deliverablePolicyRules = deliverablePolicyRules as JsonValue | null;
  if (postingNegotiationMode !== undefined) {
    patch.postingNegotiationMode = postingNegotiationMode as (typeof POSTING_NEGOTIATION_MODES)[number];
  }
  if (postingMaxDelayDays !== undefined) patch.postingMaxDelayDays = postingMaxDelayDays;
  if (rightsPolicyRules !== undefined) patch.rightsPolicyRules = rightsPolicyRules as JsonValue | null;
  if (scriptWaiverMode !== undefined) {
    patch.scriptWaiverMode = scriptWaiverMode as (typeof SCRIPT_WAIVER_MODES)[number];
  }
  if (outOfPolicyAction !== undefined) {
    patch.outOfPolicyAction = outOfPolicyAction as (typeof OUT_OF_POLICY_ACTIONS)[number];
  }

  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const policy = await upsertNegotiationPolicyValidated(req.params["id"]!, patch);
    res.json({
      ...policy,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof CampaignLockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof NegotiationPolicyValidationError) {
      negotiationPolicyValidationError(res, err.code, err.message);
      return;
    }
    console.error("[campaigns] update negotiation policy error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PLU-139 (2a): BrandIdentity + CreatorRequirement — the two remaining public
// intake sections PLU-135 created the tables for but left unwired. Same shape as
// the negotiation-policy pair above: a GET + a draft-only PATCH per table,
// upsert-on-unique-campaignId, locked (409) once the campaign is ACTIVE via the
// shared assertCampaignIsDraft guard (CampaignLockedError). CreatorRequirement is
// INFORMATIONAL only — nothing reads it into matching/ranking/outreach.

// GET /campaigns/:id/brand-identity — the brand's identity/branding for the campaign.
router.get("/:id/brand-identity", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const brandIdentity = await getBrandIdentity(req.params["id"]!);
    if (!brandIdentity) {
      res.status(404).json({ error: "no BrandIdentity set for this campaign yet" });
      return;
    }
    res.json({
      ...brandIdentity,
      extractedAt: brandIdentity.extractedAt?.toISOString() ?? null,
      createdAt: brandIdentity.createdAt.toISOString(),
      updatedAt: brandIdentity.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] get brand identity error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PATCH /campaigns/:id/brand-identity — insert-or-update the one BrandIdentity row.
router.patch("/:id/brand-identity", async (req: Request, res: Response) => {
  const { logoRef, primaryColor, secondaryColor, typography } = req.body as {
    logoRef?: string | null;
    primaryColor?: string | null;
    secondaryColor?: string | null;
    typography?: string | null;
  };

  const patch: Parameters<typeof upsertBrandIdentity>[1] = {};
  if (logoRef !== undefined) patch.logoRef = typeof logoRef === "string" ? logoRef.trim() || null : null;
  if (primaryColor !== undefined) {
    patch.primaryColor = typeof primaryColor === "string" ? primaryColor.trim() || null : null;
  }
  if (secondaryColor !== undefined) {
    patch.secondaryColor = typeof secondaryColor === "string" ? secondaryColor.trim() || null : null;
  }
  if (typography !== undefined) {
    patch.typography = typeof typography === "string" ? typography.trim() || null : null;
  }

  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const brandIdentity = await upsertBrandIdentity(req.params["id"]!, patch);
    res.json({
      ...brandIdentity,
      extractedAt: brandIdentity.extractedAt?.toISOString() ?? null,
      createdAt: brandIdentity.createdAt.toISOString(),
      updatedAt: brandIdentity.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof CampaignLockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[campaigns] update brand identity error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// GET /campaigns/:id/creator-requirement — informational creator-fit criteria.
router.get("/:id/creator-requirement", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const creatorRequirement = await getCreatorRequirement(req.params["id"]!);
    if (!creatorRequirement) {
      res.status(404).json({ error: "no CreatorRequirement set for this campaign yet" });
      return;
    }
    res.json({
      ...creatorRequirement,
      createdAt: creatorRequirement.createdAt.toISOString(),
      updatedAt: creatorRequirement.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] get creator requirement error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PATCH /campaigns/:id/creator-requirement — insert-or-update the one
// CreatorRequirement row. Lists (platforms/geography) are jsonb string[];
// validated as string arrays at the trust boundary. PLU-139 (B): only the
// worksheet-backed criteria remain — platforms (S3.1), geography (S3.10),
// minFollowers (S3.11). niches/languages/audienceNotes/contentStyle/brandSafety
// were legacy off-worksheet fields with no downstream reader in intake; the
// columns themselves stay (campaignBriefRender.ts still reads them), this
// route just no longer writes them.
router.patch("/:id/creator-requirement", async (req: Request, res: Response) => {
  const { platforms, geography, minFollowers } = req.body as {
    platforms?: unknown;
    geography?: unknown;
    minFollowers?: number | null;
  };

  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");

  const patch: Parameters<typeof upsertCreatorRequirement>[1] = {};
  for (const [key, value] of [
    ["platforms", platforms],
    ["geography", geography],
  ] as const) {
    if (value === undefined) continue;
    if (value !== null && !isStringArray(value)) {
      res.status(400).json({ error: `${key} must be an array of strings` });
      return;
    }
    patch[key] = (value as string[] | null) as JsonValue | null;
  }
  if (minFollowers !== undefined) {
    // minFollowers is `integer` (int4). validateInt4's [0, 2147483647] range
    // already encodes "can't be negative" (a follower count), so no separate
    // business-rule check is needed on top of it.
    if (minFollowers !== null && !validateInt4(minFollowers, "minFollowers", res)) return;
    patch.minFollowers = minFollowers;
  }

  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const creatorRequirement = await upsertCreatorRequirement(req.params["id"]!, patch);
    res.json({
      ...creatorRequirement,
      createdAt: creatorRequirement.createdAt.toISOString(),
      updatedAt: creatorRequirement.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof CampaignLockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[campaigns] update creator requirement error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Brief import / candidate extraction (PLU-139 2a)
// ---------------------------------------------------------------------------
// The IMPORT half of the sectioned intake: a brand uploads a brief PDF (via the
// shared POST /uploads route, which returns a reference), then POSTs that
// reference here. We parse it best-effort into a structured section map and
// store a CampaignBriefExtraction record — EVIDENCE, never authoritative. The
// intake then reads the latest record and shows its sections as CANDIDATES the
// brand confirms/edits/rejects into CampaignDetails through the normal PATCH.
// Nothing here writes CampaignDetails, so re-uploading never overwrites a
// confirmed value, and a failed/empty parse never blocks the manual path.

/** Best-effort parse of a stored PDF into flatText + a section map. Fail-soft:
 *  any transport/parse error yields an empty-but-valid result so the evidence
 *  record still stores and the brand falls back to manual entry — per the
 *  ticket's "OCR/extraction limitations must not block the manual path". */
async function parseBriefBestEffort(
  reference: string,
): Promise<{ flatText: string; sections: JsonValue; parserVersion: string }> {
  try {
    const bytes = await readStoredFile(reference);
    const data = (await agentPostJson(agentBaseUrl(), "/parse-brief", {
      pdfBase64: bytes.toString("base64"),
      parseMode: expectedBriefParseMode(),
    })) as Record<string, unknown>;
    const flatText = typeof data["text"] === "string" ? (data["text"] as string) : "";
    const sections = (data["sections"] ?? {}) as JsonValue;
    const parserVersion =
      typeof data["parserVersion"] === "string" && (data["parserVersion"] as string).trim()
        ? (data["parserVersion"] as string)
        : expectedParserVersion();
    return { flatText, sections, parserVersion };
  } catch (err) {
    console.warn(
      `[campaigns] brief parse failed for ${reference}, storing empty evidence: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { flatText: "", sections: {} as JsonValue, parserVersion: expectedParserVersion() };
  }
}

// POST /campaigns/:id/brief-extraction — parse an uploaded brief and store the
// candidate record. Body: { sourceFileReference } (from POST /uploads).
router.post("/:id/brief-extraction", async (req: Request, res: Response) => {
  const { sourceFileReference } = req.body as { sourceFileReference?: unknown };
  if (typeof sourceFileReference !== "string" || !sourceFileReference.trim()) {
    res.status(400).json({ error: "sourceFileReference is required" });
    return;
  }
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const parsed = await parseBriefBestEffort(sourceFileReference.trim());
    const record = await insertBriefExtraction(req.params["id"]!, {
      flatText: parsed.flatText,
      sections: parsed.sections,
      sourceFileReference: sourceFileReference.trim(),
      parserVersion: parsed.parserVersion,
    });
    res.status(201).json({ ...record, createdAt: record.createdAt.toISOString() });
  } catch (err) {
    if (err instanceof CampaignLockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[campaigns] create brief extraction error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// GET /campaigns/:id/brief-extraction — the latest stored extraction (candidates
// the brand can still review), or 404 when none has been uploaded yet.
router.get("/:id/brief-extraction", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const record = await getLatestBriefExtraction(req.params["id"]!);
    if (!record) {
      res.status(404).json({ error: "no brief extraction for this campaign yet" });
      return;
    }
    res.json({ ...record, createdAt: record.createdAt.toISOString() });
  } catch (err) {
    console.error("[campaigns] get brief extraction error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// GET /campaigns/:id/readiness — PLU-140 (2b): a read-only projection of the
// SAME preconditions launchCampaign() enforces, so the review page can show
// blockers up front instead of only discovering them via a failed POST /launch.
// Uses the identical existence + CONFIRMED + validateCompensationReadiness
// checks as launchCampaign (db/campaigns.ts) — one shared shape, so this can
// never report ready:true while POST /launch would 409/422.
// ponytail: recompute per request, cache if the review page ever polls it hot.
router.get("/:id/readiness", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const details = await getCampaignDetails(req.params["id"]!);
    const policy = await getNegotiationPolicy(req.params["id"]!);
    // computeReadiness (db/campaigns.ts) is the SINGLE source of the readiness
    // shape — it mirrors launchCampaign's preconditions exactly, so this can't
    // drift from what launch enforces.
    res.json(computeReadiness(details, policy));
  } catch (err) {
    console.error("[campaigns] readiness error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /campaigns/:id/launch — PLU-135 (1a): the ONE-WAY Draft → Active
// transition. Freezes the current CampaignDetails/NegotiationPolicy into
// CampaignTermsSnapshot/NegotiationPolicySnapshot and locks both read-only.
// Idempotent: launching an already-ACTIVE campaign returns its existing
// snapshot rather than erroring.
router.post("/:id/launch", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const snapshot = await launchCampaign(req.params["id"]!);
    res.json({
      campaignId: snapshot.campaignId,
      campaignTermsSnapshotId: snapshot.id,
      launchedAt: snapshot.launchedAt.toISOString(),
    });
  } catch (err) {
    // PLU-135 (1a) code-review fix (Ayush): launchCampaign()'s precondition
    // failures are real, actionable states — surface them as such instead of
    // collapsing every failure into an opaque 500.
    if (err instanceof CampaignNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof CampaignDetailsMissingError || err instanceof NegotiationPolicyMissingError) {
      res.status(422).json({ error: err.message });
      return;
    }
    // PLU-136: compensation-contract preconditions — same posture as the two
    // checks above (fix your campaign, then retry).
    if (err instanceof CompensationReviewPendingError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof CompensationIncompleteError) {
      res.status(422).json({ error: err.message, missing: err.missing });
      return;
    }
    console.error("[campaigns] launch error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /campaigns/:id/duplicate — PLU-136 (1b): the material-change path for
// an already-launched campaign. Copies the source's settings/details/policy/
// brand-identity/creator-requirement into a fresh DRAFT; copies no history
// (no snapshots, executions, or prior audit trail). See duplicateCampaign's
// doc comment (db/campaigns.ts) for the exact copy/exclude list.
router.post("/:id/duplicate", async (req: Request, res: Response) => {
  try {
    const source = await findCampaignById(req.params["id"]!);
    if (!source) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const duplicate = await duplicateCampaign(req.params["id"]!);
    const details = await getCampaignDetails(duplicate.id);
    res.status(201).json({
      ...flattenCampaign(duplicate, details),
      createdAt: duplicate.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof CampaignNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("[campaigns] duplicate error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// DELETE /campaigns/:id — delete a campaign and all its workflows/instances
// (or archive it, if already launched — see deleteCampaign's doc comment)
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    await deleteCampaign(req.params["id"]!);
    res.status(204).send();
  } catch (err) {
    console.error("[campaigns] delete error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
