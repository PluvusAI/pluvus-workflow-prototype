import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { paymentBaseUrl } from "./paymentEmail.js";

// ---------------------------------------------------------------------------
// Brand-approval magic-link token (brand-approval gate)
// ---------------------------------------------------------------------------
// After a creator ACCEPTS on a local_payment execution, the brand approves or
// rejects via two emailed magic links. The link carries a 32-byte random token;
// the DB stores ONLY its sha256 hash (BrandApproval.approveTokenHash) + an expiry
// (tokenExpiresAt). The raw token exists solely in the brand's email — a DB dump
// cannot forge an approval. Same recipe as the payout confirm/dispute token
// (payoutToken.ts): timing-safe compare + an interstitial-POST flow (GET never
// mutates, since mail-scanners prefetch GETs).

const DEFAULT_APPROVAL_TTL_DAYS = 14;

/** Lifetime of an approve/reject token — BRAND_APPROVAL_TTL_DAYS (default 14). */
export function brandApprovalTtlDays(): number {
  const raw = Number(process.env["BRAND_APPROVAL_TTL_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_TTL_DAYS;
}

export function brandApprovalExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + brandApprovalTtlDays() * 24 * 60 * 60 * 1000);
}

/** sha256 hex of a raw token — what we persist and compare against. */
export function hashBrandApprovalToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface MintedBrandApprovalToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Mint a fresh approve/reject token: 32 random bytes (hex), its hash, + expiry. */
export function mintBrandApprovalToken(now: Date = new Date()): MintedBrandApprovalToken {
  const rawToken = randomBytes(32).toString("hex");
  return {
    rawToken,
    tokenHash: hashBrandApprovalToken(rawToken),
    expiresAt: brandApprovalExpiry(now),
  };
}

/**
 * Constant-time comparison of a presented raw token against a stored hash.
 * Returns false on any length mismatch, absent hash, or non-string input — never
 * throws, so callers can treat false as "invalid link".
 */
export function brandApprovalTokenMatches(
  presentedRaw: string | undefined | null,
  storedHash: string | null | undefined,
): boolean {
  if (typeof presentedRaw !== "string" || !presentedRaw) return false;
  if (typeof storedHash !== "string" || !storedHash) return false;
  const a = Buffer.from(hashBrandApprovalToken(presentedRaw), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** True when a token expiry has passed. A null expiry never expires (grandfathered). */
export function isBrandApprovalTokenExpired(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() <= now.getTime();
}

/** The brand-facing Approve link for a BrandApproval id + raw token. */
export function brandApproveLink(approvalId: string, rawToken: string): string {
  return `${paymentBaseUrl()}/brand-approval/approve/${approvalId}?token=${rawToken}`;
}

/** The brand-facing Reject link for a BrandApproval id + raw token. */
export function brandRejectLink(approvalId: string, rawToken: string): string {
  return `${paymentBaseUrl()}/brand-approval/reject/${approvalId}?token=${rawToken}`;
}
