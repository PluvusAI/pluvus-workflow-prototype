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
  transitionCampaignToClosing,
  getCampaignClosingMetadata,
  getCampaignLifecycleCounts,
  CampaignNotFoundError,
  CampaignDetailsMissingError,
  NegotiationPolicyMissingError,
} from "../db/campaigns.js";
import {
  CampaignLockedError,
  getCampaignDetails,
  getCampaignDetailsByCampaignIds,
  upsertCampaignDetails,
} from "../db/campaignDetails.js";
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
import type { Campaign, CampaignDetails } from "../db/schema.js";

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
    // PLU-153: null = live; a CLOSING→ARCHIVED reconciliation (PLU-156) stamps it.
    archivedAt: campaign.archivedAt ? campaign.archivedAt.toISOString() : null,
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
    // PLU-153: lifecycle metadata for the Closing dashboard — who/when initiated
    // Closing (read off the CLOSING audit event) + coarse creator-journey counts.
    const [closing, counts] = await Promise.all([
      getCampaignClosingMetadata(campaign.id),
      getCampaignLifecycleCounts(campaign.id),
    ]);
    res.json({
      ...flattenCampaign(campaign, details),
      closingInitiatedAt: closing?.closingInitiatedAt ?? null,
      closingInitiatedBy: closing?.closingInitiatedBy ?? null,
      closingReason: closing?.closingReason ?? null,
      ...counts,
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
    console.error("[campaigns] launch error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /campaigns/:id/close — PLU-153: the intentional ACTIVE → CLOSING
// transition ("End campaign"). Stops new creator intake + initial outreach;
// existing creator journeys keep running. Idempotent: already-Closing → 200.
// archivedAt is NOT touched here (PLU-156 owns CLOSING → ARCHIVED).
router.post("/:id/close", async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: unknown };
  const cleanReason =
    typeof reason === "string" && reason.trim() ? reason.trim() : null;
  try {
    const result = await transitionCampaignToClosing(req.params["id"]!, {
      actorId: "operator",
      reason: cleanReason,
    });
    if (result === null) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    if (result.status === "invalid") {
      res.status(409).json({
        error: `cannot move a ${result.from.toLowerCase()} campaign to Closing; only an Active campaign can be closed`,
      });
      return;
    }
    // Both "closed" and "already_closing" → 200 with the current lifecycle.
    const details = await getCampaignDetails(result.campaign.id);
    res.json({
      ...flattenCampaign(result.campaign, details),
      updatedAt: result.campaign.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] close error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// DELETE /campaigns/:id — PLU-153: hard-delete gated by status. A DRAFT
// (unlaunched) campaign hard-deletes as before. A launched campaign (ACTIVE/
// CLOSING/ARCHIVED) is NOT deletable through the normal action — 409 telling
// the operator to use End campaign instead — UNLESS ?force=true is passed
// (reclone / dev-reset), which hard-deletes regardless of status. This route
// never sets archivedAt: ending a campaign uses POST /:id/close, and archival
// is PLU-156's job.
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const force = req.query["force"] === "true";
    if (campaign.status !== "DRAFT" && !force) {
      res.status(409).json({
        error:
          "cannot delete a launched campaign; use End campaign to move it to Closing (or pass ?force=true to hard-delete)",
      });
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
