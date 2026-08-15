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
 * On any Phase 1/2 exception: marks the row FAILED with a category
 * (DATA_INCOMPLETE for a missing-data assertion, RENDER_FAILED for
 * anything else — Puppeteer/PDF/storage) and re-throws, so BullMQ's retry
 * policy (DEFAULT_JOB_OPTIONS) still applies. The retry re-enters this same
 * function against the SAME row id — never a fresh row per attempt.
 *
 * Review fix (Calvin): "token failure invalidates the finalized brief." The
 * creator-token mint used to run INSIDE this same try/catch, after Phase 2
 * had already committed the row as READY (and already superseded whatever
 * was current before it). If the mint then threw, the catch below used to
 * mark that same, already-successful row FAILED — leaving NO current READY
 * row at all (the predecessor superseded, the successor now FAILED), even
 * though a perfectly good PDF had just been rendered and stored. The render
 * succeeding and the token mint succeeding are not the same event — a
 * render that produced a real, stored, finalized PDF must never be
 * retroactively invalidated by a failure in a step that comes after it.
 * Token minting now runs in its OWN try/catch, below, outside this one:
 * failure there is logged and swallowed, never re-thrown, never mapped to
 * markCampaignBriefFailed() — matching how this codebase already treats
 * other best-effort follow-up work after a primary operation has already
 * succeeded (e.g. payment.ts's "Phase 1: show tracking link... non-fatal if
 * lookup fails" and "content-brief enqueue error (non-fatal)" comments).
 * markCampaignBriefFailed() itself also gained a defensive predicate guard
 * (status = 'GENERATING' only) so this class of bug — anything added after
 * Phase 2 throwing back into this catch — can't silently corrupt an
 * already-finalized row again, even by a future mistake.
 */
export async function renderCampaignBrief(
  campaignBriefId: string,
  client: Db | DbTx = db,
): Promise<void> {
  const briefRow = await getCampaignBriefById(campaignBriefId, client);
  if (!briefRow) {
    throw new CampaignBriefNotFoundError(campaignBriefId);
  }

  let finalizedId: string;
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
    finalizedId = finalized.id;
  } catch (err) {
    const category =
      err instanceof CampaignSnapshotMissingError || err instanceof CampaignBriefDataIncompleteError
        ? "DATA_INCOMPLETE"
        : "RENDER_FAILED";
    await markCampaignBriefFailed(campaignBriefId, category, client);
    throw err;
  }

  // ── Post-finalize: creator-access token mint (§7) ─────────────────────────
  // Deliberately OUTSIDE the try/catch above — the render already succeeded
  // and committed (finalizedId is READY, its predecessor already
  // superseded); a failure here must never undo that. Nothing in this PR
  // delivers the raw token to a creator (route-only, per the ticket's own
  // resolution), so a mint failure has no user-facing consequence today —
  // logged for operator visibility, not treated as a render failure.
  try {
    // Security review fix (Calvin, separate finding): the raw token used to
    // be logged here as a manual-testing seam — but possession of it alone
    // authorizes the PUBLIC, unauthenticated GET /brief/:token route (§7),
    // so printing it to a log line handed the exact same access to anyone
    // who can read worker logs (log aggregators, shipping services, etc.),
    // silently bypassing requireOperatorKey. Never log a bearer credential,
    // even temporarily "for testing" — logs routinely outlive and outreach
    // the access boundary the credential was meant to enforce. Only a
    // non-sensitive correlation value (the CampaignBrief id) is logged now;
    // an operator who needs the raw token to manually verify the route
    // before real delivery is wired should read it via a secure, DB-scoped
    // channel (e.g. a local debug query, never a shipped log stream) — the
    // hash alone (creatorTokenHash, already persisted) is deliberately
    // insufficient to reconstruct the raw token, by design.
    await mintCampaignBriefCreatorToken(finalizedId, client);
    console.log(
      `[campaign-brief-render] rendered ${finalizedId} for campaign ${briefRow.campaignId} — creator token minted`,
    );
  } catch (err) {
    console.error(
      `[campaign-brief-render] creator token mint failed for ${finalizedId} (render itself succeeded — NOT marking the brief failed):`,
      err instanceof Error ? err.message : err,
    );
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
