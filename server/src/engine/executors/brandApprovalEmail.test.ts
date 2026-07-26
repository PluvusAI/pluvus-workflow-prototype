/**
 * Unit tests for the brand-approval request email renderer. Pure string builder —
 * no DB, no network. Asserts the brand-facing copy carries the creator profile,
 * the agreed terms (fee + range, commission, deliverables/timeline/perk), and BOTH
 * magic links, and that absent fields are omitted (not printed as "null").
 *
 * Run: cd server && npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBrandApprovalEmail } from "./brandApprovalEmail.js";

const BASE = {
  brandName: "AeroSoft",
  creatorName: "Maya Chen",
  approveLink: "https://x.test/brand-approval/approve/abc?token=t",
  rejectLink: "https://x.test/brand-approval/reject/abc?token=t",
};

describe("renderBrandApprovalEmail", () => {
  it("subject asks to approve the creator (+ campaign when present)", () => {
    const d = renderBrandApprovalEmail({ ...BASE, campaignName: "Cloudstride" });
    assert.equal(d.subject, "Approve Maya Chen for Cloudstride?");
  });

  it("subject omits the campaign clause when absent", () => {
    const d = renderBrandApprovalEmail({ ...BASE });
    assert.equal(d.subject, "Approve Maya Chen?");
  });

  it("body addresses the brand and states the creator agreed", () => {
    const d = renderBrandApprovalEmail({ ...BASE, campaignName: "Cloudstride" });
    assert.match(d.body, /Hi AeroSoft,/);
    assert.match(d.body, /Maya Chen has agreed to terms for the Cloudstride campaign/);
  });

  it("includes the creator handle + platform when present", () => {
    const d = renderBrandApprovalEmail({
      ...BASE,
      creatorHandle: "mayamakes",
      creatorPlatform: "Instagram",
    });
    assert.match(d.body, /Maya Chen \(@mayamakes\) on Instagram/);
  });

  it("renders the fee with the negotiation range when a band exists", () => {
    const d = renderBrandApprovalEmail({
      ...BASE,
      fixedFee: 450,
      negotiationFloor: 200,
      negotiationCeiling: 500,
    });
    assert.match(d.body, /Fee: \$450 \(your range: \$200–\$500\)/);
  });

  it("renders the fee without a range when no band", () => {
    const d = renderBrandApprovalEmail({ ...BASE, fixedFee: 450 });
    assert.match(d.body, /Fee: \$450/);
    assert.doesNotMatch(d.body, /your range/);
  });

  it("renders commission only when > 0", () => {
    const withC = renderBrandApprovalEmail({ ...BASE, fixedFee: 300, commissionRate: 10 });
    assert.match(withC.body, /Commission: 10% on sales through the referral link/);
    const zero = renderBrandApprovalEmail({ ...BASE, fixedFee: 300, commissionRate: 0 });
    assert.doesNotMatch(zero.body, /Commission:/);
  });

  it("includes deliverables / timeline / payment terms / perk when present, omits when absent", () => {
    const full = renderBrandApprovalEmail({
      ...BASE,
      fixedFee: 300,
      deliverables: "2 reels",
      timeline: "2 weeks",
      paymentTerms: "Net 30",
      rewardDescription: "one pair of Tempo trainers",
    });
    assert.match(full.body, /Deliverables: 2 reels/);
    assert.match(full.body, /Timeline: 2 weeks/);
    assert.match(full.body, /Payment terms: Net 30/);
    assert.match(full.body, /Perk: one pair of Tempo trainers/);

    const bare = renderBrandApprovalEmail({ ...BASE, fixedFee: 300 });
    assert.doesNotMatch(bare.body, /Deliverables:/);
    assert.doesNotMatch(bare.body, /Timeline:/);
    assert.doesNotMatch(bare.body, /null/);
  });

  it("carries BOTH the approve and reject links", () => {
    const d = renderBrandApprovalEmail({ ...BASE, fixedFee: 300 });
    assert.ok(d.body.includes(BASE.approveLink), "approve link present");
    assert.ok(d.body.includes(BASE.rejectLink), "reject link present");
  });

  it("explains that Approve releases the brief and Reject holds the deal", () => {
    const d = renderBrandApprovalEmail({ ...BASE, fixedFee: 300 });
    assert.match(d.body, /Approve — send Maya Chen the content brief \+ payout link/);
    assert.match(d.body, /Reject — hold this deal/);
    assert.match(d.body, /Clicking Approve releases the content brief/);
  });
});
