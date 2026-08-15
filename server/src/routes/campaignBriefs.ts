import { Router } from "express";
import type { Request, Response } from "express";
import {
  findCampaignById,
  CampaignNotFoundError,
  CampaignNotActiveError,
  CampaignSnapshotMissingError,
} from "../db/campaigns.js";
import {
  createOrGetCampaignBriefRenderRequest,
  getLatestCampaignBriefForCampaign,
  listCampaignBriefsForCampaign,
  CampaignBriefRenderRequestConflictError,
} from "../db/campaignBriefRender.js";
import { enqueueCampaignBriefRender } from "../workers/queues.js";
import { readStoredFile } from "../storage/localFileStorage.js";
import type { CampaignBrief } from "../db/schema.js";

// ---------------------------------------------------------------------------
// PLU-139 §7 — CampaignBrief operator routes. Mounted at /campaigns
// (requireOperatorKey, same gate as the rest of routes/campaigns.ts).
//
//   POST /campaigns/:id/brief       kick off a render (idempotent on renderRequestId)
//   GET  /campaigns/:id/brief       JSON metadata for the current (most recent) brief
//   GET  /campaigns/:id/brief/pdf   the actual PDF bytes
//   GET  /campaigns/:id/briefs      full history, every status, operator-only
//
// Metadata and bytes are deliberately two separate routes (not one) — this
// is what makes "preview and stored asset represent the same result"
// literally true: requesting /pdf is requesting the identical bytes that
// would be delivered anywhere else, not a separately-rendered view.
// ---------------------------------------------------------------------------

const router = Router();

function flattenCampaignBrief(brief: CampaignBrief) {
  return {
    id: brief.id,
    campaignId: brief.campaignId,
    campaignTermsSnapshotId: brief.campaignTermsSnapshotId,
    renderRequestId: brief.renderRequestId,
    status: brief.status,
    errorCategory: brief.errorCategory,
    templateVersion: brief.templateVersion,
    renderedAt: brief.renderedAt.toISOString(),
    generatedAt: brief.generatedAt?.toISOString() ?? null,
    supersededAt: brief.supersededAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// POST /:id/brief
// ---------------------------------------------------------------------------

router.post("/:id/brief", async (req: Request, res: Response) => {
  const campaignId = req.params["id"]!;
  try {
    const campaign = await findCampaignById(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }

    const renderRequestId = (req.body as Record<string, unknown> | undefined)?.["renderRequestId"];
    if (typeof renderRequestId !== "string" || renderRequestId.trim() === "") {
      res.status(400).json({ error: "renderRequestId is required" });
      return;
    }

    const { campaignBrief, isNew } = await createOrGetCampaignBriefRenderRequest(
      campaignId,
      renderRequestId,
    );

    // §6a: only a genuinely NEW row needs a job — an existing row (same
    // renderRequestId seen before) already has one in flight or finished;
    // enqueuing again would be redundant, not incorrect (BullMQ dedupes on
    // jobId), but skipping it keeps the intent clear: this branch is "no new
    // work," not "re-trigger."
    if (isNew) {
      await enqueueCampaignBriefRender({ campaignBriefId: campaignBrief.id });
    }

    res.status(202).json(flattenCampaignBrief(campaignBrief));
  } catch (err) {
    if (err instanceof CampaignNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof CampaignNotActiveError || err instanceof CampaignSnapshotMissingError) {
      res.status(422).json({ error: err.message });
      return;
    }
    if (err instanceof CampaignBriefRenderRequestConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[campaign-briefs] post error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/brief — JSON metadata only, current (most recent, any status)
// ---------------------------------------------------------------------------

router.get("/:id/brief", async (req: Request, res: Response) => {
  const campaignId = req.params["id"]!;
  try {
    const campaign = await findCampaignById(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const brief = await getLatestCampaignBriefForCampaign(campaignId);
    if (!brief) {
      res.status(404).json({ error: "no brief has been rendered for this campaign yet" });
      return;
    }
    res.json(flattenCampaignBrief(brief));
  } catch (err) {
    console.error("[campaign-briefs] get metadata error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/brief/pdf — the actual file bytes
// ---------------------------------------------------------------------------

router.get("/:id/brief/pdf", async (req: Request, res: Response) => {
  const campaignId = req.params["id"]!;
  try {
    const campaign = await findCampaignById(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const brief = await getLatestCampaignBriefForCampaign(campaignId);
    if (!brief) {
      res.status(404).json({ error: "no brief has been rendered for this campaign yet" });
      return;
    }
    if (brief.status !== "READY" || !brief.renderedAssetRef) {
      res.status(409).json({ error: `brief is ${brief.status.toLowerCase()}, not ready`, status: brief.status });
      return;
    }

    const bytes = await readStoredFile(brief.renderedAssetRef);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.send(bytes);
  } catch (err) {
    console.error("[campaign-briefs] get pdf error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/briefs — full history, every status, operator-only
// ---------------------------------------------------------------------------

router.get("/:id/briefs", async (req: Request, res: Response) => {
  const campaignId = req.params["id"]!;
  try {
    const campaign = await findCampaignById(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const briefs = await listCampaignBriefsForCampaign(campaignId);
    res.json(briefs.map(flattenCampaignBrief));
  } catch (err) {
    console.error("[campaign-briefs] get history error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
