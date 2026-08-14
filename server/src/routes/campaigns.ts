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
import { getNegotiationPolicy, upsertNegotiationPolicy } from "../db/negotiationPolicy.js";
import { getBrandIdentity, upsertBrandIdentity } from "../db/brandIdentity.js";
import {
  getCreatorRequirement,
  upsertCreatorRequirement,
} from "../db/creatorRequirement.js";
import {
  createWorkflow,
  updateWorkflow,
} from "../db/workflows.js";
import { findEmailAccountById } from "../db/emailAccounts.js";
import { getTemplate } from "../templates/index.js";
import { validateTargetUrl } from "../validation/targetUrl.js";
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
    const nodes = (JSON.parse(JSON.stringify(template.nodes)) as typeof template.nodes).map(
      (node) => ({
        ...node,
        config: {
          brandName: campaign.brand,
          senderName: campaign.brand,
          ...(details?.brandDescription ? { brandDescription: details.brandDescription } : {}),
          ...(details?.deliverables ? { deliverables: details.deliverables } : {}),
          ...(details?.timeline ? { timeline: details.timeline } : {}),
          ...(details?.productOrOffer ? { rewardDescription: details.productOrOffer } : {}),
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
  } = req.body as {
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

  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const policy = await upsertNegotiationPolicy(req.params["id"]!, patch);
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
// CreatorRequirement row. Lists (platforms/niches/geography/languages) are jsonb
// string[]; validated as string arrays at the trust boundary.
router.patch("/:id/creator-requirement", async (req: Request, res: Response) => {
  const {
    platforms,
    niches,
    geography,
    languages,
    minFollowers,
    audienceNotes,
    contentStyle,
    brandSafety,
  } = req.body as {
    platforms?: unknown;
    niches?: unknown;
    geography?: unknown;
    languages?: unknown;
    minFollowers?: number | null;
    audienceNotes?: string | null;
    contentStyle?: string | null;
    brandSafety?: string | null;
  };

  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");

  const patch: Parameters<typeof upsertCreatorRequirement>[1] = {};
  for (const [key, value] of [
    ["platforms", platforms],
    ["niches", niches],
    ["geography", geography],
    ["languages", languages],
  ] as const) {
    if (value === undefined) continue;
    if (value !== null && !isStringArray(value)) {
      res.status(400).json({ error: `${key} must be an array of strings` });
      return;
    }
    patch[key] = (value as string[] | null) as JsonValue | null;
  }
  if (minFollowers !== undefined) {
    // Upper bound = PostgreSQL int4 max: the minFollowers column is `integer`,
    // so a larger value overflows (SQLSTATE 22003) and the catch-all would 500
    // instead of rejecting bad input. No real follower count approaches 2.1B.
    if (
      minFollowers !== null &&
      (typeof minFollowers !== "number" ||
        !Number.isInteger(minFollowers) ||
        minFollowers < 0 ||
        minFollowers > 2147483647)
    ) {
      res.status(400).json({ error: "minFollowers must be an integer between 0 and 2147483647" });
      return;
    }
    patch.minFollowers = minFollowers;
  }
  if (audienceNotes !== undefined) {
    patch.audienceNotes = typeof audienceNotes === "string" ? audienceNotes.trim() || null : null;
  }
  if (contentStyle !== undefined) {
    patch.contentStyle = typeof contentStyle === "string" ? contentStyle.trim() || null : null;
  }
  if (brandSafety !== undefined) {
    patch.brandSafety = typeof brandSafety === "string" ? brandSafety.trim() || null : null;
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
