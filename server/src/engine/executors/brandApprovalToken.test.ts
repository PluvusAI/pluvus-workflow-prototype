/**
 * Unit tests for the brand-approval magic-link token — hash round-trip,
 * timing-safe compare (match / tamper / absent / length-mismatch), TTL, expiry,
 * and the link builders. Pure: no DB, no Express, no network. Mirrors
 * payoutToken.test.ts / paymentToken.test.ts.
 *
 * Run: cd server && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashBrandApprovalToken,
  mintBrandApprovalToken,
  brandApprovalExpiry,
  brandApprovalTokenMatches,
  brandApprovalTtlDays,
  isBrandApprovalTokenExpired,
  brandApproveLink,
  brandRejectLink,
} from "./brandApprovalToken.js";

describe("brandApprovalToken", () => {
  it("mint produces a raw token and its sha256 hash (not equal)", () => {
    const t = mintBrandApprovalToken();
    assert.ok(t.rawToken.length > 0);
    assert.notEqual(t.tokenHash, t.rawToken, "the stored hash must not equal the raw token");
    assert.equal(t.tokenHash, hashBrandApprovalToken(t.rawToken));
  });

  it("hashBrandApprovalToken is sha256 hex (64 lowercase hex chars)", () => {
    assert.match(hashBrandApprovalToken("some-token"), /^[0-9a-f]{64}$/);
  });

  it("matches the correct raw token against its stored hash", () => {
    const t = mintBrandApprovalToken();
    assert.ok(brandApprovalTokenMatches(t.rawToken, t.tokenHash));
  });

  it("rejects a tampered token", () => {
    const t = mintBrandApprovalToken();
    assert.ok(!brandApprovalTokenMatches(t.rawToken + "x", t.tokenHash));
  });

  it("rejects absent / non-string inputs without throwing", () => {
    const t = mintBrandApprovalToken();
    assert.ok(!brandApprovalTokenMatches(undefined, t.tokenHash));
    assert.ok(!brandApprovalTokenMatches(null, t.tokenHash));
    assert.ok(!brandApprovalTokenMatches("", t.tokenHash));
    assert.ok(!brandApprovalTokenMatches(t.rawToken, null));
    assert.ok(!brandApprovalTokenMatches(t.rawToken, undefined));
    assert.ok(!brandApprovalTokenMatches(t.rawToken, ""));
  });

  it("TTL defaults to 14 days", () => {
    const prev = process.env["BRAND_APPROVAL_TTL_DAYS"];
    delete process.env["BRAND_APPROVAL_TTL_DAYS"];
    try {
      assert.equal(brandApprovalTtlDays(), 14);
      const now = new Date("2026-01-01T00:00:00.000Z");
      const exp = brandApprovalExpiry(now);
      assert.equal(exp.getTime() - now.getTime(), 14 * 24 * 60 * 60 * 1000);
    } finally {
      if (prev === undefined) delete process.env["BRAND_APPROVAL_TTL_DAYS"];
      else process.env["BRAND_APPROVAL_TTL_DAYS"] = prev;
    }
  });

  it("TTL honours a positive BRAND_APPROVAL_TTL_DAYS override", () => {
    const prev = process.env["BRAND_APPROVAL_TTL_DAYS"];
    process.env["BRAND_APPROVAL_TTL_DAYS"] = "30";
    try {
      assert.equal(brandApprovalTtlDays(), 30);
    } finally {
      if (prev === undefined) delete process.env["BRAND_APPROVAL_TTL_DAYS"];
      else process.env["BRAND_APPROVAL_TTL_DAYS"] = prev;
    }
  });

  it("isBrandApprovalTokenExpired: null never expires; past expires; future does not", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    assert.ok(!isBrandApprovalTokenExpired(null, now));
    assert.ok(!isBrandApprovalTokenExpired(undefined, now));
    assert.ok(isBrandApprovalTokenExpired(new Date("2026-01-09T00:00:00.000Z"), now));
    assert.ok(!isBrandApprovalTokenExpired(new Date("2026-01-11T00:00:00.000Z"), now));
  });

  it("link builders embed the id + raw token on the correct paths", () => {
    const prev = process.env["PAYMENT_BASE_URL"];
    process.env["PAYMENT_BASE_URL"] = "https://example.test";
    try {
      assert.equal(
        brandApproveLink("abc123", "raw-tok"),
        "https://example.test/brand-approval/approve/abc123?token=raw-tok",
      );
      assert.equal(
        brandRejectLink("abc123", "raw-tok"),
        "https://example.test/brand-approval/reject/abc123?token=raw-tok",
      );
    } finally {
      if (prev === undefined) delete process.env["PAYMENT_BASE_URL"];
      else process.env["PAYMENT_BASE_URL"] = prev;
    }
  });
});
