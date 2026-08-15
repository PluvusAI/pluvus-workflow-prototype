import {
  listStaleGeneratingCampaignBriefs,
  markCampaignBriefStaleIfGenerating,
} from "../db/campaignBriefRender.js";
import type { CampaignBrief } from "../db/schema.js";
import { logTrace } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// PLU-139 §6b: CampaignBrief crash-recovery sweep
// ---------------------------------------------------------------------------
// This codebase's real crash-recovery mechanism is an app-level scheduler
// sweep (this file, mirroring reconciliation.ts/brandApprovalSweep.ts), NOT
// BullMQ's own stalled-job detection, which is never configured anywhere in
// this project. A render job's worker process can die between claiming the
// job and reporting back (a native Chromium OOM/segfault isn't a catchable
// JS exception — see §6) — when that happens the CampaignBrief row is left
// GENERATING forever with zero diagnostic information. This sweep is the
// durable recovery: it marks a stuck row FAILED (category STALE) so an
// operator (or UI) sees a definite outcome instead of an indefinite spinner,
// and a fresh POST /campaigns/:id/brief with a new renderRequestId can
// retry cleanly.
//
// Deliberately NOT auto-retry (unlike reconcileStuckInstances()) — see
// markCampaignBriefStaleIfGenerating()'s doc comment for why blindly
// re-enqueueing risks an infinite crash loop here specifically.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// A GENERATING row younger than this is presumed still mid-render (Puppeteer
// launch + page render + PDF conversion + an optional AI narrative call can
// legitimately take up to ~AGENT_TIMEOUT_MS=120s) and is left alone. 10
// minutes is a generous ceiling on that, so a row older than this window has
// almost certainly lost its worker. Env-overridable for operational tuning.
export const campaignBriefRenderStaleGraceMs = envInt(
  "CAMPAIGN_BRIEF_RENDER_STALE_GRACE_MS",
  10 * 60_000,
);

export interface CampaignBriefRenderSweepDeps {
  listStaleGeneratingCampaignBriefs(args: {
    olderThan: Date;
    limit?: number;
  }): Promise<CampaignBrief[]>;
  markCampaignBriefStaleIfGenerating(id: string): Promise<CampaignBrief | null>;
  now(): Date;
}

const defaultDeps: CampaignBriefRenderSweepDeps = {
  listStaleGeneratingCampaignBriefs,
  markCampaignBriefStaleIfGenerating,
  now: () => new Date(),
};

export interface CampaignBriefRenderSweepResult {
  /** Stale GENERATING rows marked FAILED (category STALE). */
  markedFailed: number;
}

export async function sweepStaleCampaignBriefRenders(
  deps: CampaignBriefRenderSweepDeps = defaultDeps,
): Promise<CampaignBriefRenderSweepResult> {
  const now = deps.now();
  const olderThan = new Date(now.getTime() - campaignBriefRenderStaleGraceMs);

  let stale: CampaignBrief[];
  try {
    stale = await deps.listStaleGeneratingCampaignBriefs({ olderThan, limit: 100 });
  } catch (err) {
    console.error(
      "[scheduler/campaign-brief-render-sweep] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return { markedFailed: 0 };
  }

  if (stale.length === 0) return { markedFailed: 0 };

  console.log(
    `[scheduler/campaign-brief-render-sweep] ${stale.length} stale GENERATING row(s) to inspect`,
  );

  let markedFailed = 0;

  for (const row of stale) {
    try {
      const updated = await deps.markCampaignBriefStaleIfGenerating(row.id);
      if (updated) {
        markedFailed++;
        console.log(
          `[scheduler/campaign-brief-render-sweep] marked ${row.id} (campaign ${row.campaignId}) FAILED (STALE)`,
        );
        logTrace("campaign_brief_render_marked_stale", {
          source: "scheduler",
          campaignId: row.campaignId,
          campaignBriefId: row.id,
        });
      }
      // updated === null → a racing worker already finished it (win or
      // lose) between the SELECT above and this UPDATE — no-op.
    } catch (err) {
      console.error(
        `[scheduler/campaign-brief-render-sweep] mark-stale failed for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (markedFailed) {
    console.log(`[scheduler/campaign-brief-render-sweep] marked ${markedFailed} row(s) FAILED (STALE)`);
  }
  return { markedFailed };
}
