import { and, eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  brandApprovals,
  type BrandApproval,
  type BrandApprovalInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// BrandApproval — the snapshot the brand approves/rejects (brand-approval gate).
// ---------------------------------------------------------------------------
// One row per ExecutionInstance, enforced by a UNIQUE instanceId. That constraint
// anchors idempotency: the brand-approval executor runs inside a BullMQ job that may
// be retried, so `createBrandApprovalOnce` swallows the unique violation and returns
// the row that already exists — reporting `created` so the executor knows whether
// the freshly minted token matches the stored hash or must be rotated in (PLU-118
// §1). The decision itself is a two-phase claim: claimBrandApprovalForProcessing
// (AWAITING_APPROVAL → PROCESSING) is the lock, and the terminal decision is written
// by finalizeBrandApprovalDecision (→ APPROVED/REJECTED) ONLY after the workflow
// action succeeds — revertBrandApprovalToAwaiting undoes a failed claim so the brand
// can retry (PLU-118 §2). Every transition is predicate-guarded, so the decision is
// written exactly once no matter how many retries or double-clicks occur.

/** Result of createBrandApprovalOnce — the row plus whether THIS call inserted it. */
export interface CreateBrandApprovalResult {
  approval: BrandApproval;
  /** True when this call inserted the row; false when it already existed and was
   *  returned (a retry). The executor uses this to decide whether the freshly
   *  minted raw token matches the stored hash (fresh insert → yes) or whether it
   *  must rotate/skip the send (existing row → the stored hash is from an EARLIER
   *  mint, so re-emailing the new raw token would produce non-matching links). */
  created: boolean;
}

/**
 * Insert the approval snapshot, or return the existing row if one is already
 * there. Never throws on a duplicate. `created` distinguishes a fresh insert from
 * a retry that found an existing row — CRITICAL for token consistency: on a retry
 * the caller must NOT email links derived from a newly minted token (its hash
 * won't match the row's stored hash from the first attempt). See
 * rotateBrandApprovalToken + the executor (PLU-118, Calvin review §1).
 */
export async function createBrandApprovalOnce(
  data: BrandApprovalInsert,
  client: Db | DbTx = db,
): Promise<CreateBrandApprovalResult> {
  try {
    const rows = await client.insert(brandApprovals).values(data).returning();
    return { approval: rows[0]!, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findBrandApprovalByInstance(data.instanceId, client);
      if (existing) return { approval: existing, created: false };
    }
    throw err;
  }
}

/**
 * Rotate the magic-link token on an approval that is still AWAITING_APPROVAL:
 * overwrite approveTokenHash + tokenExpiresAt together (never one without the
 * other) and return the updated row. Used when:
 *   - a retry finds an existing UNSENT row (the first attempt crashed after the
 *     insert but before the email reserved), so the row's stored hash is from a
 *     raw token that never went out — we rotate to the token we are about to send
 *     so the emailed links match, and
 *   - an operator resends an approval whose token was lost or has expired.
 *
 * Predicate-guarded on AWAITING_APPROVAL so a rotation can never disturb an
 * already-decided (or in-flight PROCESSING) row. Returns null when nothing
 * matched — the caller then treats the approval as no-longer-rotatable.
 */
export async function rotateBrandApprovalToken(
  id: string,
  token: { approveTokenHash: string; tokenExpiresAt: Date | null },
  client: Db | DbTx = db,
): Promise<BrandApproval | null> {
  const rows = await client
    .update(brandApprovals)
    .set({
      approveTokenHash: token.approveTokenHash,
      tokenExpiresAt: token.tokenExpiresAt,
    })
    .where(
      and(
        eq(brandApprovals.id, id),
        eq(brandApprovals.status, "AWAITING_APPROVAL"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function findBrandApprovalById(
  id: string,
  client: Db | DbTx = db,
): Promise<BrandApproval | null> {
  const rows = await client
    .select()
    .from(brandApprovals)
    .where(eq(brandApprovals.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBrandApprovalByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<BrandApproval | null> {
  const rows = await client
    .select()
    .from(brandApprovals)
    .where(eq(brandApprovals.instanceId, instanceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * CLAIM an approval for processing: AWAITING_APPROVAL → PROCESSING.
 *
 * This is the idempotency lock for a brand decision. Predicate-guarded on
 * AWAITING_APPROVAL, so a double-click, a mail-scanner prefetch double-POST, or a
 * retried request that races the first claim matches 0 rows and returns null —
 * the caller then treats it as "someone else is handling / already handled" and
 * renders a safe notice, WITHOUT running the workflow action a second time.
 *
 * Crucially the row is NOT yet decided. The decision (APPROVED/REJECTED) is
 * written by finalizeBrandApprovalDecision ONLY after the workflow action
 * (content-brief send / halt to manual review) succeeds; a failure reverts the
 * claim via revertBrandApprovalToAwaiting so the brand can retry the same link
 * (PLU-118, Calvin review §2).
 *
 * We stamp the decider audit fields (ip/ua) here so they are captured even if the
 * finalize step later fails and the row reverts — the attempt is on the record.
 */
export async function claimBrandApprovalForProcessing(
  id: string,
  meta: { decidedIp?: string | null; decidedUserAgent?: string | null } = {},
  client: Db | DbTx = db,
): Promise<BrandApproval | null> {
  const rows = await client
    .update(brandApprovals)
    .set({
      status: "PROCESSING",
      decidedIp: meta.decidedIp ?? null,
      decidedUserAgent: meta.decidedUserAgent ?? null,
    })
    .where(
      and(
        eq(brandApprovals.id, id),
        eq(brandApprovals.status, "AWAITING_APPROVAL"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * FINALIZE a claimed approval: PROCESSING → APPROVED | REJECTED, stamping
 * decidedAt. Predicate-guarded on PROCESSING so it can only ever close a row this
 * process (or a retry of it) legitimately claimed. Returns null when nothing
 * matched (e.g. an operator manually reverted it, or it was already finalized).
 */
export async function finalizeBrandApprovalDecision(
  id: string,
  decision: { status: "APPROVED" | "REJECTED"; decidedAt?: Date },
  client: Db | DbTx = db,
): Promise<BrandApproval | null> {
  const rows = await client
    .update(brandApprovals)
    .set({
      status: decision.status,
      decidedAt: decision.decidedAt ?? new Date(),
    })
    .where(
      and(
        eq(brandApprovals.id, id),
        eq(brandApprovals.status, "PROCESSING"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * REVERT a claim whose workflow action failed: PROCESSING → AWAITING_APPROVAL,
 * clearing the decider audit fields so the row looks exactly as it did before the
 * failed attempt. Predicate-guarded on PROCESSING. Returns null when nothing
 * matched (already finalized by a racing retry, or already reverted). This is what
 * lets the brand click the same link again after a transient failure instead of
 * being permanently stranded on "already actioned".
 */
export async function revertBrandApprovalToAwaiting(
  id: string,
  client: Db | DbTx = db,
): Promise<BrandApproval | null> {
  const rows = await client
    .update(brandApprovals)
    .set({
      status: "AWAITING_APPROVAL",
      decidedIp: null,
      decidedUserAgent: null,
    })
    .where(
      and(
        eq(brandApprovals.id, id),
        eq(brandApprovals.status, "PROCESSING"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
