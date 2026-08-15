import { Worker, type Job } from "bullmq";
import puppeteer from "puppeteer";
import { redisConnection } from "./redis.js";
import { QUEUE_CAMPAIGN_BRIEF_RENDER, campaignBriefRenderConcurrency } from "./queues.js";
import type { CampaignBriefRenderJobData } from "./jobs.js";
import { deadLetterIfExhausted } from "./deadLetter.js";
import { saveUploadedFile } from "../storage/localFileStorage.js";
import { renderCampaignBriefHtml } from "../templates/campaignBrief/index.js";
import { aiNarrative, defaultNarrative } from "../templates/campaignBrief/narrative.js";
import {
  buildCampaignBriefInput,
  finalizeCampaignBriefRender,
  getCampaignBriefById,
  markCampaignBriefFailed,
  mintCampaignBriefCreatorToken,
  CampaignBriefDataIncompleteError,
  CampaignBriefNotFoundError,
} from "../db/campaignBriefRender.js";
import { CampaignSnapshotMissingError } from "../db/campaigns.js";
import { db, type Db, type DbTx } from "../db/drizzle.js";

// ---------------------------------------------------------------------------
// PLU-139 §6: CampaignBrief render — a queue job, not an inline HTTP call
// ---------------------------------------------------------------------------
// Puppeteer can crash the whole Node process it runs in (a native Chromium
// OOM or segfault isn't a catchable JS exception) — this MUST run on a
// worker, never inside POST /campaigns/:id/brief's request handler. See the
// plan doc §6 for the full reasoning.

/**
 * §6's Phase 1 + Phase 2, as one function so it is directly unit-testable
 * (called straight from a .db.test.ts, no real BullMQ needed — same
 * convention as this session's other DB-layer tests) — handleCampaignBriefRender()
 * below is only a thin BullMQ wrapper around this.
 *
 * Phase 1 (no DB lock held): build the input (which itself resolves the
 * live BrandIdentity — §5), get narrative prose (AI or default — §3),
 * render the HTML template, convert to PDF via Puppeteer, save the bytes.
 * Phase 2 (finalizeCampaignBriefRender): one short locked transaction that
 * flips this row to READY and supersedes whatever was current before it.
 *
 * On any Phase 1 exception: marks the row FAILED with a category
 * (DATA_INCOMPLETE for a missing-data assertion, RENDER_FAILED for
 * anything else — Puppeteer/PDF/storage) and re-throws, so BullMQ's retry
 * policy (DEFAULT_JOB_OPTIONS) still applies. The retry re-enters this same
 * function against the SAME row id — never a fresh row per attempt.
 */
export async function renderCampaignBrief(
  campaignBriefId: string,
  client: Db | DbTx = db,
): Promise<void> {
  const briefRow = await getCampaignBriefById(campaignBriefId, client);
  if (!briefRow) {
    throw new CampaignBriefNotFoundError(campaignBriefId);
  }

  try {
    // ── Phase 1 ────────────────────────────────────────────────────────────
    const input = await buildCampaignBriefInput(briefRow.campaignId, client);

    const narrative = (await aiNarrative(input)) ?? defaultNarrative(input);
    const html = renderCampaignBriefHtml(input, narrative);

    // --no-sandbox/--disable-setuid-sandbox: required for Chromium to launch
    // as root in a container (the runtime image runs one process per role,
    // no non-root user configured today) — harmless in local dev too, so
    // applied unconditionally rather than gated on NODE_ENV. See the
    // Dockerfile's own PLU-139 comment for the matching apk/env setup.
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    let pdfBuffer: Buffer;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      pdfBuffer = Buffer.from(await page.pdf({ format: "Letter", printBackground: true }));
    } finally {
      await browser.close();
    }

    const { reference } = await saveUploadedFile(pdfBuffer, "brief.pdf");

    // ── Phase 2 ────────────────────────────────────────────────────────────
    const finalized = await finalizeCampaignBriefRender(
      {
        campaignBriefId,
        campaignId: briefRow.campaignId,
        renderedAssetRef: reference,
        brandIdentitySnapshot: input.brandIdentity,
        templateVersion: input.templateVersion,
      },
      client,
    );

    // §7: mint the creator-access token as its own step, after Phase 2 has
    // committed — not folded into that transaction, so its six-step
    // contract stays exactly as documented. Nothing in this PR delivers the
    // raw token to a creator (route-only, per the ticket's own resolution);
    // logging it here is a testing seam until the executor-wiring PR sends
    // it for real.
    const rawToken = await mintCampaignBriefCreatorToken(finalized.id, client);
    console.log(
      `[campaign-brief-render] rendered ${finalized.id} for campaign ${briefRow.campaignId} — creator token (testing seam, not yet delivered): ${rawToken}`,
    );
  } catch (err) {
    const category =
      err instanceof CampaignSnapshotMissingError || err instanceof CampaignBriefDataIncompleteError
        ? "DATA_INCOMPLETE"
        : "RENDER_FAILED";
    await markCampaignBriefFailed(campaignBriefId, category, client);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// BullMQ job handler + worker factory
// ---------------------------------------------------------------------------

async function handleCampaignBriefRender(job: Job<CampaignBriefRenderJobData>): Promise<void> {
  const { campaignBriefId } = job.data;
  const startedAt = Date.now();
  await renderCampaignBrief(campaignBriefId);
  console.log(
    `[campaign-brief-render] job ${job.id} completed ${campaignBriefId} in ${Date.now() - startedAt}ms`,
  );
}

export function createCampaignBriefRenderWorker(): Worker<CampaignBriefRenderJobData> {
  const concurrency = campaignBriefRenderConcurrency();
  const worker = new Worker<CampaignBriefRenderJobData>(
    QUEUE_CAMPAIGN_BRIEF_RENDER,
    handleCampaignBriefRender,
    {
      connection: redisConnection(),
      concurrency,
    },
  );
  console.log(`[campaign-brief-render] worker started (concurrency ${concurrency})`);

  worker.on("failed", (job, err) => {
    console.error(
      `[campaign-brief-render] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}/${job?.opts?.attempts ?? "?"}):`,
      err.message,
    );
    void deadLetterIfExhausted(QUEUE_CAMPAIGN_BRIEF_RENDER, job, err);
  });

  worker.on("error", (err) => {
    console.error("[campaign-brief-render] worker error:", err.message);
  });

  return worker;
}
