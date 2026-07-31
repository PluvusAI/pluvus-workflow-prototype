import { Router } from "express";
import type { Request, Response } from "express";
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignWithWorkflows,
  findCampaignById,
  deleteCampaign,
} from "../db/campaigns.js";
import {
  createWorkflow,
  updateWorkflow,
} from "../db/workflows.js";
import { findEmailAccountById } from "../db/emailAccounts.js";
import { getTemplate } from "../templates/index.js";
import { validateTargetUrl } from "../validation/targetUrl.js";

const router = Router();

// GET /campaigns — list all campaigns with workflow counts
router.get("/", async (_req: Request, res: Response) => {
  try {
    const campaigns = await listCampaigns();
    res.json(
      campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        brand: c.brand,
        objective: c.objective,
        notes: c.notes,
        notifyEmail: c.notifyEmail,
        brandDescription: c.brandDescription,
        deliverables: c.deliverables,
        timeline: c.timeline,
        rewardDescription: c.rewardDescription,
        shipsPhysicalProduct: c.shipsPhysicalProduct,
        postAcceptanceMode: c.postAcceptanceMode,
        emailAccountId: c.emailAccountId,
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

  // PLU-121: when a default sender is supplied, it must reference a real
  // connected account — reject an unknown id rather than silently storing a
  // dangling pointer that would fall back to the default account at enrollment.
  const trimmedAccountId =
    typeof emailAccountId === "string" ? emailAccountId.trim() : "";
  if (trimmedAccountId) {
    const account = await findEmailAccountById(trimmedAccountId);
    if (!account) {
      res.status(400).json({ error: "emailAccountId does not reference a connected account" });
      return;
    }
  }

  try {
    const campaign = await createCampaign({
      name: name.trim(),
      brand: brand.trim(),
      objective: typeof objective === "string" ? objective.trim() || null : null,
      notes: typeof notes === "string" ? notes.trim() || null : null,
      notifyEmail: trimmedNotify || null,
      brandDescription: typeof brandDescription === "string" ? brandDescription.trim() || null : null,
      deliverables: typeof deliverables === "string" ? deliverables.trim() || null : null,
      timeline: typeof timeline === "string" ? timeline.trim() || null : null,
      rewardDescription:
        typeof rewardDescription === "string" ? rewardDescription.trim() || null : null,
      shipsPhysicalProduct: shipsPhysicalProduct === true,
      // HARD-K1 knowledge fields — stated as fact by the agent when the creator
      // asks, deferred honestly when blank.
      usageRights: typeof usageRights === "string" ? usageRights.trim() || null : null,
      exclusivity: typeof exclusivity === "string" ? exclusivity.trim() || null : null,
      paymentTerms: typeof paymentTerms === "string" ? paymentTerms.trim() || null : null,
      attributionWindow:
        typeof attributionWindow === "string" ? attributionWindow.trim() || null : null,
      targetUrl: typeof targetUrl === "string" ? targetUrl.trim() || null : null,
      hiddenParamKey:
        typeof hiddenParamKey === "string" && hiddenParamKey.trim()
          ? hiddenParamKey.trim()
          : "_from",
      // Omitted → the column default (local_payment) applies, so a client that
      // predates this field creates a campaign that behaves exactly as before.
      ...(isPostAcceptanceMode(postAcceptanceMode) ? { postAcceptanceMode } : {}),
      // PLU-121: the chosen default sender. Omitted → null → enrollment falls back
      // to the default connected account.
      ...(trimmedAccountId ? { emailAccountId: trimmedAccountId } : {}),
    });
    res.status(201).json({
      id: campaign.id,
      name: campaign.name,
      brand: campaign.brand,
      objective: campaign.objective,
      notes: campaign.notes,
      notifyEmail: campaign.notifyEmail,
      brandDescription: campaign.brandDescription,
      deliverables: campaign.deliverables,
      timeline: campaign.timeline,
      rewardDescription: campaign.rewardDescription,
      shipsPhysicalProduct: campaign.shipsPhysicalProduct,
      usageRights: campaign.usageRights,
      exclusivity: campaign.exclusivity,
      paymentTerms: campaign.paymentTerms,
      attributionWindow: campaign.attributionWindow,
      targetUrl: campaign.targetUrl,
      hiddenParamKey: campaign.hiddenParamKey,
      postAcceptanceMode: campaign.postAcceptanceMode,
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
    res.json({
      id: campaign.id,
      name: campaign.name,
      brand: campaign.brand,
      objective: campaign.objective,
      notes: campaign.notes,
      notifyEmail: campaign.notifyEmail,
      brandDescription: campaign.brandDescription,
      deliverables: campaign.deliverables,
      timeline: campaign.timeline,
      rewardDescription: campaign.rewardDescription,
      shipsPhysicalProduct: campaign.shipsPhysicalProduct,
      postAcceptanceMode: campaign.postAcceptanceMode,
      emailAccountId: campaign.emailAccountId,
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

    // Stamp brandName/senderName into every node's config so {{brandName}}
    // resolves correctly when draft() is called at send time.
    const nodes = (JSON.parse(JSON.stringify(template.nodes)) as typeof template.nodes).map(
      (node) => ({
        ...node,
        config: {
          brandName: campaign.brand,
          senderName: campaign.brand,
          ...(campaign.brandDescription ? { brandDescription: campaign.brandDescription } : {}),
          ...(campaign.deliverables ? { deliverables: campaign.deliverables } : {}),
          ...(campaign.timeline ? { timeline: campaign.timeline } : {}),
          ...(campaign.rewardDescription ? { rewardDescription: campaign.rewardDescription } : {}),
          ...(campaign.shipsPhysicalProduct ? { shipsPhysicalProduct: true } : {}),
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

  if (notifyEmail !== undefined) {
    const trimmed = typeof notifyEmail === "string" ? notifyEmail.trim() : "";
    if (trimmed && !isEmailish(trimmed)) {
      res.status(400).json({ error: "notifyEmail must be a valid email address" });
      return;
    }
    patch.notifyEmail = trimmed || null;
  }
  if (objective !== undefined) {
    patch.objective = typeof objective === "string" ? objective.trim() || null : null;
  }
  if (notes !== undefined) {
    patch.notes = typeof notes === "string" ? notes.trim() || null : null;
  }
  if (brandDescription !== undefined) {
    patch.brandDescription = typeof brandDescription === "string" ? brandDescription.trim() || null : null;
  }
  if (deliverables !== undefined) {
    patch.deliverables = typeof deliverables === "string" ? deliverables.trim() || null : null;
  }
  if (timeline !== undefined) {
    patch.timeline = typeof timeline === "string" ? timeline.trim() || null : null;
  }
  if (rewardDescription !== undefined) {
    patch.rewardDescription =
      typeof rewardDescription === "string" ? rewardDescription.trim() || null : null;
  }
  if (shipsPhysicalProduct !== undefined) {
    patch.shipsPhysicalProduct = shipsPhysicalProduct === true;
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
  if (emailAccountId !== undefined) {
    // PLU-121: null/"" clears the default sender (back to the default account);
    // a non-empty value must reference a real connected account. Like the mode,
    // this changes only FUTURE enrollments — running instances keep their pin.
    const trimmed = typeof emailAccountId === "string" ? emailAccountId.trim() : "";
    if (trimmed) {
      const account = await findEmailAccountById(trimmed);
      if (!account) {
        res.status(400).json({ error: "emailAccountId does not reference a connected account" });
        return;
      }
      patch.emailAccountId = trimmed;
    } else {
      patch.emailAccountId = null;
    }
  }

  try {
    const existing = await findCampaignById(req.params["id"]!);
    if (!existing) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const campaign = await updateCampaign(req.params["id"]!, patch);
    res.json({
      id: campaign.id,
      name: campaign.name,
      brand: campaign.brand,
      objective: campaign.objective,
      notes: campaign.notes,
      notifyEmail: campaign.notifyEmail,
      brandDescription: campaign.brandDescription,
      deliverables: campaign.deliverables,
      timeline: campaign.timeline,
      rewardDescription: campaign.rewardDescription,
      shipsPhysicalProduct: campaign.shipsPhysicalProduct,
      postAcceptanceMode: campaign.postAcceptanceMode,
      emailAccountId: campaign.emailAccountId,
      updatedAt: campaign.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// DELETE /campaigns/:id — delete a campaign and all its workflows/instances
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
