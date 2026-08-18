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
import { resolveCurrentCampaignBriefForCampaign } from "../db/campaignBriefValidation.js";
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
    // PLU-142: the one authoritative validation service — never a bare
    // getCurrentReadyCampaignBrief() lookup. It re-checks the brief actually
    // matches the campaign's current CampaignTermsSnapshot (not just "some
    // READY row exists") and, on a mismatch, triggers regeneration itself
    // rather than this route re-deriving that decision independently.
    const result = await resolveCurrentCampaignBriefForCampaign(campaignId);

    if (result.status === "CURRENT") {
      // brief is guaranteed non-null with a renderedAssetRef by the CURRENT
      // contract itself (campaignBriefValidation.ts's own invariant).
      const bytes = await readStoredFile(result.brief!.renderedAssetRef!);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline");
      res.send(bytes);
      return;
    }

    if (result.status === "REGENERATING") {
      // Was a bare 409 before; now carries the structured result so the
      // caller knows this is transient (poll_for_ready), not a hard failure.
      res.status(202).json(result);
      return;
    }

    // BLOCKED — operator-facing route, safe to show the full diagnostic.
    res.status(409).json(result);
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
