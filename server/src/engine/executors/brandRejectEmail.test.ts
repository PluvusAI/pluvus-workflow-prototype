import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderBrandRejectCloseTemplate,
  brandRejectCloseKey,
} from "./brandRejectEmail.js";

// The creator close email sent when the brand rejects. Copy contract only — the
// reserve/flush wiring is exercised end-to-end in brandApproval.harness.ts.

test("close template greets the creator by the {{creatorName}} token", () => {
  const body = renderBrandRejectCloseTemplate({ senderName: "Pluvus", brandName: "Acme" });
  assert.ok(body.includes("Hi {{creatorName}},"), "must use the shared creatorName token");
});

test("close template names the brand and signs off with the sender", () => {
  const body = renderBrandRejectCloseTemplate({ senderName: "Acme Partnerships", brandName: "Acme" });
  assert.ok(body.includes("with Acme"), "body should name the brand warmly");
  assert.ok(body.trimEnd().endsWith("Acme Partnerships"), "should sign off with the sender name");
});

test("close template leaks no rate / terms / decision tokens", () => {
  const body = renderBrandRejectCloseTemplate({ senderName: "Pluvus", brandName: "Acme" });
  // No money figures, band tokens, or approve/reject-link vocabulary — nothing for
  // the output guard to leak and nothing that reads as "the brand rejected you".
  assert.ok(!/\$\d/.test(body), "no dollar figure");
  assert.ok(!/\{\{(?!creatorName)/.test(body), "only the creatorName token is present");
  assert.ok(!/\bfloor\b|\bceiling\b|\bcommission\b/i.test(body), "no internal band terms");
  assert.ok(!/\brejected?\b/i.test(body), "must not tell the creator they were rejected");
});

test("close template reads as a warm, non-committal close", () => {
  const body = renderBrandRejectCloseTemplate({ senderName: "Pluvus", brandName: "Acme" });
  assert.ok(/not to move forward/i.test(body), "states the outcome gently");
  assert.ok(/stay in touch|down the line/i.test(body), "leaves the door open");
});

test("idempotency key is one-per-instance", () => {
  assert.equal(brandRejectCloseKey("inst_abc"), "brand-reject-close:inst_abc");
  assert.notEqual(brandRejectCloseKey("inst_abc"), brandRejectCloseKey("inst_xyz"));
});
