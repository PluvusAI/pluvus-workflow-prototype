import { Router } from "express";
import type { Request, Response } from "express";
import { resolveCampaignBriefByCreatorToken } from "../db/campaignBriefRender.js";
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
    if (!brief || brief.status !== "READY" || !brief.renderedAssetRef) {
      // Deliberately the SAME 404 whether the token is unknown or resolves
      // to a not-yet-ready/failed row — a token must never leak whether it
      // "almost" matched something.
      res.status(404).json({ error: "not found" });
      return;
    }

    const bytes = await readStoredFile(brief.renderedAssetRef);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.send(bytes);
  } catch (err) {
    console.error("[campaign-brief-token] get error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
