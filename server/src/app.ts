import express from "express";
import type { Express } from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./db/drizzle.js";
import { globalRateLimiter, publicRateLimiter } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import queuesRouter from "./routes/queues.js";
import webhooksRouter from "./routes/webhooks.js";
import observabilityRouter from "./routes/observability.js";
import campaignsRouter from "./routes/campaigns.js";
import workflowsRouter from "./routes/workflows.js";
import manualQueueRouter from "./routes/manualQueue.js";
import creatorsRouter from "./routes/creators.js";
import creatorImportsRouter from "./routes/creatorImports.js";
import paymentRouter from "./routes/payment.js";
import uploadsRouter from "./routes/uploads.js";
import trackingRouter from "./routes/tracking.js";
import attributionRouter from "./routes/attribution.js";
import partnershipsRouter from "./routes/partnerships.js";
import payoutsRouter from "./routes/payouts.js";
import payoutConfirmRouter from "./routes/payoutConfirm.js";
import brandApprovalRouter from "./routes/brandApproval.js";
import { requireOperatorKey } from "./middleware/requireOperatorKey.js";

// ---------------------------------------------------------------------------
// Express app factory (HARD-A1)
// ---------------------------------------------------------------------------
// The HTTP surface, extracted from index.ts so the API can be started as its
// OWN process (separate from the workers + scheduler) while all three share this
// one route wiring. Building the app is side-effect-free — it does NOT start
// workers, the scheduler, or the HTTP listener; the entrypoint owns that. This
// is the prerequisite for scaling the API independently of the worker fleet
// (HARD-S1) and running the scheduler as a single leader.

export function createApp(): Express {
  const app = express();

  // -------------------------------------------------------------------------
  // Security headers (BUG-SEC2) + info-disclosure hardening.
  // -------------------------------------------------------------------------
  // Live audit: X-Powered-By: Express leaked and there were ZERO security
  // headers. `helmet` adds the standard defensive set (X-Content-Type-Options,
  // X-Frame-Options via frameguard, Referrer-Policy, etc.) and disables the
  // powered-by banner. The CSP is relaxed for the served SPA: the Vite build ships
  // inline styles and the dashboard talks to same-origin /api, so a strict default
  // CSP would break it. We keep a CSP present but permissive enough for the SPA
  // (self + inline styles/scripts + same-origin XHR). HSTS is left to the TLS
  // terminator (Render) — enabling it here on a possibly-HTTP local origin is a
  // footgun; the reverse proxy owns HSTS in prod.
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "frame-ancestors": ["'none'"],
          // The SPA sets no <base>; upgrade-insecure-requests would break a plain
          // http:// local origin. Leave it to the proxy.
          "upgrade-insecure-requests": null,
        },
      },
      // HSTS handled by the TLS terminator; do not force it from the app.
      hsts: false,
      // Allow the SPA to be embedded/served without COEP tripping asset loads.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // -------------------------------------------------------------------------
  // Rate limiting (BUG-SEC1) — generous global bucket on every request.
  // -------------------------------------------------------------------------
  // A tighter bucket for the unauthenticated public/magic-link/webhook routes is
  // applied at their mount points below. Both return a clean 429 JSON body and
  // are env-tunable (set *_MAX=0 to disable, e.g. for load tests).
  app.use(globalRateLimiter());

  // Webhooks (Phase 6) — MUST be mounted before express.json(). Nylas signs the
  // RAW request body; signature verification needs the exact bytes, so this route
  // uses a raw body parser. GET (challenge) carries no body, so the raw parser is
  // a harmless no-op there. Carries the tighter public rate-limit bucket
  // (BUG-SEC1) — signed, but still an unauthenticated external POST surface.
  const publicLimiter = publicRateLimiter();
  app.use("/webhooks", publicLimiter, express.raw({ type: "*/*", limit: "2mb" }), webhooksRouter);

  app.use(express.json());

  // Health endpoints
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "server", timestamp: new Date().toISOString() });
  });

  // DB health: verifies the db client can reach PostgreSQL.
  app.get("/health/db", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", service: "database", timestamp: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: "error", service: "database", message });
    }
  });

  // -------------------------------------------------------------------------
  // P2 — operator-route gate. `requireOperatorKey` (X-Operator-Key vs
  // OPERATOR_API_KEY) is mounted on the OPERATOR routers only. The
  // creator/webhook-facing routers (/webhooks, /payment, /t, /attribution,
  // /payout) are intentionally left OPEN — a creator's email magic link and the
  // inbound webhooks must reach them with no operator key. See the route
  // inventory in the go-live plan (P2). Health endpoints above are also open
  // (uptime probes). Gating is open-when-unset in dev; the startup guard
  // (config/requiredSecrets.ts) refuses to boot in prod without the key.
  // -------------------------------------------------------------------------

  // OPERATOR routers (gated) --------------------------------------------------
  // Phase 4 — Queue routes (health/jobs leak internals; injection POSTs already
  // 404 in prod, gated here too for defense in depth).
  app.use("/queues", requireOperatorKey, queuesRouter);
  // Phase 9 — Observability dashboard APIs (leak every creator email/transcript/
  // payout destination).
  app.use("/observability", requireOperatorKey, observabilityRouter);
  // Phase 10 — Workflow Builder APIs (create + cascade-DELETE a campaign).
  app.use("/campaigns", requireOperatorKey, campaignsRouter);
  app.use("/workflows", requireOperatorKey, workflowsRouter);
  // Phase 11 — Manual Queue (escalated-creator data + notify mutation).
  app.use("/manual-queue", requireOperatorKey, manualQueueRouter);
  // Creator roster + CSV import — used by the enrollment UI.
  // Mounted BEFORE /creators so "/creators/imports" is not swallowed by the
  // roster router's own "/" and ":id" handlers.
  app.use("/creators/imports", requireOperatorKey, creatorImportsRouter);
  app.use("/creators", requireOperatorKey, creatorsRouter);
  // Phase 16 — Content Brief: brand file uploads (Campaign Brief PDF).
  app.use("/uploads", requireOperatorKey, uploadsRouter);
  app.use("/partnerships", requireOperatorKey, partnershipsRouter);
  // Phase 3 (Payout ledger) — brand-side payout actions: mark paid, resend,
  // settle money, PayPal CSV export. ALL operator (the creator-facing confirm/
  // dispute pages live on the SEPARATE /payout router below, left open).
  app.use("/payouts", requireOperatorKey, payoutsRouter);

  // OPEN routers (creator magic-link / webhooks / public — NEVER gated) --------
  // These are the unauthenticated, token-guessable surface, so each carries the
  // tighter public rate-limit bucket (BUG-SEC1) on top of the global one.
  // Phase 15 — Payment Info: hosted payout-information page (creator magic-link).
  app.use("/payment", publicLimiter, paymentRouter);
  // Phase 2 (Attribution) — public short-link redirect + conversion webhook
  // (/attribution has its OWN X-Attribution-Secret gate, P1).
  app.use("/t", publicLimiter, trackingRouter);
  app.use("/attribution", publicLimiter, attributionRouter);
  // Phase 3 (Payout ledger) — creator-facing confirm/dispute magic-link pages
  // (GET renders, POST mutates — I-5). Token-gated; must reach creators with no
  // operator key. Distinct from the operator /payouts router above.
  app.use("/payout", publicLimiter, payoutConfirmRouter);
  // Brand-approval gate — brand-facing approve/reject magic-link pages (GET
  // renders, POST mutates — same I-5 precedent). Token-gated; must reach the brand
  // with no operator key, same as the payout confirm/dispute pages.
  app.use("/brand-approval", publicLimiter, brandApprovalRouter);

  // -------------------------------------------------------------------------
  // Static SPA (single-origin deploy) — serve the built dashboard.
  // -------------------------------------------------------------------------
  // On Replit (single Reserved VM) the web/ SPA is built to web/dist and served
  // from THIS server so `/api/*` is same-origin (the SPA's client uses a relative
  // /api base — see web/src/api/client.ts). Mounted LAST so every API, webhook,
  // and creator magic-link route above wins; only unmatched GETs fall through to
  // the SPA. Opt-in by the dist dir existing: absent in local dev (Vite serves
  // the SPA on its own port) and in a split deploy → this whole block is a no-op.
  const webDist =
    process.env["WEB_DIST_DIR"] ??
    resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web/dist");
  if (existsSync(webDist)) {
    // The SPA's API clients use a relative "/api/..." base (web/src/api/*), but
    // the operator routers above are mounted at their bare paths. Re-mount the
    // operator API under /api so same-origin SPA calls resolve. Same routers, same
    // requireOperatorKey gate — only the URL prefix differs. (These are the 8
    // prefixes the web build actually calls; the bare mounts above still serve any
    // non-browser client.)
    const apiRouter = express.Router();
    apiRouter.use("/observability", requireOperatorKey, observabilityRouter);
    apiRouter.use("/campaigns", requireOperatorKey, campaignsRouter);
    apiRouter.use("/workflows", requireOperatorKey, workflowsRouter);
    apiRouter.use("/manual-queue", requireOperatorKey, manualQueueRouter);
    apiRouter.use("/creators/imports", requireOperatorKey, creatorImportsRouter);
    apiRouter.use("/creators", requireOperatorKey, creatorsRouter);
    apiRouter.use("/uploads", requireOperatorKey, uploadsRouter);
    apiRouter.use("/partnerships", requireOperatorKey, partnershipsRouter);
    apiRouter.use("/payouts", requireOperatorKey, payoutsRouter);
    app.use("/api", apiRouter);

    app.use(express.static(webDist));
    // SPA history fallback: any other GET that isn't an API/asset returns index.html.
    app.get("*", (req, res, next) => {
      if (req.method !== "GET") return next();
      res.sendFile(resolve(webDist, "index.html"));
    });
  }

  // -------------------------------------------------------------------------
  // Global error handler (BUG-API1) — MUST be mounted LAST. Turns any unhandled
  // error (incl. the body-parser JSON SyntaxError from express.json() above) into
  // a clean JSON response with no stack/path leak unless NODE_ENV=development.
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return app;
}
