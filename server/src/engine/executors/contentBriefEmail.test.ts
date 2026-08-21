/**
 * Unit tests for the Content Brief "Your Campaign Brief" email renderer (the
 * merged post-negotiation email: finalized offer + payout link + brief). Pure —
 * no DB, no network, no file system. Run:
 *   npx tsx src/engine/executors/contentBriefEmail.test.ts
 */

import assert from "node:assert/strict";
import { renderContentBriefEmail } from "./contentBriefEmail.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\ncontentBriefEmail\n");

const FORM_LINK = "http://localhost:3001/payment/tok-abc-123";

const full = () =>
  renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    formLink: FORM_LINK,
    fixedFee: 750,
    commissionRate: 15,
    deliverableLines: ["2 Reels", "1 Story"],
    timeline: "Content live by July 20, 2026",
    creatorNotes: "Please tag @pluvus in your first story.",
  });

// ── Subject ──────────────────────────────────────────────────────────────────
test("subject is exactly 'Your Campaign Brief'", () => {
  assert.equal(full().subject, "Your Campaign Brief");
});

// ── Body — required copy ─────────────────────────────────────────────────────
test("body greets the creator and welcomes them aboard", () => {
  const { body } = full();
  assert.match(body, /^Hi Ada,/);
  assert.match(body, /welcome aboard!/i);
});

test("body references the attached brief and asks the creator to review it", () => {
  const { body } = full();
  assert.match(body, /Attached is your campaign brief/);
  assert.match(body, /Please review the attached document carefully/);
});

test("body signs off as the brand", () => {
  const { body } = full();
  assert.match(body, /Best,\nPluvus$/);
});

// ── Content-links request (the close of the funnel) ──────────────────────────
// The merged brief email now asks the creator to reply IN THIS THREAD with the
// link(s) to their content once it is live — the entry point for the content-
// submission flow. It must be present and clearly ask for a reply with the links.
test("body asks the creator to reply with their content link(s) once content is live", () => {
  const { body } = full();
  assert.match(body, /Once your content is live/i);
  assert.match(body, /reply to this email with the link\(s\)/i);
});

// ── Finalized offer block ────────────────────────────────────────────────────
test("body states the finalized terms header + fee + commission", () => {
  const { body } = full();
  assert.match(body, /here are the terms we settled on:/);
  assert.match(body, /• Fixed Fee: \$750/);
  assert.match(body, /• Commission: 15%/);
});

test("body renders each deliverable as its own bullet", () => {
  const { body } = full();
  assert.match(body, /• Deliverables:/);
  assert.match(body, /- 2 Reels/);
  assert.match(body, /- 1 Story/);
});

test("body states the timeline line when provided", () => {
  const { body } = full();
  assert.match(body, /• Timeline: Content live by July 20, 2026/);
});

test("fee falls back to 'the agreed fee' and commission to 'None' when absent", () => {
  const { body } = renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    formLink: FORM_LINK,
    creatorNotes: "",
  });
  assert.match(body, /• Fixed Fee: the agreed fee/);
  assert.match(body, /• Commission: None/);
});

// ── Payout link ──────────────────────────────────────────────────────────────
test("body includes the secure payout form link verbatim", () => {
  const { body } = full();
  assert.match(body, /complete your secure payout information here:/);
  assert.ok(body.includes(FORM_LINK));
});

// ── Referral link (removed) ──────────────────────────────────────────────────
// The manual referral field was removed: attribution mints a UNIQUE per-creator
// tracking link (partnership.ts), delivered in the welcome email. This email must
// no longer render any "referral link" section.
test("body never renders a referral-link section", () => {
  assert.doesNotMatch(full().body, /referral link/i);
});

// ── Creator notes ────────────────────────────────────────────────────────────
test("body includes the creator notes verbatim when provided", () => {
  const { body } = full();
  assert.ok(body.includes("Please tag @pluvus in your first story."));
});

test("body omits notes cleanly when none are provided (no empty gap markers)", () => {
  const { body } = renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    formLink: FORM_LINK,
    creatorNotes: "   ",
  });
  // No stray blank paragraph (triple newline) where the notes would have been.
  assert.doesNotMatch(body, /\n\n\n/);
  assert.match(body, /Please review the attached document/);
});

// ── Product/sample reward ────────────────────────────────────────────────────
test("body renders the reward bullet when a rewardDescription is provided", () => {
  const { body } = renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    formLink: FORM_LINK,
    creatorNotes: "",
    rewardDescription: "a free pair of our running shoes",
  });
  assert.match(body, /• Reward: a free pair of our running shoes/);
});

test("body omits the reward bullet when no reward is configured", () => {
  // full() is built without a rewardDescription.
  assert.doesNotMatch(full().body, /• Reward:/);
});

// ── No attachment bytes here (that's the executor's job) ─────────────────────
test("renderer returns only subject + body (attachment is added by the executor)", () => {
  const draft = full();
  assert.deepEqual(Object.keys(draft).sort(), ["body", "subject"]);
});

console.log(`\n${n} passed\n`);
