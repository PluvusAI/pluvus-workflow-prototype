import { and, asc, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  connectedEmailAccounts,
  type ConnectedEmailAccount,
  type ConnectedEmailAccountInsert,
} from "./schema.js";
import { UNCONFIGURED_NYLAS_GRANT_ID } from "./migrationSession.js";

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

export class EmailAccountUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailAccountUnavailableError";
  }
}

/**
 * Resolve the account a NEW run should be pinned to:
 *   1. an explicitly chosen campaign account must still exist and be active;
 *      otherwise fail closed rather than silently switching sender identity;
 *   2. a campaign with no explicit choice uses the active default account.
 * Returns null only outside a Nylas deployment when no active default exists;
 * a Nylas enrollment without an active account fails closed.
 */
export async function resolveAccountForCampaign(
  campaignEmailAccountId: string | null | undefined,
): Promise<ConnectedEmailAccount | null> {
  const isNylas = (process.env["EMAIL_PROVIDER"] ?? "").toLowerCase() === "nylas";
  if (campaignEmailAccountId) {
    const chosen = await findEmailAccountById(campaignEmailAccountId);
    if (!chosen) {
      throw new EmailAccountUnavailableError(
        `Campaign email account ${campaignEmailAccountId} no longer exists`,
      );
    }
    // A grant-less PLU-121 migration deliberately backfills existing rows to a
    // disabled sentinel for auditability. In mock/non-Nylas environments that
    // sentinel represents "no real mailbox", so preserve legacy enrollment by
    // leaving the run unpinned. Nylas remains fail-closed below.
    if (chosen.nylasGrantId === UNCONFIGURED_NYLAS_GRANT_ID && !isNylas) {
      return null;
    }
    if (chosen.status !== "active") {
      throw new EmailAccountUnavailableError(
        `Campaign email account ${campaignEmailAccountId} is ${chosen.status}`,
      );
    }
    return chosen;
  }
  const fallback = await findDefaultEmailAccount();
  if (!fallback && isNylas) {
    throw new EmailAccountUnavailableError(
      "No active default email account is configured for this campaign",
    );
  }
  return fallback;
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
    "emailAddress" | "displayName" | "status" | "isDefault"
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
