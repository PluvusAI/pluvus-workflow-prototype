import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import {
  findBrandApprovalById,
  claimBrandApprovalForProcessing,
  finalizeBrandApprovalDecision,
  revertBrandApprovalToAwaiting,
  findInstanceById,
} from "../db/index.js";
import type { BrandApproval } from "../db/schema.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import {
  brandApprovalTokenMatches,
  isBrandApprovalTokenExpired,
} from "../engine/executors/brandApprovalToken.js";
import {
  renderBrandApprovalInterstitialPage,
  renderBrandApprovedPage,
  renderBrandRejectedPage,
  renderBrandApprovalAlreadyActionedPage,
  renderBrandApprovalExpiredPage,
  renderBrandApprovalInvalidPage,
  renderBrandApprovalRetryPage,
} from "./brandApprovalPage.js";

// ---------------------------------------------------------------------------
// Brand-facing approve/reject — public, magic-link-gated (brand-approval gate).
// Mounted at /brand-approval.
//
//   GET  /brand-approval/approve/:id?token=…   renders the approve interstitial
//   GET  /brand-approval/reject/:id?token=…    renders the reject interstitial
//   POST /brand-approval/approve/:id           AWAITING_APPROVAL → APPROVED → sends the brief
//   POST /brand-approval/reject/:id            AWAITING_APPROVAL → REJECTED → MANUAL_REVIEW
//
// GET NEVER MUTATES — it only renders an interstitial whose button POSTs. Mail
// scanners prefetch GETs, so a GET that decided the approval would fire the moment
// the email landed. This mirrors routes/payoutConfirm.ts exactly.
// ---------------------------------------------------------------------------

const router = Router();

// The raw magic-link token rides in the URL query string (?token=…). Suppress the
// Referer header outright so the token is never leaked to any resource the page
// references, and forbid caching/indexing of the token-bearing response (PLU-118,
// Calvin review — "please make sure … the page uses a strict referrer policy").
// helmet already sets a global Referrer-Policy, but we set it explicitly here so
// this sensitive surface self-documents and stays strict regardless of global
// config drift. The GET only renders (never mutates), so caching is pure downside.
router.use((_req: Request, res: Response, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

// The POST carries the token in a hidden urlencoded form field.
router.use(urlencoded({ extended: false }));

type Action = "approve" | "reject";

function clientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.ip ?? null;
}

function clientUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua.length > 0 ? ua : null;
}

/**
 * Shared guard used by BOTH the GET (render) and POST (mutate) paths so they agree
 * exactly on invalid / expired / already-decided. Performs NO writes — the caller
 * decides whether to render or mutate.
 */
async function resolveGuard(
  approvalId: string,
  presentedToken: string | undefined,
): Promise<
  | { kind: "invalid" }
  | { kind: "expired"; approval: BrandApproval }
  | { kind: "already"; approval: BrandApproval }
  | { kind: "ok"; approval: BrandApproval }
> {
  const approval = await findBrandApprovalById(approvalId);
  if (!approval) return { kind: "invalid" };

  // Token must match the stored hash (timing-safe). Absent/mismatch → invalid.
  if (!brandApprovalTokenMatches(presentedToken, approval.approveTokenHash)) {
    return { kind: "invalid" };
  }

  // Expired token → friendly page (only meaningful while still AWAITING_APPROVAL).
  if (
    approval.status === "AWAITING_APPROVAL" &&
    isBrandApprovalTokenExpired(approval.tokenExpiresAt)
  ) {
    return { kind: "expired", approval };
  }

  // Not AWAITING → already approved/rejected. A mail-prefetch of the OTHER link
  // after acting must be a safe no-op notice.
  if (approval.status !== "AWAITING_APPROVAL") {
    return { kind: "already", approval };
  }

  return { kind: "ok", approval };
}

type Guard = Awaited<ReturnType<typeof resolveGuard>>;

/** Render the response for any non-"ok" guard outcome. Returns true if handled. */
function respondForNonOkGuard(res: Response, guard: Guard): boolean {
  switch (guard.kind) {
    case "invalid":
      res.status(404).type("html").send(renderBrandApprovalInvalidPage());
      return true;
    case "expired":
      res
        .status(410)
        .type("html")
        .send(
          renderBrandApprovalExpiredPage({
            brandName: guard.approval.brandName ?? guard.approval.campaignName,
          }),
        );
      return true;
    case "already":
      res.type("html").send(
        renderBrandApprovalAlreadyActionedPage({
          brandName: pageBrandName(guard.approval),
          status: guard.approval.status,
        }),
      );
      return true;
    default:
      return false; // "ok" — caller renders/mutates
  }
}

// ── GET interstitial (renders only, never mutates) ──────────────────────────
function registerGet(action: Action): void {
  router.get(`/${action}/:id`, async (req: Request, res: Response) => {
    try {
      const approvalId = req.params["id"]!;
      const token = typeof req.query["token"] === "string" ? req.query["token"] : undefined;
      const guard = await resolveGuard(approvalId, token);
      if (respondForNonOkGuard(res, guard)) return;
      if (guard.kind !== "ok") return; // narrows for the compiler (unreachable)

      const a = guard.approval;
      res.type("html").send(
        renderBrandApprovalInterstitialPage({
          approvalId,
          token: token!,
          // Heading uses the real brand name (persisted; legacy rows fall back to
          // campaignName). The "for {campaignName}" phrase below stays the campaign.
          brandName: pageBrandName(a),
          creatorName: a.creatorName,
          creatorHandle: a.creatorHandle,
          creatorPlatform: a.creatorPlatform,
          campaignName: a.campaignName,
          terms: {
            fixedFee: a.fixedFee,
            commissionRate: a.commissionRate,
            negotiationFloor: a.negotiationFloor,
            negotiationCeiling: a.negotiationCeiling,
            deliverables: a.deliverables,
            timeline: a.timeline,
            paymentTerms: a.paymentTerms,
            rewardDescription: a.rewardDescription,
          },
          action,
        }),
      );
    } catch (err) {
      console.error(`[brandApproval] GET ${action} error:`, err);
      res.status(500).type("html").send(renderBrandApprovalInvalidPage());
    }
  });
}

registerGet("approve");
registerGet("reject");

// Shared POST body: validate token from the hidden field, resolve guard, mutate
// the row, drive the instance, render the result. Factored so approve/reject share
// the identical guard/idempotency handling and differ only in the decision + page.
async function handleDecisionPost(
  req: Request,
  res: Response,
  decision: "APPROVED" | "REJECTED",
): Promise<void> {
  const approvalId = req.params["id"]!;
  const token = tokenFromBody(req);
  const guard = await resolveGuard(approvalId, token);
  if (respondForNonOkGuard(res, guard)) return;
  if (guard.kind !== "ok") return; // narrows for the compiler (unreachable)

  const brandName = pageBrandName(guard.approval);
  const creatorName = guard.approval.creatorName;

  // ── Phase 1: CLAIM (AWAITING_APPROVAL → PROCESSING) — the idempotency lock ──
  // The WHERE requires AWAITING_APPROVAL, so a concurrent/duplicate POST (or a
  // request that races another) matches 0 rows → treat as already-actioned. The
  // row is NOT yet decided — PROCESSING is a short-lived claim, and the decision is
  // written ONLY after the workflow action succeeds (PLU-118, Calvin review §2).
  const claimed = await claimBrandApprovalForProcessing(approvalId, {
    decidedIp: clientIp(req),
    decidedUserAgent: clientUserAgent(req),
  });
  if (!claimed) {
    const latest = await findBrandApprovalById(approvalId);
    res.type("html").send(
      renderBrandApprovalAlreadyActionedPage({
        brandName,
        status: latest?.status ?? decision,
      }),
    );
    return;
  }

  // ── Phase 2: drive the instance. Only on SUCCESS do we finalize the decision. ─
  // handleBrandApproval requires AWAITING_BRAND_APPROVAL; a race that already
  // advanced it surfaces as StaleInstanceError. We distinguish three outcomes:
  //   success            → finalize PROCESSING → APPROVED/REJECTED, show result.
  //   already-advanced   → the effect is already realized by another actor; finalize
  //                        (record the brand's decision) and show the result.
  //   transient failure  → the instance is STILL parked in AWAITING_BRAND_APPROVAL;
  //                        REVERT PROCESSING → AWAITING_APPROVAL so the brand can
  //                        click the same link again, and show a retry-friendly page.
  const runtime = new WorkflowRuntime(emailProvider(), agentProvider());
  try {
    await runtime.handleBrandApproval(claimed.instanceId, decision, {
      source: "brand-approval-link",
      worker: "brand-approval-route",
    });
  } catch (err) {
    if (err instanceof StaleInstanceError) {
      // The instance already moved on (e.g. an opt-out landed first). The transition
      // this decision would drive is already realized; finalize the row so the
      // decision is recorded, then show the result.
      console.warn(
        `[brandApproval] instance ${claimed.instanceId} not in AWAITING_BRAND_APPROVAL on ${decision} — recording decision, skipping step`,
      );
      await finalizeBrandApprovalDecision(approvalId, { status: decision });
      renderResult(res, decision, brandName, creatorName);
      return;
    }
    // Any other failure. Re-read the instance: if it is STILL parked in the gate
    // state, the action did not take — revert the claim so the brand can retry.
    console.error(`[brandApproval] handleBrandApproval ${decision} error:`, err);
    const inst = await findInstanceById(claimed.instanceId).catch(() => null);
    if (!inst || inst.currentState === "AWAITING_BRAND_APPROVAL") {
      await revertBrandApprovalToAwaiting(approvalId).catch((revertErr) => {
        console.error(
          `[brandApproval] failed to revert PROCESSING → AWAITING_APPROVAL for ` +
            `${approvalId}; a stuck PROCESSING row can be re-driven via the manual ` +
            `queue resend. ${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
        );
      });
      res.status(500).type("html").send(renderBrandApprovalRetryPage({ brandName }));
      return;
    }
    // The instance left the gate state by some other path despite the error — the
    // effect is realized. Finalize and show the result rather than a stack trace.
    await finalizeBrandApprovalDecision(approvalId, { status: decision });
    renderResult(res, decision, brandName, creatorName);
    return;
  }

  // Success — finalize the decision now that the workflow action has completed.
  await finalizeBrandApprovalDecision(approvalId, { status: decision });
  renderResult(res, decision, brandName, creatorName);
}

/** The brand's display name for the page — the persisted brandName, falling back
 *  to campaignName for rows written before the brandName column existed. */
function pageBrandName(approval: BrandApproval): string {
  return approval.brandName ?? approval.campaignName ?? "Your brand";
}

/** Render the terminal approve/reject result page for a finalized decision. */
function renderResult(
  res: Response,
  decision: "APPROVED" | "REJECTED",
  brandName: string,
  creatorName: string,
): void {
  res
    .type("html")
    .send(
      decision === "APPROVED"
        ? renderBrandApprovedPage({ brandName, creatorName })
        : renderBrandRejectedPage({ brandName, creatorName }),
    );
}

// ── POST approve — AWAITING_APPROVAL → APPROVED (sends the brief) ────────────
router.post("/approve/:id", async (req: Request, res: Response) => {
  try {
    await handleDecisionPost(req, res, "APPROVED");
  } catch (err) {
    console.error("[brandApproval] POST approve error:", err);
    if (!res.headersSent) {
      res.status(500).type("html").send(renderBrandApprovalInvalidPage());
    }
  }
});

// ── POST reject — AWAITING_APPROVAL → REJECTED → MANUAL_REVIEW ───────────────
router.post("/reject/:id", async (req: Request, res: Response) => {
  try {
    await handleDecisionPost(req, res, "REJECTED");
  } catch (err) {
    console.error("[brandApproval] POST reject error:", err);
    if (!res.headersSent) {
      res.status(500).type("html").send(renderBrandApprovalInvalidPage());
    }
  }
});

function tokenFromBody(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const t = body?.["token"];
  return typeof t === "string" ? t : undefined;
}

export default router;
