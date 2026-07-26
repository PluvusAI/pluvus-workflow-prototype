import { and, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
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
// is the whole idempotency story: the brand-approval executor runs inside a BullMQ
// job that may be retried, so `createBrandApprovalOnce` swallows the unique
// violation and returns the row that already exists — crucially reusing the SAME
// approveTokenHash, so the magic links in the already-sent email stay valid across
// retries. The decision is written exactly once no matter how many retries occur.

/**
 * Insert the approval snapshot, or return the existing row if one is already
 * there. Never throws on a duplicate — a retried send step is a no-op and the
 * original token is preserved.
 */
export async function createBrandApprovalOnce(
  data: BrandApprovalInsert,
): Promise<BrandApproval> {
  try {
    const rows = await db.insert(brandApprovals).values(data).returning();
    return rows[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findBrandApprovalByInstance(data.instanceId);
      if (existing) return existing;
    }
    throw err;
  }
}

export async function findBrandApprovalById(
  id: string,
): Promise<BrandApproval | null> {
  const rows = await db
    .select()
    .from(brandApprovals)
    .where(eq(brandApprovals.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBrandApprovalByInstance(
  instanceId: string,
): Promise<BrandApproval | null> {
  const rows = await db
    .select()
    .from(brandApprovals)
    .where(eq(brandApprovals.instanceId, instanceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record the brand's decision (APPROVED or REJECTED).
 *
 * Idempotent by predicate: the update only matches a row still in
 * AWAITING_APPROVAL, so a double-click, a mail-scanner prefetch double-POST, or a
 * retried request cannot overwrite the first decision with a later one. When
 * nothing matched (already decided) we return null so the caller renders the
 * "already actioned" notice rather than re-firing the state transition.
 */
export async function markBrandApprovalDecided(
  id: string,
  decision: {
    status: "APPROVED" | "REJECTED";
    decidedIp?: string | null;
    decidedUserAgent?: string | null;
    decidedAt?: Date;
  },
): Promise<BrandApproval | null> {
  const rows = await db
    .update(brandApprovals)
    .set({
      status: decision.status,
      decidedAt: decision.decidedAt ?? new Date(),
      decidedIp: decision.decidedIp ?? null,
      decidedUserAgent: decision.decidedUserAgent ?? null,
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
