import { and, asc, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  connectedEmailAccounts,
  type ConnectedEmailAccount,
  type ConnectedEmailAccountInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Connected email accounts (PLU-121) — DB access layer
// ---------------------------------------------------------------------------
// One row per connected Nylas mailbox (grant). Reads are used at three seams:
//   - enrollment       → resolve the campaign's (or the default) account to PIN.
//   - send finalize    → build the per-account provider from the pinned grant.
//   - webhook intake   → map an inbound event's grant id back to an account.
// Writes come from the accounts-registration API (routes/emailAccounts.ts).

/** List all connected accounts, newest first — for the API + the sender picker. */
export async function listEmailAccounts(): Promise<ConnectedEmailAccount[]> {
  return db
    .select()
    .from(connectedEmailAccounts)
    .orderBy(asc(connectedEmailAccounts.createdAt));
}

/** List only accounts eligible to send/receive (status = active). */
export async function listActiveEmailAccounts(): Promise<ConnectedEmailAccount[]> {
  return db
    .select()
    .from(connectedEmailAccounts)
    .where(eq(connectedEmailAccounts.status, "active"))
    .orderBy(asc(connectedEmailAccounts.createdAt));
}

export async function findEmailAccountById(
  id: string,
): Promise<ConnectedEmailAccount | null> {
  const rows = await db
    .select()
    .from(connectedEmailAccounts)
    .where(eq(connectedEmailAccounts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve an account by its Nylas grant id — the webhook's routing key. */
export async function findEmailAccountByGrantId(
  nylasGrantId: string,
): Promise<ConnectedEmailAccount | null> {
  const rows = await db
    .select()
    .from(connectedEmailAccounts)
    .where(eq(connectedEmailAccounts.nylasGrantId, nylasGrantId))
    .limit(1);
  return rows[0] ?? null;
}

/** The fallback sender: the single account flagged isDefault (a partial unique
 *  index guarantees at most one), else null when none is configured. */
export async function findDefaultEmailAccount(): Promise<ConnectedEmailAccount | null> {
  const rows = await db
    .select()
    .from(connectedEmailAccounts)
    .where(
      and(
        eq(connectedEmailAccounts.isDefault, true),
        eq(connectedEmailAccounts.status, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the account a NEW run should be pinned to, in priority order:
 *   1. the campaign's chosen account (when set + active), else
 *   2. the default account.
 * Returns null when neither resolves (no accounts configured yet) — the caller
 * then leaves emailAccountId null and the send path falls back to the env grant,
 * exactly as before multi-mailbox.
 */
export async function resolveAccountForCampaign(
  campaignEmailAccountId: string | null | undefined,
): Promise<ConnectedEmailAccount | null> {
  if (campaignEmailAccountId) {
    const chosen = await findEmailAccountById(campaignEmailAccountId);
    if (chosen && chosen.status === "active") return chosen;
  }
  return findDefaultEmailAccount();
}

export async function createEmailAccount(
  data: ConnectedEmailAccountInsert,
): Promise<ConnectedEmailAccount> {
  const rows = await db.insert(connectedEmailAccounts).values(data).returning();
  return rows[0]!;
}

/** Patchable fields from the registration/management API. */
export type EmailAccountPatch = Partial<
  Pick<
    ConnectedEmailAccountInsert,
    "emailAddress" | "displayName" | "status" | "isDefault" | "webhookSecret"
  >
>;

export async function updateEmailAccount(
  id: string,
  patch: EmailAccountPatch,
): Promise<ConnectedEmailAccount> {
  const rows = await db
    .update(connectedEmailAccounts)
    .set(patch)
    .where(eq(connectedEmailAccounts.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error(`ConnectedEmailAccount ${id} not found`);
  return updated;
}
