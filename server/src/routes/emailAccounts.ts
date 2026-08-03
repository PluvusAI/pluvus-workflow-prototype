import { Router } from "express";
import type { Request, Response } from "express";
import {
  listEmailAccounts,
  findEmailAccountById,
  findEmailAccountByGrantId,
  createEmailAccount,
  updateEmailAccount,
} from "../db/emailAccounts.js";
import { isUniqueViolation } from "../db/errors.js";
import type { ConnectedEmailAccount } from "../db/schema.js";
import { UNCONFIGURED_NYLAS_GRANT_ID } from "../db/migrationSession.js";

// ---------------------------------------------------------------------------
// Connected email accounts (PLU-121) — registration + management API
// ---------------------------------------------------------------------------
// Multi-mailbox connect flow for the prototype: an operator connects each mailbox
// in the Nylas dashboard, then registers its grant id here as a
// ConnectedEmailAccount. The campaign wizard's sender picker reads GET /; the send
// path and webhook intake resolve accounts by id / grant id. (A hosted-OAuth
// "Connect account" callback that creates these rows automatically is a clean
// follow-up; the data model and every downstream seam are already account-aware.)

const router = Router();

const STATUSES = ["active", "disabled", "revoked"] as const;
type AccountStatus = (typeof STATUSES)[number];
function isStatus(v: unknown): v is AccountStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

function isEmailish(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Grant ids are opaque mailbox handles, not raw credentials. Webhook delivery is
// authenticated once at the Nylas-application level via NYLAS_WEBHOOK_SECRET.
function toDto(a: ConnectedEmailAccount) {
  return {
    id: a.id,
    nylasGrantId: a.nylasGrantId,
    emailAddress: a.emailAddress,
    displayName: a.displayName,
    provider: a.provider,
    status: a.status,
    isDefault: a.isDefault,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// GET /email-accounts — list connected accounts (for the sender picker + admin).
router.get("/", async (_req: Request, res: Response) => {
  try {
    const accounts = await listEmailAccounts();
    res.json(accounts.map(toDto));
  } catch (err) {
    console.error("[email-accounts] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /email-accounts — register a connected mailbox by its Nylas grant id.
router.post("/", async (req: Request, res: Response) => {
  const { nylasGrantId, emailAddress, displayName, isDefault } =
    req.body as {
      nylasGrantId?: string;
      emailAddress?: string;
      displayName?: string;
      isDefault?: boolean;
    };

  if (!nylasGrantId || typeof nylasGrantId !== "string" || !nylasGrantId.trim()) {
    res.status(400).json({ error: "nylasGrantId is required" });
    return;
  }
  if (nylasGrantId.trim() === UNCONFIGURED_NYLAS_GRANT_ID) {
    res.status(400).json({ error: "nylasGrantId is reserved for an unconfigured migration seed" });
    return;
  }
  if (!emailAddress || typeof emailAddress !== "string" || !isEmailish(emailAddress.trim())) {
    res.status(400).json({ error: "emailAddress must be a valid email address" });
    return;
  }

  try {
    // Reject a duplicate grant with a clear 409 rather than a raw unique-violation
    // 500 — the grant id is @unique (one account per mailbox).
    const existing = await findEmailAccountByGrantId(nylasGrantId.trim());
    if (existing) {
      res.status(409).json({ error: "an account with this grant id already exists" });
      return;
    }
    const account = await createEmailAccount({
      nylasGrantId: nylasGrantId.trim(),
      emailAddress: emailAddress.trim(),
      displayName:
        typeof displayName === "string" ? displayName.trim() || null : null,
      isDefault: isDefault === true,
    });
    res.status(201).json(toDto(account));
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost a race on the unique grant id, or two defaults (partial unique index).
      res.status(409).json({ error: "conflict: duplicate grant id or default account" });
      return;
    }
    console.error("[email-accounts] create error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PATCH /email-accounts/:id — update address/name, enable/disable, set default.
// Disconnect = set status to "disabled" or "revoked"; other accounts are
// unaffected, and no historical campaign/run/message is destroyed. Accounts
// with message history are intentionally retained as disabled/revoked tombstones
// so their grant-local provider-id namespace and audit attribution remain intact.
router.patch("/:id", async (req: Request, res: Response) => {
  const { emailAddress, displayName, status, isDefault } =
    (req.body ?? {}) as {
      emailAddress?: string;
      displayName?: string | null;
      status?: string;
      isDefault?: boolean;
    };

  const patch: Parameters<typeof updateEmailAccount>[1] = {};
  if (emailAddress !== undefined) {
    if (typeof emailAddress !== "string" || !isEmailish(emailAddress.trim())) {
      res.status(400).json({ error: "emailAddress must be a valid email address" });
      return;
    }
    patch.emailAddress = emailAddress.trim();
  }
  if (displayName !== undefined) {
    patch.displayName = typeof displayName === "string" ? displayName.trim() || null : null;
  }
  if (status !== undefined) {
    if (!isStatus(status)) {
      res.status(400).json({ error: `status must be one of: ${STATUSES.join(", ")}` });
      return;
    }
    patch.status = status;
  }
  if (isDefault !== undefined) patch.isDefault = isDefault === true;

  try {
    const existing = await findEmailAccountById(req.params["id"]!);
    if (!existing) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    if (
      existing.nylasGrantId === UNCONFIGURED_NYLAS_GRANT_ID &&
      (patch.status === "active" || patch.isDefault === true)
    ) {
      res.status(400).json({
        error: "the unconfigured migration seed cannot be activated or made default",
      });
      return;
    }
    const effectiveStatus = patch.status ?? existing.status;
    if (patch.isDefault === true && effectiveStatus !== "active") {
      res.status(400).json({ error: "only an active account can be the default" });
      return;
    }
    // Disabling/revoking the current default must release the partial-unique slot
    // so another active account can become the fallback sender.
    if (patch.status !== undefined && patch.status !== "active" && existing.isDefault) {
      patch.isDefault = false;
    }
    if (Object.keys(patch).length === 0) {
      res.json(toDto(existing));
      return;
    }
    const account = await updateEmailAccount(req.params["id"]!, patch);
    res.json(toDto(account));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "conflict: another account is already the default" });
      return;
    }
    console.error("[email-accounts] update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
