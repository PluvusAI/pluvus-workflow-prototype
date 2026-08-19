import { Router } from "express";
import type { Request, Response } from "express";
import { resolveCampaignBriefByCreatorToken } from "../db/campaignBriefRender.js";
import {
  resolveCurrentCampaignBriefForCampaign,
  CampaignBriefRegenerationUnavailableError,
} from "../db/campaignBriefValidation.js";
import { readStoredFile } from "../storage/localFileStorage.js";

// ---------------------------------------------------------------------------
// PLU-139 §7 — creator-facing CampaignBrief retrieval. Public, magic-link
// gated (same pattern as /payment, /payout, /brand-approval — a token is
// the only credential, no operator key). Mounted at /brief.
//
//   GET /brief/:token   streams back ONLY the PDF bytes — no CampaignBrief
//                       row metadata exposed, no other creator's data
//                       reachable through it.
//
// Route only in this PR — nothing yet mints/delivers this token to a real
// creator (no CONTENT_BRIEF executor wiring, per the ticket's own
// resolution). The token exists on every READY brief (minted by the render
// worker right after Phase 2 finalizes) so this route is real and
// end-to-end testable even though nothing production-facing calls it yet.
// ---------------------------------------------------------------------------

const router = Router();

router.get("/:token", async (req: Request, res: Response) => {
  const token = req.params["token"]!;
  try {
    const brief = await resolveCampaignBriefByCreatorToken(token);
    if (!brief) {
      // Deliberately the SAME 404 an unready/failed row would also get below
      // — a token must never leak whether it "almost" matched something.
      res.status(404).json({ error: "not found" });
      return;
    }

    // PLU-142 (review fix): campaign-scoped (not instance-scoped — the
    // token carries no instanceId, §0's own documented gap). Re-validates
    // against the campaign's CURRENT brief, but requires it to be the EXACT
    // row this token was minted for — not "whatever's current now." The
    // original version treated any CURRENT result as good enough, reasoning
    // that a campaign only ever has one permanent CampaignTermsSnapshot, so
    // a later re-render is "the same terms, just refreshed." That's true of
    // the TERMS, but not of the rendered PRESENTATION: PLU-141 already
    // proves brandIdentitySnapshot is captured point-in-time, so a
    // superseding render can legitimately show different colors/narrative
    // text than what this token's own brief showed. Silently substituting
    // that under a link a creator already has is a real integrity gap, not
    // a convenience — a superseded token now 404s instead, the same
    // "never leak whether it almost matched" posture as the unknown-token
    // case above, rather than serving different content under it.
    const result = await resolveCurrentCampaignBriefForCampaign(brief.campaignId);
    if (result.status !== "CURRENT" || result.brief!.id !== brief.id) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const bytes = await readStoredFile(result.brief!.renderedAssetRef!);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.send(bytes);
  } catch (err) {
    if (err instanceof CampaignBriefRegenerationUnavailableError) {
      // Review fix: a transient infra failure (Redis/DB) mid-regeneration
      // is not "not found" and not a permanent error — retryable, 503.
      res.status(503).json({ error: "temporarily unavailable, retry" });
      return;
    }
    console.error("[campaign-brief-token] get error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
