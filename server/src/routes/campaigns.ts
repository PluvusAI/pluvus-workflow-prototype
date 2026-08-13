import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/drizzle.js";
import { campaigns } from "../db/schema.js";
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
import {
  getCampaignDetails,
  upsertCampaignDetails,
  assertCampaignIsDraft,
  CampaignNotDraftError,
} from "../db/campaignDetails.js";
import { getBrandIdentity, upsertBrandIdentity } from "../db/brandIdentity.js";
import {
  getCreatorRequirement,
  upsertCreatorRequirement,
} from "../db/creatorRequirement.js";
import { getTemplate } from "../templates/index.js";
import { validateTargetUrl } from "../validation/targetUrl.js";
import {
  validateCreateSendingSettings,
  validatePatchSendingSettings,
} from "../validation/campaignSendingSettings.js";
import {
  validateDetailsGroup,
  validateBrandIdentityGroup,
  validateCreatorRequirementGroup,
} from "../validation/campaignSections.js";
import type {
  BrandIdentity,
  CampaignDetails,
  CampaignDetailsInsert,
  BrandIdentityInsert,
  CreatorRequirement,
  CreatorRequirementInsert,
} from "../db/schema.js";

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
        dailyInitialOutreachLimit: c.dailyInitialOutreachLimit,
        outreachPacingMinMinutes: c.outreachPacingMinMinutes,
        outreachPacingMaxMinutes: c.outreachPacingMaxMinutes,
        negotiationReplyPacingMinMinutes: c.negotiationReplyPacingMinMinutes,
        negotiationReplyPacingMaxMinutes: c.negotiationReplyPacingMaxMinutes,
        emailAccountId: c.emailAccountId,
        status: c.status,
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

// ---------------------------------------------------------------------------
// PLU-139 — sectioned Draft intake helpers
// ---------------------------------------------------------------------------

// The nested public-terms groups a POST/PATCH body may carry. The Draft-lock guard
// fires (on PATCH) ONLY when the body touches one of these (review B2).
const SECTION_GROUPS = ["details", "brandIdentity", "creatorRequirement"] as const;

interface ValidatedSections {
  present: boolean;
  details?: Partial<CampaignDetailsInsert>;
  brandIdentity?: Partial<BrandIdentityInsert>;
  creatorRequirement?: Partial<CreatorRequirementInsert>;
}

/** Validate whichever of the three nested groups are present. `error` set → 400. */
function validateSections(
  body: Record<string, unknown>,
):
  | { ok: true; sections: ValidatedSections }
  | { ok: false; error: string } {
  const sections: ValidatedSections = {
    present: SECTION_GROUPS.some((g) => body[g] !== undefined),
  };
  if (body["details"] !== undefined) {
    const r = validateDetailsGroup(body["details"]);
    if (!r.valid) return { ok: false, error: r.error };
    sections.details = r.value;
  }
  if (body["brandIdentity"] !== undefined) {
    const r = validateBrandIdentityGroup(body["brandIdentity"]);
    if (!r.valid) return { ok: false, error: r.error };
    sections.brandIdentity = r.value;
  }
  if (body["creatorRequirement"] !== undefined) {
    const r = validateCreatorRequirementGroup(body["creatorRequirement"]);
    if (!r.valid) return { ok: false, error: r.error };
    sections.creatorRequirement = r.value;
  }
  return { ok: true, sections };
}

/**
 * Persist whichever validated groups are present, inside one transaction. A
 * `details` create requires compensationStructure; upsertCampaignDetails throws if
 * it's missing on a first insert (surfaced as 400 by the caller). Runs the shared
 * clearStaleCompFields via the DB module.
 */
async function writeSections(
  campaignId: string,
  sections: ValidatedSections,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (sections.details) await upsertCampaignDetails(campaignId, sections.details, tx);
    if (sections.brandIdentity) {
      await upsertBrandIdentity(campaignId, sections.brandIdentity, tx);
    }
    if (sections.creatorRequirement) {
      await upsertCreatorRequirement(campaignId, sections.creatorRequirement, tx);
    }
  });
}

// Public payload shapers — expose ONLY the public columns (no id/campaignId/
// timestamps, and — for CampaignDetails — NO private-policy key, since none exist
// on the table). Return null when the row is absent so GET is a stable shape.
function detailsPayload(d: CampaignDetails | null) {
  if (!d) return null;
  const { id: _id, campaignId: _c, createdAt: _ca, updatedAt: _ua, ...rest } = d;
  return {
    ...rest,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}
function brandIdentityPayload(b: BrandIdentity | null) {
  if (!b) return null;
  const { id: _id, campaignId: _c, createdAt: _ca, updatedAt: _ua, ...rest } = b;
  return {
    ...rest,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}
function creatorRequirementPayload(r: CreatorRequirement | null) {
  if (!r) return null;
  const { id: _id, campaignId: _c, createdAt: _ca, updatedAt: _ua, ...rest } = r;
  return {
    ...rest,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
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

  // PLU-139: validate the optional nested public-terms groups up front. A `details`
  // group that omits compensationStructure on a brand-new campaign is rejected here
  // (the one required term) rather than failing mid-write.
  const sections = validateSections(req.body as Record<string, unknown>);
  if (!sections.ok) {
    res.status(400).json({ error: sections.error });
    return;
  }
  if (sections.sections.details && !sections.sections.details.compensationStructure) {
    res.status(400).json({
      error: "details.compensationStructure is required when creating campaign details",
    });
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
      ...sendingSettings.value,
      // PLU-121: the chosen default sender. Omitted → null → enrollment falls back
      // to the default connected account.
      ...(trimmedAccountId ? { emailAccountId: trimmedAccountId } : {}),
    });

    // PLU-139: persist the nested public-terms groups. New campaigns are DRAFT
    // (schema default), so no lifecycle guard is needed on create.
    if (sections.sections.present) {
      await writeSections(campaign.id, sections.sections);
    }

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
      dailyInitialOutreachLimit: campaign.dailyInitialOutreachLimit,
      outreachPacingMinMinutes: campaign.outreachPacingMinMinutes,
      outreachPacingMaxMinutes: campaign.outreachPacingMaxMinutes,
      negotiationReplyPacingMinMinutes: campaign.negotiationReplyPacingMinMinutes,
      negotiationReplyPacingMaxMinutes: campaign.negotiationReplyPacingMaxMinutes,
      emailAccountId: campaign.emailAccountId,
      status: campaign.status,
      createdAt: campaign.createdAt.toISOString(),
      details: sections.sections.details
        ? detailsPayload(await getCampaignDetails(campaign.id))
        : null,
      brandIdentity: sections.sections.brandIdentity
        ? brandIdentityPayload(await getBrandIdentity(campaign.id))
        : null,
      creatorRequirement: sections.sections.creatorRequirement
        ? creatorRequirementPayload(await getCreatorRequirement(campaign.id))
        : null,
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
    // PLU-139: load the three 1:1 detail groups for the normalized single payload
    // (the source of truth PLU-140 reads). Only the detail route reads these, so
    // no matching/outreach code ever touches CreatorRequirement.
    const [details, brandIdentity, creatorRequirement] = await Promise.all([
      getCampaignDetails(campaign.id),
      getBrandIdentity(campaign.id),
      getCreatorRequirement(campaign.id),
    ]);
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
      dailyInitialOutreachLimit: campaign.dailyInitialOutreachLimit,
      outreachPacingMinMinutes: campaign.outreachPacingMinMinutes,
      outreachPacingMaxMinutes: campaign.outreachPacingMaxMinutes,
      negotiationReplyPacingMinMinutes: campaign.negotiationReplyPacingMinMinutes,
      negotiationReplyPacingMaxMinutes: campaign.negotiationReplyPacingMaxMinutes,
      emailAccountId: campaign.emailAccountId,
      status: campaign.status,
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
      details: detailsPayload(details),
      brandIdentity: brandIdentityPayload(brandIdentity),
      creatorRequirement: creatorRequirementPayload(creatorRequirement),
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

  const sendingSettings = validatePatchSendingSettings(
    req.body as Record<string, unknown>,
  );
  if (!sendingSettings.valid) {
    res.status(400).json({ error: sendingSettings.error });
    return;
  }
  Object.assign(patch, sendingSettings.value);

  // PLU-139: validate any nested public-terms groups. The Draft guard fires below
  // ONLY when one of these is present — scalar/sender edits stay ungated (B2).
  const sections = validateSections(req.body as Record<string, unknown>);
  if (!sections.ok) {
    res.status(400).json({ error: sections.error });
    return;
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

    // PLU-139 (B2): the Draft-lock guard fires ONLY for a material edit — a PATCH
    // touching one of the nested public-terms groups. A scalar/sender-settings edit
    // (notifyEmail, pacing, emailAccountId, postAcceptanceMode) stays editable on a
    // running campaign, so it is never guarded. Guard + write share one transaction
    // so the status can't change between the check and the upserts.
    if (sections.sections.present) {
      try {
        await db.transaction(async (tx) => {
          await assertCampaignIsDraft(req.params["id"]!, tx);
          if (sections.sections.details) {
            await upsertCampaignDetails(req.params["id"]!, sections.sections.details, tx);
          }
          if (sections.sections.brandIdentity) {
            await upsertBrandIdentity(req.params["id"]!, sections.sections.brandIdentity, tx);
          }
          if (sections.sections.creatorRequirement) {
            await upsertCreatorRequirement(
              req.params["id"]!,
              sections.sections.creatorRequirement,
              tx,
            );
          }
        });
      } catch (err) {
        if (err instanceof CampaignNotDraftError) {
          res.status(409).json({
            error: `campaign is ${err.status}; material edits are only allowed on a DRAFT campaign`,
          });
          return;
        }
        throw err;
      }
    }

    // Only touch the campaign row when a scalar patch was actually supplied — a
    // pure-sections PATCH leaves the Campaign row alone.
    const campaign =
      Object.keys(patch).length > 0
        ? await updateCampaign(req.params["id"]!, patch)
        : existing;

    const [details, brandIdentity, creatorRequirement] = await Promise.all([
      getCampaignDetails(campaign.id),
      getBrandIdentity(campaign.id),
      getCreatorRequirement(campaign.id),
    ]);
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
      dailyInitialOutreachLimit: campaign.dailyInitialOutreachLimit,
      outreachPacingMinMinutes: campaign.outreachPacingMinMinutes,
      outreachPacingMaxMinutes: campaign.outreachPacingMaxMinutes,
      negotiationReplyPacingMinMinutes: campaign.negotiationReplyPacingMinMinutes,
      negotiationReplyPacingMaxMinutes: campaign.negotiationReplyPacingMaxMinutes,
      emailAccountId: campaign.emailAccountId,
      status: campaign.status,
      updatedAt: campaign.updatedAt.toISOString(),
      details: detailsPayload(details),
      brandIdentity: brandIdentityPayload(brandIdentity),
      creatorRequirement: creatorRequirementPayload(creatorRequirement),
    });
  } catch (err) {
    console.error("[campaigns] update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /campaigns/:id/duplicate — "Copy prior campaign" (PLU-139).
// Creates a NEW DRAFT campaign copying the source Campaign scalars + the three
// 1:1 detail groups. Does NOT copy workflows/versions/instances/creators/messages/
// snapshots — every heavy relation hangs off workflows→versions→instances, not the
// campaign scalars or the detail tables, so copying only these is safe.
router.post("/:id/duplicate", async (req: Request, res: Response) => {
  try {
    const source = await findCampaignById(req.params["id"]!);
    if (!source) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const [srcDetails, srcBrand, srcCreator] = await Promise.all([
      getCampaignDetails(source.id),
      getBrandIdentity(source.id),
      getCreatorRequirement(source.id),
    ]);

    // Don't blind-copy the default sender: an account that was since disconnected
    // must not carry over as a dangling pointer. Copy only when still active.
    let emailAccountId: string | null = null;
    if (source.emailAccountId) {
      const account = await findEmailAccountById(source.emailAccountId);
      if (account && account.status === "active") emailAccountId = source.emailAccountId;
    }

    const copy = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(campaigns)
        .values({
          // Scalars only — the new campaign is a fresh DRAFT (schema default).
          name: `${source.name} (copy)`,
          brand: source.brand,
          objective: source.objective,
          notes: source.notes,
          notifyEmail: source.notifyEmail,
          brandDescription: source.brandDescription,
          deliverables: source.deliverables,
          timeline: source.timeline,
          rewardDescription: source.rewardDescription,
          shipsPhysicalProduct: source.shipsPhysicalProduct,
          usageRights: source.usageRights,
          exclusivity: source.exclusivity,
          paymentTerms: source.paymentTerms,
          attributionWindow: source.attributionWindow,
          targetUrl: source.targetUrl,
          hiddenParamKey: source.hiddenParamKey,
          postAcceptanceMode: source.postAcceptanceMode,
          dailyInitialOutreachLimit: source.dailyInitialOutreachLimit,
          outreachPacingMinMinutes: source.outreachPacingMinMinutes,
          outreachPacingMaxMinutes: source.outreachPacingMaxMinutes,
          negotiationReplyPacingMinMinutes: source.negotiationReplyPacingMinMinutes,
          negotiationReplyPacingMaxMinutes: source.negotiationReplyPacingMaxMinutes,
          emailAccountId,
        })
        .returning();
      const newId = created!.id;
      // Copy the detail groups WITHOUT the source id/campaignId/timestamps.
      if (srcDetails) {
        const { id: _i, campaignId: _c, createdAt: _ca, updatedAt: _u, ...rest } = srcDetails;
        await upsertCampaignDetails(newId, rest, tx);
      }
      if (srcBrand) {
        const { id: _i, campaignId: _c, createdAt: _ca, updatedAt: _u, ...rest } = srcBrand;
        await upsertBrandIdentity(newId, rest, tx);
      }
      if (srcCreator) {
        const { id: _i, campaignId: _c, createdAt: _ca, updatedAt: _u, ...rest } = srcCreator;
        await upsertCreatorRequirement(newId, rest, tx);
      }
      return created!;
    });

    res.status(201).json({ id: copy.id, name: copy.name, status: copy.status });
  } catch (err) {
    console.error("[campaigns] duplicate error:", err);
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
