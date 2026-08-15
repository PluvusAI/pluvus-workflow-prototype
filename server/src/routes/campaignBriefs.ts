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
  getCurrentReadyCampaignBrief,
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

    const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(
      campaignId,
      renderRequestId,
    );

    // Review fix (Calvin): gated on `isNew` before, which assumed "row
    // already existed" implies "a job was already successfully enqueued for
    // it" — false. createOrGetCampaignBriefRenderRequest()'s DB insert and
    // this enqueue call are two separate, non-atomic steps; if the process
    // crashes or the enqueue call itself throws AFTER the row commits, the
    // row is stuck GENERATING with no job ever dispatched, and a retry with
    // the SAME renderRequestId used to hit isNew:false and skip enqueueing
    // again — silently stranding the render until §6b's stale-render sweep
    // (a ~10-minute grace window) eventually marks it FAILED/STALE.
    //
    // Fixed by gating on STATUS instead of isNew: any row still GENERATING
    // — whether brand new or found via a retry — gets an enqueue attempt.
    // Safe to call unconditionally for a row that already has a job running:
    // enqueueCampaignBriefRender()'s jobId is deterministic
    // (`brief-render|${campaignBriefId}`), and BullMQ dedupes on jobId
    // within the active+waiting set (the same idempotency guarantee every
    // other queue in this codebase already relies on — see
    // enqueueNodeExecution()'s own doc comment) — so a duplicate enqueue
    // against a job that's genuinely still in flight is a harmless no-op,
    // while a duplicate enqueue against a row whose FIRST enqueue attempt
    // never actually landed now correctly dispatches it for the first time.
    // READY/FAILED rows are intentionally excluded: idempotency-key replay
    // returns the terminal outcome as-is (Stripe-style), it does not retry
    // a completed or already-failed operation — a caller who wants a fresh
    // attempt after a real FAILED mints a new renderRequestId (§6a).
    if (campaignBrief.status === "GENERATING") {
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
    // The CURRENT ready asset, not the newest attempt — a re-render still
    // GENERATING (or one that just FAILED) must not shadow a perfectly good,
    // un-superseded prior PDF. See getCurrentReadyCampaignBrief()'s own doc
    // comment for why this is a different query from the status route below.
    const brief = await getCurrentReadyCampaignBrief(campaignId);
    if (!brief || !brief.renderedAssetRef) {
      // Distinguish "nothing has ever rendered" from "a render exists but
      // none has ever completed" for a clearer error, without changing
      // which row actually gets served above.
      const latest = await getLatestCampaignBriefForCampaign(campaignId);
      if (!latest) {
        res.status(404).json({ error: "no brief has been rendered for this campaign yet" });
        return;
      }
      res.status(409).json({
        error: `no ready brief is available yet (latest attempt is ${latest.status.toLowerCase()})`,
        status: latest.status,
      });
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
