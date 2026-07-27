import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import {
  findBrandApprovalById,
  claimBrandApprovalForProcessing,
  finalizeBrandApprovalDecision,
  revertBrandApprovalToAwaiting,
  findInstanceById,
  listEventsByInstance,
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
  renderBrandApprovalHandledElsewherePage,
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
  //   already-realized   → the instance left the gate AND reached the state THIS
  //                        decision produces (verified — not merely "moved"); a
  //                        concurrent retry of the SAME decision already did the
  //                        work. Finalize and show the result.
  //   diverged           → the instance left the gate to some OTHER state (a racing
  //                        opt-out, or the OTHER decision won). Recording THIS
  //                        decision would lie. Revert the claim (un-strand the row)
  //                        and show a safe already-actioned notice — never finalize.
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
      // The instance already left AWAITING_BRAND_APPROVAL. Leaving the gate does NOT
      // prove THIS decision succeeded — a concurrent opt-out or the OTHER decision
      // could have moved it (PLU-118, Calvin review §3). Verify the instance reached
      // the state THIS decision produces before recording it.
      await finalizeIfDecisionRealized(res, approvalId, claimed.instanceId, decision, brandName, creatorName);
      return;
    }
    // Any other failure. Re-read the instance: if it is STILL parked in the gate
    // state, the action did not take — revert the claim so the brand can retry.
    console.error(`[brandApproval] handleBrandApproval ${decision} error:`, err);
    const inst = await findInstanceById(claimed.instanceId).catch(() => null);
    if (!inst || inst.currentState === "AWAITING_BRAND_APPROVAL") {
      await revertClaim(approvalId);
      res.status(500).type("html").send(renderBrandApprovalRetryPage({ brandName }));
      return;
    }
    // The instance left the gate state by some other path despite the error. Same
    // rule as the StaleInstanceError branch: only finalize if the instance reached
    // the state THIS decision produces — otherwise a diverging transition would get
    // the wrong decision recorded (PLU-118, Calvin review §3).
    await finalizeIfDecisionRealized(res, approvalId, claimed.instanceId, decision, brandName, creatorName);
    return;
  }

  // Success — finalize the decision now that the workflow action has completed.
  await finalizeBrandApprovalDecision(approvalId, { status: decision });
  renderResult(res, decision, brandName, creatorName);
}

/**
 * The instance has LEFT AWAITING_BRAND_APPROVAL but this request's own
 * handleBrandApproval call did not complete (it raced another actor). Record THIS
 * decision ONLY if the instance actually reached the state this decision produces
 * (PLU-118, Calvin review §3): leaving the gate is necessary but NOT sufficient —
 * a racing opt-out (→ OPTED_OUT / MANUAL_REVIEW without BRAND_REJECTED) or the
 * OTHER decision winning the claim would otherwise cause the WRONG decision to be
 * recorded. If the realized state doesn't match, we do NOT finalize this decision;
 * we revert the PROCESSING claim (so the row is never stranded) and show a safe
 * already-actioned notice reflecting where the instance truly landed.
 */
async function finalizeIfDecisionRealized(
  res: Response,
  approvalId: string,
  instanceId: string,
  decision: "APPROVED" | "REJECTED",
  brandName: string,
  creatorName: string,
): Promise<void> {
  const realized = await decisionEffectRealized(instanceId, decision).catch((err) => {
    // A verification read failed. Fail SAFE: do not record an unverified decision.
    console.error(
      `[brandApproval] decision-verification read failed for ${instanceId} (${decision}):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  });

  if (realized) {
    console.warn(
      `[brandApproval] instance ${instanceId} already reached the ${decision} outcome ` +
        `by a concurrent actor — recording the decision, skipping the step`,
    );
    await finalizeBrandApprovalDecision(approvalId, { status: decision });
    renderResult(res, decision, brandName, creatorName);
    return;
  }

  // The instance diverged (a different decision or an opt-out won). Recording THIS
  // decision would misrepresent what happened. Un-strand the claim and surface a
  // safe, neutral "handled elsewhere" notice — NOT a fabricated approved/rejected
  // result, and NOT the reverted row's AWAITING_APPROVAL status (which would read
  // as a nonsensical "already awaiting_approval"). The deal's true state lives on
  // the instance and is surfaced to the operator via the Manual Queue.
  console.warn(
    `[brandApproval] instance ${instanceId} left AWAITING_BRAND_APPROVAL WITHOUT the ${decision} ` +
      `outcome — NOT recording ${decision}; reverting the claim and showing a neutral notice`,
  );
  await revertClaim(approvalId);
  res.type("html").send(renderBrandApprovalHandledElsewherePage({ brandName }));
}

/**
 * Verify the instance reached the state THIS decision produces, using BOTH the
 * current state AND a corroborating audit event so a same-target-state divergence
 * can't masquerade as success:
 *   APPROVED → PAYMENT_PENDING (the content brief was sent) with a BRAND_APPROVED event.
 *   REJECTED → MANUAL_REVIEW with a BRAND_REJECTED event. The event matters: an
 *              opt-out also lands in MANUAL_REVIEW but writes NO BRAND_REJECTED, so
 *              the state alone would false-positive.
 */
async function decisionEffectRealized(
  instanceId: string,
  decision: "APPROVED" | "REJECTED",
): Promise<boolean> {
  const inst = await findInstanceById(instanceId);
  if (!inst) return false;
  const expected = expectedOutcomeFor(decision);
  if (inst.currentState !== expected.state) return false;
  const events = await listEventsByInstance(instanceId, { type: expected.event });
  return events.length > 0;
}

/**
 * The state + corroborating audit event a completed brand decision produces. Pure
 * (no I/O) so the decision-verification rule (PLU-118, Calvin review §3) can be
 * unit-tested directly. Kept in one place so the route and its tests can't drift.
 */
export function expectedOutcomeFor(
  decision: "APPROVED" | "REJECTED",
): { state: "PAYMENT_PENDING" | "MANUAL_REVIEW"; event: "BRAND_APPROVED" | "BRAND_REJECTED" } {
  return decision === "APPROVED"
    ? { state: "PAYMENT_PENDING", event: "BRAND_APPROVED" }
    : { state: "MANUAL_REVIEW", event: "BRAND_REJECTED" };
}

/** Revert a PROCESSING claim to AWAITING_APPROVAL, logging (never throwing) on
 *  failure. A stuck PROCESSING row is separately recovered by the operator resend
 *  and the poller stale-claim sweep (PLU-118 §1). */
async function revertClaim(approvalId: string): Promise<void> {
  await revertBrandApprovalToAwaiting(approvalId).catch((revertErr) => {
    console.error(
      `[brandApproval] failed to revert PROCESSING → AWAITING_APPROVAL for ` +
        `${approvalId}; a stuck PROCESSING row is recovered by the manual-queue ` +
        `resend or the poller stale-claim sweep. ` +
        `${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
    );
  });
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
