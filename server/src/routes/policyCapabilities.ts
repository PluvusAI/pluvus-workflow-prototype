// ---------------------------------------------------------------------------
// PLU-172 — GET /policy-capabilities
// ---------------------------------------------------------------------------
// Serves POLICY_CAPABILITIES (domain/policyCapabilities.ts) as-is. This is
// the endpoint PLU-173's own description asks to consume ("Consume
// PLU-172's backend capability map rather than duplicating support rules in
// the frontend") instead of PLU-173 re-deriving the same information
// client-side.
//
// Deliberately campaign-agnostic (mounted at /policy-capabilities, NOT
// /campaigns/:id/policy-capabilities) — capability is a property of THIS
// DEPLOYMENT of Pluvus (which evaluators are wired), not of any one
// campaign, and can only change by deploying new code, never at runtime.
// See docs/plu-172-private-policy-contract-plan.md §3.7/§6.3.

import { Router } from "express";
import type { Request, Response } from "express";
import { POLICY_CAPABILITIES } from "../domain/policyCapabilities.js";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({ capabilities: POLICY_CAPABILITIES });
});

export default router;
