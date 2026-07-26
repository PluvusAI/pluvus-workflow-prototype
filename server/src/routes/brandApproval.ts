import { Router, urlencoded } from "express";
import type { Request, Response } from "express";
import {
  findBrandApprovalById,
  markBrandApprovalDecided,
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
        .send(renderBrandApprovalExpiredPage({ brandName: guard.approval.campaignName }));
      return true;
    case "already":
      res.type("html").send(
        renderBrandApprovalAlreadyActionedPage({
          brandName: guard.approval.campaignName ?? "Your brand",
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
          brandName: a.campaignName ?? "Your brand",
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

  const brandName = guard.approval.campaignName ?? "Your brand";
  const creatorName = guard.approval.creatorName;

  // Mutate the row first (idempotency lock): the WHERE requires AWAITING_APPROVAL,
  // so a concurrent/duplicate POST makes this a no-op → treat as already-actioned.
  const updated = await markBrandApprovalDecided(approvalId, {
    status: decision,
    decidedIp: clientIp(req),
    decidedUserAgent: clientUserAgent(req),
  });
  if (!updated) {
    const latest = await findBrandApprovalById(approvalId);
    res.type("html").send(
      renderBrandApprovalAlreadyActionedPage({
        brandName,
        status: latest?.status ?? decision,
      }),
    );
    return;
  }

  // Drive the instance. handleBrandApproval requires AWAITING_BRAND_APPROVAL; a
  // race that already advanced it surfaces as StaleInstanceError → the row is
  // decided regardless, so render the result page (the decision is recorded).
  const runtime = new WorkflowRuntime(emailProvider(), agentProvider());
  try {
    await runtime.handleBrandApproval(updated.instanceId, decision, {
      source: "brand-approval-link",
      worker: "brand-approval-route",
    });
  } catch (err) {
    if (err instanceof StaleInstanceError) {
      // The instance already moved on (e.g. an opt-out landed first). The decision
      // is recorded on the row; show the result rather than an error.
      console.warn(
        `[brandApproval] instance ${updated.instanceId} not in AWAITING_BRAND_APPROVAL on ${decision} — decision recorded, skipping step`,
      );
    } else {
      // A wrong-state error (instance not AWAITING) or other failure. The row is
      // already decided; surface the result page rather than a stack trace, but log.
      console.error(`[brandApproval] handleBrandApproval ${decision} error:`, err);
      // If the instance genuinely wasn't in the gate state, still show the page —
      // the operator can reconcile via the Manual Queue.
      const inst = await findInstanceById(updated.instanceId).catch(() => null);
      if (inst && inst.currentState === "AWAITING_BRAND_APPROVAL") {
        // A transient failure mid-step and the instance is still parked — surface a
        // retry-friendly error so the brand can click again.
        res
          .status(500)
          .type("html")
          .send(renderBrandApprovalInvalidPage());
        return;
      }
    }
  }

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
