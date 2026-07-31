/**
 * State-machine transition tests. Focused on the CRITICAL-6 accepting edges: a
 * creator reply can arrive in OUTREACH_SENT (before the scheduler moved the
 * instance to AWAITING_REPLY) or mid-NEGOTIATING. Without a REPLY_RECEIVED edge
 * from those states, injectReply persisted the Message row and then threw on
 * assertTransition — losing the reply on retry. These assert the edges exist so a
 * reply is buffered, not dropped. Pure — no DB. Run:
 *   npx tsx src/engine/stateMachine.test.ts
 */

import assert from "node:assert/strict";
import { assertTransition, isTerminal, InvalidTransitionError } from "./stateMachine.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nstate machine — CRITICAL-6 accepting edges\n");

test("initial outreach parks queued and advances only after delivery", () => {
  assert.doesNotThrow(() => assertTransition("ENROLLED", "OUTREACH_QUEUED"));
  assert.doesNotThrow(() => assertTransition("OUTREACH_QUEUED", "OUTREACH_SENT"));
  assert.throws(
    () => assertTransition("OUTREACH_QUEUED", "AWAITING_REPLY"),
    InvalidTransitionError,
  );
  assert.equal(isTerminal("OUTREACH_QUEUED"), false);
});

test("OUTREACH_SENT accepts a reply (→ REPLY_RECEIVED)", () => {
  // Must not throw — a reply that beats the scheduler's AWAITING_REPLY transition
  // is buffered, not dropped.
  assert.doesNotThrow(() => assertTransition("OUTREACH_SENT", "REPLY_RECEIVED"));
});

test("NEGOTIATING accepts a mid-negotiation reply (→ REPLY_RECEIVED)", () => {
  assert.doesNotThrow(() => assertTransition("NEGOTIATING", "REPLY_RECEIVED"));
});

test("AWAITING_REPLY / FOLLOWED_UP still accept a reply (unchanged)", () => {
  assert.doesNotThrow(() => assertTransition("AWAITING_REPLY", "REPLY_RECEIVED"));
  assert.doesNotThrow(() => assertTransition("FOLLOWED_UP", "REPLY_RECEIVED"));
});

test("REPLY_RECEIVED still routes onward (NEGOTIATING / REJECTED / …)", () => {
  assert.doesNotThrow(() => assertTransition("REPLY_RECEIVED", "NEGOTIATING"));
  assert.doesNotThrow(() => assertTransition("REPLY_RECEIVED", "REJECTED"));
});

test("an illegal transition still throws (guard intact)", () => {
  // A random illegal edge must still be rejected — the accepting edges are
  // additive, they don't open the machine up.
  assert.throws(() => assertTransition("CONTENT_BRIEF_SENT", "NEGOTIATING"), InvalidTransitionError);
});

test("terminal states have no outgoing edges", () => {
  for (const term of [
    "CONTENT_BRIEF_SENT",
    "HANDOFF_COMPLETE",
    "REJECTED",
    "OPTED_OUT",
    "NO_RESPONSE",
    "MANUAL_REVIEW",
  ] as const) {
    assert.equal(isTerminal(term), true);
    // Same-state no-op is allowed; any real move out of a terminal must throw.
    assert.throws(() => assertTransition(term, "NEGOTIATING"), InvalidTransitionError);
  }
});

// ── Content-links flow (spec: State Machine Changes) ─────────────────────────
test("CONTENT_LINKS_PENDING is NON-terminal (the inbound worker must accept its replies)", () => {
  assert.equal(isTerminal("CONTENT_LINKS_PENDING"), false);
});

test("PAYMENT_PENDING can advance to CONTENT_LINKS_PENDING (payout form → await links)", () => {
  assert.doesNotThrow(() => assertTransition("PAYMENT_PENDING", "CONTENT_LINKS_PENDING"));
  // The legacy CONTENT_BRIEF_SENT edge is preserved for backward compatibility.
  assert.doesNotThrow(() => assertTransition("PAYMENT_PENDING", "CONTENT_BRIEF_SENT"));
});

test("CONTENT_LINKS_PENDING routes: MANUAL_REVIEW (links), OPTED_OUT (unsub), self-loop (nudge)", () => {
  assert.doesNotThrow(() => assertTransition("CONTENT_LINKS_PENDING", "MANUAL_REVIEW"));
  assert.doesNotThrow(() => assertTransition("CONTENT_LINKS_PENDING", "OPTED_OUT"));
  // Self-loop (no-op) is always allowed by assertTransition (from === to).
  assert.doesNotThrow(() => assertTransition("CONTENT_LINKS_PENDING", "CONTENT_LINKS_PENDING"));
  // But it must NOT jump straight to a success terminal — a human handoff only.
  assert.throws(() => assertTransition("CONTENT_LINKS_PENDING", "CONTENT_BRIEF_SENT"), InvalidTransitionError);
});

// ---------------------------------------------------------------------------
// PLU-70 — the operator-handoff branch
// ---------------------------------------------------------------------------

console.log("\nstate machine — PLU-70 operator handoff\n");

test("ACCEPTED branches to NEEDS_DEAL_FINALIZATION", () => {
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "NEEDS_DEAL_FINALIZATION"));
});

test("ACCEPTED keeps BOTH existing post-acceptance edges (local flow untouched)", () => {
  // The handoff edge is additive. If either of these regressed, every
  // local_payment execution would break at the moment a creator accepts.
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "PAYMENT_PENDING"));
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "REWARD_PENDING"));
});

test("NEEDS_DEAL_FINALIZATION is a WAITING state, not terminal", () => {
  // This is load-bearing: if it were terminal, the inbound worker's isTerminal
  // guard would DROP a creator reply instead of routing it to the handoff branch
  // that records and forwards it.
  assert.equal(isTerminal("NEEDS_DEAL_FINALIZATION"), false);
});

test("NEEDS_DEAL_FINALIZATION → HANDOFF_COMPLETE is the operator's exit", () => {
  assert.doesNotThrow(() => assertTransition("NEEDS_DEAL_FINALIZATION", "HANDOFF_COMPLETE"));
});

test("NEEDS_DEAL_FINALIZATION accepts an opt-out (CAN-SPAM parity)", () => {
  // An "unsubscribe" arriving while a deal is being finalized must opt the
  // creator out, exactly as it does from the other waiting states.
  assert.doesNotThrow(() => assertTransition("NEEDS_DEAL_FINALIZATION", "OPTED_OUT"));
});

test("NEEDS_DEAL_FINALIZATION cannot rejoin the local payout flow", () => {
  // The two post-acceptance paths must not cross: a handoff execution has no
  // payout token and no form, so PAYMENT_PENDING here would strand it forever.
  assert.throws(
    () => assertTransition("NEEDS_DEAL_FINALIZATION", "PAYMENT_PENDING"),
    InvalidTransitionError,
  );
  assert.throws(
    () => assertTransition("NEEDS_DEAL_FINALIZATION", "CONTENT_BRIEF_SENT"),
    InvalidTransitionError,
  );
});

test("HANDOFF_COMPLETE is terminal and cannot be reopened", () => {
  assert.equal(isTerminal("HANDOFF_COMPLETE"), true);
  assert.throws(
    () => assertTransition("HANDOFF_COMPLETE", "NEEDS_DEAL_FINALIZATION"),
    InvalidTransitionError,
  );
});

// ---------------------------------------------------------------------------
// Brand-approval gate — the ACCEPTED → AWAITING_BRAND_APPROVAL branch
// ---------------------------------------------------------------------------

console.log("\nstate machine — brand-approval gate\n");

test("ACCEPTED branches to AWAITING_BRAND_APPROVAL", () => {
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "AWAITING_BRAND_APPROVAL"));
});

test("ACCEPTED still keeps every existing post-acceptance edge (all gates additive)", () => {
  // The gate edge must not have displaced the local / reward / handoff edges.
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "PAYMENT_PENDING"));
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "REWARD_PENDING"));
  assert.doesNotThrow(() => assertTransition("ACCEPTED", "NEEDS_DEAL_FINALIZATION"));
});

test("AWAITING_BRAND_APPROVAL is a WAITING state, not terminal", () => {
  // Load-bearing: a terminal gate state would make the inbound worker DROP a
  // creator reply (e.g. an opt-out) that arrives while waiting on the brand.
  assert.equal(isTerminal("AWAITING_BRAND_APPROVAL"), false);
});

test("AWAITING_BRAND_APPROVAL → PAYMENT_PENDING is the Approve exit (brief released)", () => {
  assert.doesNotThrow(() => assertTransition("AWAITING_BRAND_APPROVAL", "PAYMENT_PENDING"));
});

test("AWAITING_BRAND_APPROVAL → MANUAL_REVIEW is the Reject exit", () => {
  assert.doesNotThrow(() => assertTransition("AWAITING_BRAND_APPROVAL", "MANUAL_REVIEW"));
});

test("AWAITING_BRAND_APPROVAL accepts an opt-out (CAN-SPAM parity)", () => {
  assert.doesNotThrow(() => assertTransition("AWAITING_BRAND_APPROVAL", "OPTED_OUT"));
});

test("AWAITING_BRAND_APPROVAL cannot jump straight to a success terminal", () => {
  // Approve must go THROUGH the content-brief send (→ PAYMENT_PENDING); it must
  // never shortcut to CONTENT_BRIEF_SENT without collecting payout.
  assert.throws(
    () => assertTransition("AWAITING_BRAND_APPROVAL", "CONTENT_BRIEF_SENT"),
    InvalidTransitionError,
  );
  assert.throws(
    () => assertTransition("AWAITING_BRAND_APPROVAL", "HANDOFF_COMPLETE"),
    InvalidTransitionError,
  );
});

console.log(`\n${n} passed\n`);
