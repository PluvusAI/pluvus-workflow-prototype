import type { InstanceState } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<InstanceState, InstanceState[]> = {
  // MANUAL_REVIEW is reachable from the outreach/follow-up states too (H4): if the
  // output guard catches a floor/ceiling leak in an AI-generated outreach or
  // follow-up email, the funnel halts for human review instead of sending it.
  ENROLLED: ["OUTREACH_QUEUED", "OUTREACH_SENT", "OPTED_OUT", "MANUAL_REVIEW"],
  // PLU-122: the initial email has a committed outbox reservation but has not
  // necessarily reached the provider. Only the delayed-send worker may advance
  // this state, after Message.sentAt is durable.
  OUTREACH_QUEUED: ["OUTREACH_SENT", "REPLY_RECEIVED", "OPTED_OUT", "MANUAL_REVIEW"],
  // CRITICAL-6: a creator reply can arrive while the instance is still
  // OUTREACH_SENT (before the scheduler has transitioned it to AWAITING_REPLY).
  // Without a REPLY_RECEIVED edge here, injectReply persisted the Message row and
  // THEN assertTransition threw — leaving the reply persisted-but-unprocessed and
  // permanently lost on retry (the idempotency check no-ops once the row exists).
  // Accepting the edge lets the reply be buffered and processed instead of dropped.
  OUTREACH_SENT: ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  AWAITING_REPLY: ["FOLLOWED_UP", "REPLY_RECEIVED", "NO_RESPONSE", "OPTED_OUT", "MANUAL_REVIEW"],
  FOLLOWED_UP: ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  // Phase D (#3): a DEFERRED reply ("I'll think about it") loops back to
  // AWAITING_REPLY with a dueAt so the soft follow-up fires a few days out — the
  // pending-reply STATE is reused, distinct from the DEFERRED intent.
  REPLY_RECEIVED: ["NEGOTIATING", "REJECTED", "OPTED_OUT", "AWAITING_REPLY", "MANUAL_REVIEW"],
  // Negotiation escalations (#14) route to MANUAL_REVIEW (over-ceiling / draft
  // guard) or REJECTED (max-rounds no agreement, #15) — a clean one-way handoff,
  // no brand-decision loop. CRITICAL-6: a creator can reply again mid-negotiation
  // (a second reply arrives before we've sent our turn). Without a REPLY_RECEIVED
  // edge, injectReply persisted the row then threw on assertTransition, losing the
  // reply on retry. The edge buffers such a reply into the reply-detection/
  // negotiation path instead of dropping it.
  NEGOTIATING: ["NEGOTIATING", "AWAITING_REPLY", "REPLY_RECEIVED", "ACCEPTED", "REJECTED", "OPTED_OUT", "MANUAL_REVIEW"],
  // ACCEPTED is no longer terminal: a successful negotiation auto-advances into
  // the Content Brief node, which sends the merged offer + payout link + brief
  // email and parks in PAYMENT_PENDING. (Legacy graphs advance into Reward Setup
  // → REWARD_PENDING instead.) MANUAL_REVIEW is reachable (L4) if the email has no
  // resolvable brand name. PLU-70: an execution enrolled with
  // postAcceptanceMode=operator_handoff branches to NEEDS_DEAL_FINALIZATION
  // instead — no payout form, no brief, a human finishes the deal.
  ACCEPTED: [
    "PAYMENT_PENDING",
    "REWARD_PENDING",
    "NEEDS_DEAL_FINALIZATION",
    // Brand-approval gate (BRAND_APPROVAL_GATE_ENABLED): a local_payment deal is
    // held for the brand's Approve/Reject before the content brief goes out.
    "AWAITING_BRAND_APPROVAL",
    "MANUAL_REVIEW",
  ],
  // Brand-approval gate waiting state. Waits on the brand the way PAYMENT_PENDING
  // waits on the payout form. On Approve it advances to PAYMENT_PENDING (the merged
  // Content Brief SEND phase runs and sends the brief + payout link); on Reject it
  // halts to MANUAL_REVIEW for a human. OPTED_OUT is reachable for parity with every
  // other waiting state — an "unsubscribe" while awaiting brand sign-off must opt the
  // creator out (CAN-SPAM). NOT terminal: the inbound worker still routes a creator
  // reply that lands here.
  AWAITING_BRAND_APPROVAL: ["PAYMENT_PENDING", "MANUAL_REVIEW", "OPTED_OUT"],
  // PLU-70 operator handoff. A WAITING state, not a terminal one: it waits on a
  // human the way PAYMENT_PENDING waits on the payout form. The only forward
  // edge is the operator marking the handoff done. OPTED_OUT is reachable for
  // parity with every other waiting state — an "unsubscribe" while the deal is
  // being finalized must opt the creator out (CAN-SPAM). MANUAL_REVIEW is the
  // escape hatch if the operator decides it needs the escalation path instead.
  NEEDS_DEAL_FINALIZATION: ["HANDOFF_COMPLETE", "OPTED_OUT", "MANUAL_REVIEW"],
  // PLU-70: the operator finalized and onboarded the creator in main Pluvus.
  // Terminal — the end of the handoff branch.
  HANDOFF_COMPLETE: [],
  // Reward Setup waiting state. Stays here on a non-confirming reply
  // (REWARD_PENDING → REWARD_PENDING), advances on an agreement reply, and can
  // still be escalated to a human. MED-W1: OPTED_OUT is reachable — an
  // "unsubscribe" reply while awaiting agreement must opt the creator out, not
  // get a "rate is fixed" auto-reply (CAN-SPAM).
  REWARD_PENDING: ["REWARD_PENDING", "REWARD_CONFIRMED", "OPTED_OUT", "MANUAL_REVIEW"],
  // Reward Setup success. No longer terminal: a confirmed agreement auto-advances
  // into the Payment Info node, which collects the creator's payout details.
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the payment email.
  REWARD_CONFIRMED: ["PAYMENT_PENDING", "MANUAL_REVIEW"],
  // Payout-collection waiting state. Stays here until the creator submits the
  // payout form. In the merged flow the Content Brief node owns this state and the
  // submission lands directly on the CONTENT_BRIEF_SENT terminal; in legacy graphs
  // the Payment Info node owns it and the submission lands on PAYMENT_RECEIVED
  // (which then chains into Content Brief). Both edges are kept. Can be escalated.
  // MED-W1: OPTED_OUT is reachable — an "unsubscribe" email while awaiting the
  // payout form must opt the creator out, not get the marketing auto-reply.
  // Content-links flow: in the merged graph the payout-form submission now parks
  // on CONTENT_LINKS_PENDING (ask the creator for their content links) instead of
  // landing directly on the CONTENT_BRIEF_SENT terminal. The CONTENT_BRIEF_SENT
  // edge is kept for the legacy PAYMENT_RECEIVED chain and backward compatibility.
  PAYMENT_PENDING: ["PAYMENT_PENDING", "PAYMENT_RECEIVED", "CONTENT_LINKS_PENDING", "CONTENT_BRIEF_SENT", "OPTED_OUT", "MANUAL_REVIEW"],
  // Post-payout content-links waiting state. The creator was asked to reply with
  // the link(s) to their published content. A reply that contains URLs appends a
  // CONTENT_LINKS_SUBMITTED event and escalates to MANUAL_REVIEW (one-way human
  // handoff); a reply with no URLs stays here (self-loop) after a gentle nudge; an
  // "unsubscribe" reply routes to OPTED_OUT (CAN-SPAM parity with the other
  // waiting states). Intentionally NON-terminal so the inbound worker accepts and
  // routes the creator's reply instead of dropping it.
  CONTENT_LINKS_PENDING: ["CONTENT_LINKS_PENDING", "MANUAL_REVIEW", "OPTED_OUT"],
  // Payment Info success. No longer terminal: the payout submission auto-advances
  // into the Content Brief node. Content Brief has NO waiting state — it sends the
  // brief email and completes in a single step — so PAYMENT_RECEIVED transitions
  // straight to the CONTENT_BRIEF_SENT terminal.
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the content-brief email.
  PAYMENT_RECEIVED: ["CONTENT_BRIEF_SENT", "MANUAL_REVIEW"],
  // Content Brief success. Terminal — the end of the linear graph.
  CONTENT_BRIEF_SENT: [],
  REJECTED: [],
  OPTED_OUT: [],
  NO_RESPONSE: [],
  // Human review queue — terminal until a human re-routes the instance.
  MANUAL_REVIEW: [],
};

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATES: InstanceState[] = [
  // ACCEPTED, REWARD_CONFIRMED and PAYMENT_RECEIVED are intentionally NOT terminal
  // anymore — they auto-advance into Reward Setup, Payment Info and Content Brief
  // respectively. CONTENT_LINKS_PENDING is also intentionally NON-terminal (it
  // holds the conversation open for the creator's content-links reply — a terminal
  // parking state would make the inbound worker drop that reply). CONTENT_BRIEF_SENT
  // remains a success terminal (legacy chain); MANUAL_REVIEW is the terminal endpoint
  // of the content-links automated path.
  "CONTENT_BRIEF_SENT",
  // PLU-70: the success terminal of the operator-handoff branch.
  // NEEDS_DEAL_FINALIZATION is deliberately absent — it is a waiting state, so
  // the inbound worker still routes a creator reply to it (and the handoff
  // branch there records + forwards it) rather than dropping it as terminal.
  "HANDOFF_COMPLETE",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

export function isTerminal(state: InstanceState): boolean {
  return TERMINAL_STATES.includes(state);
}

export class InvalidTransitionError extends Error {
  constructor(from: InstanceState, to: InstanceState) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: InstanceState, to: InstanceState): void {
  // Allow same-state for no-op transitions (e.g. import node staying ENROLLED)
  if (from === to) return;
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
