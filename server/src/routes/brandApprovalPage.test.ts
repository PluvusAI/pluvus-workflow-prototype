/**
 * PLU-118 (Calvin review follow-up) — unit tests for the brand-approval hosted
 * pages. Pure string builders, no Express/DB. Covers the changes from the review:
 *   - the interstitial heads with the real BRAND name, and still shows the campaign
 *     in the "…for {campaign}" phrase (the page previously used campaignName as the
 *     heading brand),
 *   - the meta referrer/no-referrer tag is present on every page (token is in the
 *     URL query string),
 *   - the new retry page after a transient action failure, and
 *   - the "working on it" PROCESSING notice.
 *
 * Run: npx tsx src/routes/brandApprovalPage.test.ts   (or via npm test)
 */

import assert from "node:assert/strict";
import {
  renderBrandApprovalInterstitialPage,
  renderBrandApprovalAlreadyActionedPage,
  renderBrandApprovalHandledElsewherePage,
  renderBrandApprovalRetryPage,
  renderBrandApprovedPage,
} from "./brandApprovalPage.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nbrandApprovalPage\n");

test("interstitial heads with the BRAND name, not the campaign name", () => {
  const html = renderBrandApprovalInterstitialPage({
    approvalId: "ap1",
    token: "tok-abc",
    brandName: "Stridr",
    creatorName: "Maya",
    campaignName: "Spring Launch",
    terms: { fixedFee: 450 },
    action: "approve",
  });
  // The brand chip (heading) is the brand, the campaign appears in the lead phrase.
  assert.match(html, /class="brand">Stridr</, "heading chip is the brand name");
  assert.match(html, /for Spring Launch/, "campaign appears in the '…for {campaign}' phrase");
});

test("every page carries a no-referrer meta tag (token is in the URL)", () => {
  const pages = [
    renderBrandApprovalInterstitialPage({
      approvalId: "ap1",
      token: "tok-abc",
      brandName: "Stridr",
      creatorName: "Maya",
      campaignName: "Spring Launch",
      terms: {},
      action: "approve",
    }),
    renderBrandApprovedPage({ brandName: "Stridr", creatorName: "Maya" }),
    renderBrandApprovalRetryPage({ brandName: "Stridr" }),
  ];
  for (const html of pages) {
    assert.match(
      html,
      /<meta name="referrer" content="no-referrer"/,
      "page must set a strict referrer policy meta tag",
    );
  }
});

test("interstitial posts the token in a hidden field to the correct action path", () => {
  const html = renderBrandApprovalInterstitialPage({
    approvalId: "ap-xyz",
    token: "tok-secret",
    brandName: "Stridr",
    creatorName: "Maya",
    campaignName: null,
    terms: {},
    action: "reject",
  });
  assert.match(html, /<form method="POST" action="\/brand-approval\/reject\/ap-xyz">/);
  assert.match(html, /<input type="hidden" name="token" value="tok-secret"/);
});

test("retry page invites the brand to click again and does not claim a decision", () => {
  const html = renderBrandApprovalRetryPage({ brandName: "Stridr" });
  assert.match(html, /again/i, "asks the brand to retry");
  assert.doesNotMatch(html, /approved|rejected/i, "does NOT claim the deal was decided");
  assert.match(html, /class="brand">Stridr</, "shows the brand name");
});

test("already-actioned page shows an in-progress notice for a PROCESSING row", () => {
  const html = renderBrandApprovalAlreadyActionedPage({
    brandName: "Stridr",
    status: "PROCESSING",
  });
  assert.match(html, /processed|working/i, "PROCESSING reads as in-progress");
  assert.doesNotMatch(html, /already approved|already rejected/i, "not a definitive decision");
});

test("already-actioned page shows the decision for a finalized row", () => {
  const approved = renderBrandApprovalAlreadyActionedPage({ brandName: "Stridr", status: "APPROVED" });
  assert.match(approved, /already approved/i);
  const rejected = renderBrandApprovalAlreadyActionedPage({ brandName: "Stridr", status: "REJECTED" });
  assert.match(rejected, /already rejected/i);
});

test("handled-elsewhere page is neutral — never claims approved OR rejected (§3)", () => {
  const html = renderBrandApprovalHandledElsewherePage({ brandName: "Stridr" });
  assert.match(html, /class="brand">Stridr</, "shows the brand name");
  assert.match(html, /moved forward|no action|nothing to do/i, "neutral 'handled' notice");
  assert.doesNotMatch(
    html,
    /approved|rejected|awaiting/i,
    "must NOT fabricate a decision or leak the reverted AWAITING status",
  );
});

console.log(`\n${n} passed\n`);
