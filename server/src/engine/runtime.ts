import type {
  InstanceState,
  EventType,
  InputJsonValue,
  MessageInsert,
} from "../db/schema.js";
import {
  db,
  findInstanceById,
  findCreatorById,
  findVersionById,
  findWorkflowById,
  updateInstanceState,
  updateInstanceStateConditional,
  appendEvent,
  createMessage,
  findMessageByExternalId,
  upsertQuestionObligation,
  linkResolutionMessage,
  escalateObligations,
  listOpenObligationsByInstance,
  upsertMemoryFact,
} from "../db/index.js";
import type { Db, DbTx } from "../db/drizzle.js";
import { findCampaignById } from "../db/campaigns.js";
import { isTerminal, assertTransition } from "./stateMachine.js";
import type { IEmailProvider, IAgentProvider } from "./providers.js";
import type { ExecutionContext, NodeSnapshot, NodeResult } from "./types.js";
import { logTransition, type TransitionSource } from "../observability/logger.js";
import { runWithLlmAttribution } from "../observability/llmUsage.js";
import {
  notifyBrandOfEscalation,
  notifyOperatorOfDealFinalization,
  notifyOperatorOfHandoffReply,
} from "../notifications/escalation.js";
import {
  executeImportCreatorList,
  executeInitialOutreach,
  executeFollowUp,
  executeReplyDetection,
  executeNegotiation,
  executeRewardSetup,
  executeRewardReply,
  executePaymentInfo,
  executePaymentSubmission,
  executePaymentReply,
  executeContentBrief,
  executeContentBriefSubmission,
  executeContentLinksReply,
  executeOperatorHandoff,
  executeBrandApproval,
  executeEnd,
} from "./executors/index.js";
import { brandApprovalGateEnabled } from "./executors/brandApprovalConfig.js";
import { reserveBrandRejectCloseEmail } from "./executors/brandRejectEmail.js";
import { markPaymentReceived } from "../db/index.js";
import type { PayoutMethod } from "../db/schema.js";
import { enqueueDelayedSend } from "../workers/queues.js";

// ---------------------------------------------------------------------------
// StaleInstanceError — thrown when OCC detects a concurrent state change
// ---------------------------------------------------------------------------

export class StaleInstanceError extends Error {
  constructor(instanceId: string, observedState: string) {
    super(`Stale instance: ${instanceId} state changed away from ${observedState}`);
    this.name = "StaleInstanceError";
  }
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  constructor(
    private readonly email: IEmailProvider,
    private readonly agent: IAgentProvider,
    // Randomized Send Delay (§4.3a): the post-commit deferred-send enqueue.
    // Injectable so a DB-backed test can assert it fires ONLY on a committed turn
    // (not on a StaleInstanceError rollback) without a live Redis. Defaults to the
    // real BullMQ enqueue.
    private readonly enqueueDelayedSendFn: typeof enqueueDelayedSend = enqueueDelayedSend,
  ) {}

  // -------------------------------------------------------------------------
  // loadContext
  // -------------------------------------------------------------------------

  async loadContext(instanceId: string): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    const creator = await findCreatorById(instance.creatorId);
    if (!creator) {
      throw new Error(`Creator not found: ${instance.creatorId}`);
    }

    const version = await findVersionById(instance.workflowVersionId);
    if (!version) {
      throw new Error(`WorkflowVersion not found: ${instance.workflowVersionId}`);
    }

    const nodeGraph = version.nodeGraph as unknown as NodeSnapshot[];

    // Resolve current node: use currentNodeId if set, else default to first node
    const nodeId = instance.currentNodeId;
    let node: NodeSnapshot | undefined;

    if (nodeId) {
      node = nodeGraph.find((n) => n.id === nodeId);
    }

    // Post-accept handoff: the negotiation ACCEPT clears currentNodeId (it sets
    // nextNodeId: null on the terminal-looking transition). When the instance is
    // ACCEPTED (or in the legacy REWARD_PENDING lifecycle), resolve to the node
    // that owns the post-acceptance email so its executor runs rather than falling
    // back to the first node. In the merged flow that is the CONTENT_BRIEF node;
    // legacy graphs still resolve to REWARD_SETUP. This keeps the negotiation
    // executor untouched.
    if (
      !node &&
      (instance.currentState === "ACCEPTED" || instance.currentState === "REWARD_PENDING")
    ) {
      node = nodeGraph.find((n) => n.type === "REWARD_SETUP");
      if (!node && instance.currentState === "ACCEPTED") {
        node = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
      }
    }

    // Payout-collection handoff: mirrors the resolution above. The PAYMENT_PENDING
    // waiting state is owned by whichever node collects payout — the CONTENT_BRIEF
    // node in the merged flow, or the legacy PAYMENT_INFO node. Resolve to
    // PAYMENT_INFO when that node exists (legacy graphs), otherwise to CONTENT_BRIEF
    // (merged graphs). REWARD_CONFIRMED is legacy-only and can ONLY mean "hand off
    // to Payment Info". Resolve even when currentNodeId still points at the prior
    // node — not just when it failed to resolve — so dispatch stays state-driven.
    if (
      instance.currentState === "REWARD_CONFIRMED" ||
      instance.currentState === "PAYMENT_PENDING"
    ) {
      const paymentNode = nodeGraph.find((n) => n.type === "PAYMENT_INFO");
      if (paymentNode) {
        if (node?.type !== "PAYMENT_INFO") node = paymentNode;
      } else if (instance.currentState === "PAYMENT_PENDING") {
        const contentBriefNode = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
        if (contentBriefNode && node?.type !== "CONTENT_BRIEF") node = contentBriefNode;
      }
    }

    // Content Brief handoff: mirrors the Payment Info resolution above. Once the
    // payout form is submitted the instance is PAYMENT_RECEIVED with its output
    // pointing at the Content Brief node; PAYMENT_RECEIVED can ONLY mean "hand off
    // to Content Brief" (the payment node never handles it), so resolve to the
    // CONTENT_BRIEF node even if currentNodeId still points at the payment node.
    if (instance.currentState === "PAYMENT_RECEIVED") {
      const contentBriefNode = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
      if (contentBriefNode && node?.type !== "CONTENT_BRIEF") {
        node = contentBriefNode;
      }
    }

    // Brand-approval gate: the AWAITING_BRAND_APPROVAL waiting state is owned by
    // the CONTENT_BRIEF node (same owner as PAYMENT_PENDING). On the brand's
    // Approve, the route steps this node's SEND phase, which sends the merged brief
    // + payout link and advances to PAYMENT_PENDING. Resolve to CONTENT_BRIEF even
    // if currentNodeId still points at it — dispatch stays state-driven.
    if (instance.currentState === "AWAITING_BRAND_APPROVAL") {
      const contentBriefNode = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
      if (contentBriefNode && node?.type !== "CONTENT_BRIEF") {
        node = contentBriefNode;
      }
    }

    if (!node) {
      // Default to the first node (lowest order)
      const sorted = [...nodeGraph].sort((a, b) => a.order - b.order);
      node = sorted[0];
    }

    if (!node) {
      throw new Error(`No nodes found in nodeGraph for version ${version.id}`);
    }

    // H5: load the parent campaign (if any) so executors can fall back to its
    // brand context when a node's config wasn't stamped with it. version →
    // workflow → campaign. Best-effort: a missing/unlinked campaign is normal
    // (seeded/legacy workflows have campaignId=null) and must not break
    // execution, so any lookup failure degrades to "no campaign fallback".
    let campaign = null;
    try {
      const workflow = await findWorkflowById(version.workflowId);
      if (workflow?.campaignId) {
        campaign = await findCampaignById(workflow.campaignId);
      }
    } catch {
      campaign = null;
    }

    return { instance, node, nodeGraph, creator, campaign };
  }

  // -------------------------------------------------------------------------
  // stepInstance
  // -------------------------------------------------------------------------

  async stepInstance(
    instanceId: string,
    opts?: {
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
      // Disambiguates the Payment Info waiting phase: a hosted-form submission
      // (default) finalizes the payout and advances; an inbound email "reply"
      // triggers the "rate is fixed" auto-reply and stays in PAYMENT_PENDING.
      // Ignored by every other node type.
      phase?: "submission" | "reply";
    },
  ): Promise<ExecutionContext> {
    const ctx = await this.loadContext(instanceId);
    const { instance, node, creator } = ctx;

    if (isTerminal(instance.currentState)) {
      throw new Error(
        `Instance ${instanceId} is in terminal state ${instance.currentState} — cannot step further`,
      );
    }

    // Dispatch to the correct executor. Every agent (LLM) call an executor
    // makes flows through this frame, so scoping the LLM-usage attribution
    // here stamps the instanceId onto the persisted telemetry (HARD-O1)
    // without threading an id through IAgentProvider and every executor.
    const result = await runWithLlmAttribution(instanceId, () =>
      this.dispatch(ctx, opts?.phase),
    );

    // Validate the proposed transition
    assertTransition(instance.currentState, result.nextState);

    // Build the update patch
    const patch: Parameters<typeof updateInstanceState>[1] = {
      currentState: result.nextState,
      currentNodeId: result.nextNodeId,
    };
    if (result.followUpCount !== undefined) {
      patch.followUpCount = result.followUpCount;
    }
    if (result.negotiationRound !== undefined) {
      patch.negotiationRound = result.negotiationRound;
    }
    if (Object.prototype.hasOwnProperty.call(result, "dueAt")) {
      patch.dueAt = result.dueAt ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(result, "completedAt")) {
      patch.completedAt = result.completedAt ?? null;
    }

    const now = new Date();

    // Attribute the transition. Explicit caller source wins; otherwise infer
    // the responsible agent from the domain event type so the timeline/logs can
    // answer "who triggered this" even when the worker doesn't pass a source.
    const source: TransitionSource =
      opts?.source ?? inferSourceFromEvent(result.eventType);
    const stateChanged = instance.currentState !== result.nextState;

    // W-7: commit the OCC state write and the follow-on event appends in ONE
    // transaction. Previously these were three separate statements — a crash
    // after the state write but before the NEGOTIATION_TURN/STATE_TRANSITION
    // append could commit an ACCEPT whose agreed rate is then unrecoverable from
    // the event log (the money trail is a replay of NEGOTIATION_TURN events), so
    // downstream fee resolution would escalate `no_agreed_fee`. Wrapping them
    // means either all three land or none do; a lost race still rolls the whole
    // step back and the job retries. The transaction returns whether the OCC
    // write won; a StaleInstanceError is thrown OUTSIDE the tx so the rollback
    // has already happened by the time callers see it.
    const updated = await db.transaction(async (tx) => {
      // Persist state change — OCC: only succeeds if (currentState AND version)
      // still match the snapshot we loaded. BUG-E1: passing the loaded version
      // guards X→X self-transitions (a negotiation round staying NEGOTIATING, or a
      // re-run landing on the same state) that currentState alone can't.
      const row = await updateInstanceStateConditional(
        instanceId,
        instance.currentState,
        patch,
        tx,
        instance.version,
      );
      if (!row) {
        // Another worker already advanced this instance. Roll back the (empty)
        // transaction; do NOT append events for a step that didn't happen.
        return null;
      }

      // Write domain event (OUTREACH_DRAFTED, FOLLOW_UP_DUE, NEGOTIATION_TURN,
      // …). For negotiation this IS the money trail, so it must be atomic with
      // the state write above.
      await appendEvent(
        {
          instanceId,
          type: result.eventType,
          nodeId: node.id,
          payload: (result.eventPayload ?? {}) as InputJsonValue,
          occurredAt: now,
        },
        tx,
      );

      // Write STATE_TRANSITION event (only if state actually changed).
      if (stateChanged) {
        await appendEvent(
          {
            instanceId,
            type: "STATE_TRANSITION",
            nodeId: node.id,
            // `source`, `worker`, `queueJobId` are persisted so end-to-end
            // traceability (Phase 9 Part 10) does not depend on stdout.
            payload: {
              from: instance.currentState,
              to: result.nextState,
              source,
              ...(opts?.worker ? { worker: opts.worker } : {}),
              ...(opts?.queueJobId ? { queueJobId: opts.queueJobId } : {}),
            } as InputJsonValue,
            occurredAt: now,
          },
          tx,
        );
      }

      // PLU-111: apply the conversation-obligation write-plan INSIDE this same
      // transaction (invariant #5, §4.6) — so a rolled-back turn (returned above
      // on a stale OCC) leaves no half-written obligation. The ANSWERED/COMPLETED
      // transition does NOT happen here; only create/update + the reserve-time
      // resolution LINK. The terminal transition fires later at flush time, gated
      // on the resolving Message's sentAt (resolveObligationsByResolutionMessage).
      if (result.obligationWrites) {
        await applyObligationWrites(instanceId, result.obligationWrites, tx);
      }

      // PLU-113: apply the campaign-creator-memory write-plan INSIDE this same
      // transaction (§4.7) — so a rolled-back turn (stale OCC above) leaves no
      // half-written fact, exactly like obligations. Wrapped so a bug in the
      // plan-application layer (a malformed item, an unexpected shape) degrades to
      // "no memory this turn" and never throws out of the tx callback — memory is
      // additive context, never worth costing a reply (invariant #9). A genuine DB
      // error still surfaces (the turn retries), same as obligations; the internal
      // upsert already absorbs the expected unique-violation race.
      if (result.memoryWrites) {
        try {
          await applyMemoryWrites(instanceId, result.memoryWrites, tx);
        } catch (err) {
          console.error(
            `[runtime] memory writes failed for instance ${instanceId} — ` +
              `continuing without memory this turn. ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return row;
    });

    if (!updated) {
      // Another worker already advanced this instance — treat as a no-op.
      throw new StaleInstanceError(instanceId, instance.currentState);
    }

    // ── Randomized Send Delay — enqueue the deferred flush (§4.3a option A) ────
    // The executor RESERVED an AI reply row but did NOT send it; the delayed
    // flush is enqueued HERE, strictly AFTER the OCC transaction committed. On a
    // StaleInstanceError above we never reach this line, so a rolled-back turn
    // leaves its reserved row orphaned (reclaimed/GC'd by the poller sweep) and
    // NEVER sends a phantom email. Redis writes stay downstream of the durable
    // state commit. enqueueDelayedSend is best-effort here: a Redis blip must not
    // roll back a committed transition — the poller safety-net sweep (§4.4) will
    // reclaim a reservation whose enqueue was lost.
    if (result.deferredSend) {
      try {
        await this.enqueueDelayedSendFn(
          { messageId: result.deferredSend.messageId },
          result.deferredSend.delayMs,
        );
      } catch (err) {
        console.error(
          `[runtime] enqueueDelayedSend failed for message ${result.deferredSend.messageId} ` +
            `(instance ${instanceId}); the poller sweep will reclaim it. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Stdout trace is a side effect, not part of the atomic unit — emit it only
    // after the transaction has durably committed the transition.
    if (stateChanged) {
      logTransition({
        instanceId,
        creatorId: creator.id,
        fromState: instance.currentState,
        toState: result.nextState,
        source,
        worker: opts?.worker,
        queueJobId: opts?.queueJobId,
        nodeId: node.id,
      });
    }

    // ── Manual-queue escalation notification ─────────────────────────────────
    // A fresh transition INTO MANUAL_REVIEW means the creator just landed in the
    // manual queue. Email the brand so a human can take over. Best-effort: the
    // state is already persisted above, and notifyBrandOfEscalation never throws,
    // so a notification failure cannot roll back or block the workflow step.
    if (result.nextState === "MANUAL_REVIEW" && instance.currentState !== "MANUAL_REVIEW") {
      await notifyBrandOfEscalation(this.email, instanceId, escalationReason(result));
    }

    // ── Deal-finalization notification (PLU-70) ───────────────────────────────
    // A fresh transition into NEEDS_DEAL_FINALIZATION means a creator just
    // agreed on an operator_handoff execution and the deal is waiting on a
    // human. Same contract as the escalation notice above: fired AFTER the state
    // is committed, never throws, and idempotent on (instanceId + reason) — so
    // retrying delivery can never duplicate the transition or the DealHandoff.
    if (
      result.nextState === "NEEDS_DEAL_FINALIZATION" &&
      instance.currentState !== "NEEDS_DEAL_FINALIZATION"
    ) {
      await notifyOperatorOfDealFinalization(this.email, instanceId);
    }

    // NOTE (brand-approval gate): unlike the escalation / deal-finalization
    // notices above, the brand-approval REQUEST email is NOT fired here. The
    // request carries magic-link tokens whose raw value exists only at mint time
    // (the DB stores just the sha256 hash), so it MUST be sent inline by
    // executeBrandApproval, which holds the raw token — a post-commit notifier
    // rebuilding from the row could not reconstruct the links. executeBrandApproval
    // sends it idempotently via sendOnce, so the durability guarantee is the same;
    // there is simply no second sender. (A future operator-triggered RE-SEND from
    // the Manual Queue would re-mint a token + update the row hash — out of scope
    // for v1.)

    // Return updated context
    return this.loadContext(instanceId);
  }

  // -------------------------------------------------------------------------
  // persistInboundMessageOnce
  // -------------------------------------------------------------------------
  // CRITICAL-6: create the INBOUND Message row idempotently. If a prior attempt
  // already persisted this externalMessageId (then crashed before fully
  // processing), the retry must NOT hit the unique constraint — it skips the
  // insert and re-runs the rest of the handler. Returns the externalMessageId so
  // callers can mark it processed on success. A row with no externalMessageId
  // (mock-generated) is always fresh, so it is created unconditionally.

  private async persistInboundMessageOnce(
    instanceId: string,
    externalMessageId: string,
    data: Omit<MessageInsert, "instanceId" | "direction" | "externalMessageId">,
  ): Promise<void> {
    const existing = await findMessageByExternalId(externalMessageId);
    if (existing) return; // already persisted by a prior (crashed) attempt
    await createMessage({
      instanceId,
      direction: "INBOUND",
      externalMessageId,
      ...data,
    });
  }

  // -------------------------------------------------------------------------
  // injectReply
  // -------------------------------------------------------------------------

  async injectReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
    },
  ): Promise<void> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    const now = new Date();
    // Use caller-provided id when available so the inbound-email worker's
    // idempotency check (findMessageByExternalId) can find the row it created.
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // CRITICAL-6 (b): assert the accepting transition BEFORE persisting the
    // Message row. The old order (persist → assertTransition) meant a reply
    // arriving in a state with no REPLY_RECEIVED edge left an orphan Message row
    // and then threw — and because the worker's idempotency check keys on the
    // persisted row, every retry no-op'd and the reply was lost forever. With the
    // accepting edges added in stateMachine (OUTREACH_SENT / NEGOTIATING) this is
    // now also defense-in-depth: an unexpected state fails fast with no orphan row
    // (so a retry, or a state-machine fix, can still process the reply).
    assertTransition(instance.currentState, "REPLY_RECEIVED");

    // Resolve the REPLY_DETECTION node from the actual workflow version so
    // loadContext can dispatch correctly regardless of what the node is named.
    const version = await findVersionById(instance.workflowVersionId);
    const nodeGraph = (version?.nodeGraph ?? []) as unknown as NodeSnapshot[];
    const replyNode = nodeGraph.find((n) => n.type === "REPLY_DETECTION");

    // Create inbound message record (after the transition is known to be legal),
    // idempotently so a retry after a mid-handler crash re-processes rather than
    // hitting the unique constraint (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    // Transition to REPLY_RECEIVED — OCC: only succeeds if state hasn't changed.
    // W-3: clear the outreach/follow-up-era dueAt. A reply ENDS the wait it was
    // scheduling for; leaving it set means a stale dueAt lapses later and the due
    // poller enqueues a spurious job against whatever node the instance has since
    // moved to (e.g. a NEGOTIATION-node AWAITING_REPLY → "expects NEGOTIATING
    // state" crash loop). The reply path owns its own scheduling from here on.
    //
    // W-7: same atomic unit as stepInstance — the OCC state write and its event
    // appends commit together, so a crash can't record REPLY_RECEIVED with no
    // INBOUND_REPLY_RECEIVED/STATE_TRANSITION trail (or vice versa).
    const updatedForReply = await db.transaction(async (tx) => {
      const row = await updateInstanceStateConditional(
        instanceId,
        instance.currentState,
        {
          currentState: "REPLY_RECEIVED",
          currentNodeId: replyNode?.id ?? "node-reply-detection",
          dueAt: null,
        },
        tx,
        instance.version, // BUG-E1: version-guarded OCC (guards X→X too).
      );
      if (!row) return null;

      // Write inbound reply event
      await appendEvent(
        {
          instanceId,
          type: "INBOUND_REPLY_RECEIVED",
          nodeId: instance.currentNodeId ?? null,
          payload: { subject: opts.subject, externalMessageId },
          occurredAt: now,
        },
        tx,
      );

      // Write state transition event — attributed to the inbound email itself.
      await appendEvent(
        {
          instanceId,
          type: "STATE_TRANSITION",
          nodeId: instance.currentNodeId ?? null,
          payload: { from: instance.currentState, to: "REPLY_RECEIVED", source: "inbound-email" },
          occurredAt: now,
        },
        tx,
      );

      return row;
    });
    if (!updatedForReply) {
      throw new StaleInstanceError(instanceId, instance.currentState);
    }

    logTransition({
      instanceId,
      creatorId: instance.creatorId,
      fromState: instance.currentState,
      toState: "REPLY_RECEIVED",
      source: "inbound-email",
      nodeId: instance.currentNodeId ?? null,
      meta: { externalMessageId },
    });
  }

  // -------------------------------------------------------------------------
  // handleRewardReply
  // -------------------------------------------------------------------------
  // An inbound reply arrived while the instance is in REWARD_PENDING (Reward
  // Setup waiting on the creator to confirm the agreement). This does NOT go
  // through the negotiation/first-reply classifier: it persists the inbound
  // message and steps the Reward Setup node, whose REWARD_PENDING dispatch runs
  // executeRewardReply (agreement → REWARD_CONFIRMED, else stay REWARD_PENDING).
  //
  // Kept separate from injectReply (which forces REPLY_RECEIVED, valid only from
  // the AWAITING_REPLY family) so the reward-confirmation reply stays inside the
  // Reward Setup node and the four locked nodes are untouched.

  async handleRewardReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    },
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "REWARD_PENDING") {
      throw new Error(
        `handleRewardReply expects REWARD_PENDING state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Persist the inbound reply so executeRewardReply can read it (same contract
    // as injectReply → executeReplyDetection). Idempotent on externalMessageId so
    // a retry after a mid-handler crash re-processes rather than double-inserting
    // (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    await appendEvent({
      instanceId,
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId, rewardReply: true },
      occurredAt: now,
    });

    // Step the node — dispatch sees REWARD_PENDING and runs executeRewardReply,
    // reusing the standard OCC + event-writing path in stepInstance.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "inbound-email",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
    });
  }

  // -------------------------------------------------------------------------
  // handlePaymentReply
  // -------------------------------------------------------------------------
  // An inbound EMAIL reply arrived while the instance is in PAYMENT_PENDING
  // (Payment Info waiting on the creator's payout FORM submission). The expected
  // action here is the hosted form, not an email — so an email is usually a
  // question or a re-negotiation attempt. The deal is already closed at a fixed
  // fee, so this does NOT negotiate: it persists the inbound message and steps the
  // Payment Info node in the "reply" phase, which sends the "rate is fixed"
  // auto-reply (redirecting the creator to the payout form) and stays in
  // PAYMENT_PENDING.
  //
  // Kept separate from handlePaymentSubmission (a form submission, no Message row)
  // and from injectReply (which forces REPLY_RECEIVED, invalid from PAYMENT_PENDING).

  async handlePaymentReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    },
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "PAYMENT_PENDING") {
      throw new Error(
        `handlePaymentReply expects PAYMENT_PENDING state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Persist the inbound reply so executePaymentReply can read it (same contract
    // as handleRewardReply → executeRewardReply). Idempotent on externalMessageId
    // (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    await appendEvent({
      instanceId,
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId, paymentReply: true },
      occurredAt: now,
    });

    // Step the node in the "reply" phase — dispatch runs executePaymentReply
    // (sends the "rate is fixed" auto-reply, stays PAYMENT_PENDING), reusing the
    // standard OCC + event-writing path in stepInstance.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "inbound-email",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
      phase: "reply",
    });
  }

  // -------------------------------------------------------------------------
  // handleContentLinksReply
  // -------------------------------------------------------------------------
  // An inbound EMAIL reply arrived while the instance is in CONTENT_LINKS_PENDING
  // (the merged Content Brief node parked after the payout form, having asked the
  // creator to reply in the thread with their content links). This persists the
  // inbound message and steps the Content Brief node in the "reply" phase, which
  // dispatch routes to executeContentLinksReply: opt-out → OPTED_OUT; URLs present
  // → append CONTENT_LINKS_SUBMITTED + escalate to MANUAL_REVIEW; no URLs → nudge
  // and stay in CONTENT_LINKS_PENDING.
  //
  // Kept separate from handlePaymentReply (a PAYMENT_PENDING reply) and from
  // injectReply (which forces REPLY_RECEIVED, invalid from CONTENT_LINKS_PENDING).

  async handleContentLinksReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    },
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "CONTENT_LINKS_PENDING") {
      throw new Error(
        `handleContentLinksReply expects CONTENT_LINKS_PENDING state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Persist the inbound reply so executeContentLinksReply can read it (same
    // contract as handlePaymentReply → executePaymentReply). Idempotent on
    // externalMessageId (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    await appendEvent({
      instanceId,
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId, contentLinksReply: true },
      occurredAt: now,
    });

    // Step the node in the "reply" phase — dispatch runs executeContentLinksReply,
    // reusing the standard OCC + event-writing path in stepInstance.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "inbound-email",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
      phase: "reply",
    });
  }

  // -------------------------------------------------------------------------
  // recordHandoffReply (PLU-70)
  // -------------------------------------------------------------------------
  // A creator replied while the run is parked in NEEDS_DEAL_FINALIZATION —
  // typically answering the "I'm looping in our campaign manager" note.
  //
  // This deliberately does NOT step, transition, or auto-reply. An operator owns
  // this conversation now; an automated answer would cut across a human who is
  // mid-negotiation on the final details. So we persist the message (it shows up
  // in the inspector's thread like any other), record the event, and FORWARD it
  // to the operator so a creator who hit plain "reply" instead of "reply all"
  // still reaches them. The instance stays exactly where it is.
  //
  // Kept separate from injectReply, whose forced REPLY_RECEIVED transition is
  // invalid from NEEDS_DEAL_FINALIZATION and would throw — which is precisely
  // why the inbound worker needs this branch rather than falling through.

  async recordHandoffReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
    },
  ): Promise<void> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "NEEDS_DEAL_FINALIZATION") {
      throw new Error(
        `recordHandoffReply expects NEEDS_DEAL_FINALIZATION state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Idempotent on externalMessageId (CRITICAL-6): a retried delivery re-runs
    // this handler, skips the insert, and re-attempts only the forward — which is
    // itself keyed on the message id, so the operator is emailed exactly once.
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    await appendEvent({
      instanceId,
      type: "DEAL_HANDOFF_REPLY",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId },
      occurredAt: now,
    });

    // Best-effort, like every other notification: a forwarding failure is
    // recorded on the BrandNotification row, never thrown at the worker (which
    // would retry the whole delivery and re-persist nothing useful).
    await notifyOperatorOfHandoffReply(this.email, instanceId, {
      externalMessageId,
      subject: opts.subject,
      body: opts.body,
    });
  }

  // -------------------------------------------------------------------------
  // handlePaymentSubmission
  // -------------------------------------------------------------------------
  // The creator submitted the hosted payout form while the instance is in
  // PAYMENT_PENDING. This persists the payout fields (markPaymentReceived) and
  // then steps the Payment Info node, whose PAYMENT_PENDING dispatch runs
  // executePaymentSubmission (→ PAYMENT_RECEIVED, exposing the output
  // connection). The engine then resumes into the next connected node — the node
  // is NOT executed by this handler.
  //
  // Kept separate from injectReply/handleRewardReply because a form submission is
  // not an inbound email: there is no Message row and the transition is driven by
  // stored payout data, not a classified reply.

  async handlePaymentSubmission(
    instanceId: string,
    submission: {
      method: PayoutMethod;
      accountIdentifier: string;
      country?: string | null;
      notes?: string | null;
      /** Extra payout/fulfillment data preserved verbatim on PaymentInfo.extra
       *  (e.g. the shipping address when the campaign ships a physical product). */
      extra?: InputJsonValue;
    },
    opts: {
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    } = {},
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "PAYMENT_PENDING") {
      throw new Error(
        `handlePaymentSubmission expects PAYMENT_PENDING state, got ${instance.currentState}`,
      );
    }

    // Persist the payout fields BEFORE stepping, so executePaymentSubmission
    // reads a PAYMENT_RECEIVED row (same contract as inbound reply persistence).
    await markPaymentReceived(instanceId, {
      method: submission.method,
      accountIdentifier: submission.accountIdentifier,
      country: submission.country ?? null,
      notes: submission.notes ?? null,
      ...(submission.extra !== undefined ? { extra: submission.extra } : {}),
    });

    // Step the node — dispatch sees PAYMENT_PENDING and runs
    // executePaymentSubmission, reusing the standard OCC + event-writing path.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "payment-form",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
    });
  }

  // -------------------------------------------------------------------------
  // handleBrandApproval
  // -------------------------------------------------------------------------
  // The brand clicked Approve or Reject on the magic-link email while the instance
  // is parked in AWAITING_BRAND_APPROVAL (brand-approval gate). Driven by the
  // /brand-approval route AFTER it has recorded the decision on the BrandApproval
  // row (markBrandApprovalDecided).
  //
  //   APPROVED → step the node. Dispatch sees AWAITING_BRAND_APPROVAL on the
  //              CONTENT_BRIEF node and runs executeContentBrief's SEND phase (the
  //              merged brief + payout link finally go out), landing on
  //              PAYMENT_PENDING — the exact behavior a non-gated ACCEPT would have
  //              had, just deferred until sign-off.
  //   REJECTED → a DIRECT OCC transition to MANUAL_REVIEW (NOT via dispatch, which
  //              would send the content brief). The standard post-commit brand
  //              escalation notice then fires so a human picks it up.
  //
  // Idempotency: the route only calls this after markBrandApprovalDecided matched a
  // still-AWAITING row (so a double-click no-ops at the row level and never reaches
  // here twice). The APPROVED path additionally rides stepInstance's version-guarded
  // OCC; the REJECTED path uses the same OCC helper, so a racing call is a no-op.

  async handleBrandApproval(
    instanceId: string,
    decision: "APPROVED" | "REJECTED",
    opts: {
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    } = {},
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "AWAITING_BRAND_APPROVAL") {
      throw new Error(
        `handleBrandApproval expects AWAITING_BRAND_APPROVAL state, got ${instance.currentState}`,
      );
    }

    if (decision === "APPROVED") {
      // Step the node — dispatch sees AWAITING_BRAND_APPROVAL on CONTENT_BRIEF and
      // runs the merged SEND phase (→ PAYMENT_PENDING), reusing the standard OCC +
      // event-writing path. Record the BRAND_APPROVED audit event first.
      await appendEvent({
        instanceId,
        type: "BRAND_APPROVED",
        nodeId: instance.currentNodeId ?? null,
        payload: { source: opts.source ?? "brand-approval-link" },
      });
      return this.stepInstance(instanceId, {
        source: opts.source ?? "brand-approval-link",
        worker: opts.worker,
        queueJobId: opts.queueJobId,
      });
    }

    // REJECTED — direct, version-guarded OCC transition to MANUAL_REVIEW. We do NOT
    // step the dispatcher (that would run executeContentBrief and email the creator
    // the brief we are precisely trying to withhold). The BRAND_REJECTED +
    // STATE_TRANSITION events commit atomically with the state write.

    // Reserve the courteous creator close email BEFORE the OCC commit (so a
    // rolled-back reject never emails). The delayed flush is enqueued AFTER the
    // commit below — same reserve-then-flush discipline as the max-rounds
    // auto-close. Best-effort + idempotent (keyed per instance): it never throws
    // and a double-click / retry can't double-email, so it can't block the reject.
    const rejectCtx = await this.loadContext(instanceId);
    const closeSend = await reserveBrandRejectCloseEmail(rejectCtx, this.email);

    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const row = await updateInstanceStateConditional(
        instanceId,
        instance.currentState,
        {
          currentState: "MANUAL_REVIEW",
          currentNodeId: instance.currentNodeId ?? null,
          completedAt: now,
          dueAt: null,
        },
        tx,
        instance.version, // BUG-E1: version-guarded OCC.
      );
      if (!row) return null;

      await appendEvent(
        {
          instanceId,
          type: "BRAND_REJECTED",
          nodeId: instance.currentNodeId ?? null,
          payload: { source: opts.source ?? "brand-approval-link" },
          occurredAt: now,
        },
        tx,
      );
      await appendEvent(
        {
          instanceId,
          type: "STATE_TRANSITION",
          nodeId: instance.currentNodeId ?? null,
          payload: {
            from: instance.currentState,
            to: "MANUAL_REVIEW",
            source: opts.source ?? "brand-approval-link",
          },
          occurredAt: now,
        },
        tx,
      );
      return row;
    });
    if (!updated) {
      throw new StaleInstanceError(instanceId, instance.currentState);
    }

    logTransition({
      instanceId,
      creatorId: instance.creatorId,
      fromState: instance.currentState,
      toState: "MANUAL_REVIEW",
      source: opts.source ?? "brand-approval-link",
      nodeId: instance.currentNodeId ?? null,
    });

    // Enqueue the delayed flush of the reserved creator close email, strictly AFTER
    // the OCC transaction committed. Best-effort: a Redis blip must not undo the
    // committed reject — the poller safety-net sweep reclaims a reservation whose
    // enqueue was lost. (Mirrors the deferredSend flush in stepInstance.)
    if (closeSend) {
      try {
        await this.enqueueDelayedSendFn({ messageId: closeSend.messageId }, closeSend.delayMs);
      } catch (err) {
        console.error(
          `[runtime] enqueueDelayedSend failed for brand-reject close email ` +
            `${closeSend.messageId} (instance ${instanceId}); the poller sweep will reclaim it. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Fire the standard brand-escalation notice (best-effort, never throws) so the
    // rejected deal surfaces in the Manual Queue / operator inbox with a reason.
    await notifyBrandOfEscalation(this.email, instanceId, "brand_rejected");

    return this.loadContext(instanceId);
  }

  // -------------------------------------------------------------------------
  // runUntilWaiting
  // -------------------------------------------------------------------------

  async runUntilWaiting(instanceId: string): Promise<InstanceState> {
    let ctx = await this.loadContext(instanceId);

    while (true) {
      const state = ctx.instance.currentState;

      // Stop at terminal states
      if (isTerminal(state)) {
        return state;
      }

      // Backward compatibility: a workflow published before both Reward Setup and
      // Content Brief has neither node. For those, ACCEPTED is effectively terminal
      // (there is nowhere to advance to), so stop here rather than trying to step
      // it. When a CONTENT_BRIEF node IS present (merged flow), ACCEPTED is NOT a
      // stop state — the loop steps into the merged email send, which lands on
      // PAYMENT_PENDING (a stop state below).
      if (
        state === "ACCEPTED" &&
        !hasRewardSetupNode(ctx.nodeGraph) &&
        !hasContentBriefNode(ctx.nodeGraph)
      ) {
        return state;
      }

      // Backward compatibility: a workflow published before Payment Info has no
      // PAYMENT_INFO node. For those, REWARD_CONFIRMED is effectively terminal,
      // so stop here rather than trying to step it.
      if (state === "REWARD_CONFIRMED" && !hasPaymentInfoNode(ctx.nodeGraph)) {
        return state;
      }

      // Backward compatibility: a workflow published before Content Brief has no
      // CONTENT_BRIEF node. For those, PAYMENT_RECEIVED is effectively terminal,
      // so stop here rather than trying to step it. When a CONTENT_BRIEF node IS
      // present, PAYMENT_RECEIVED is NOT a stop state — Content Brief has no
      // waiting phase, so the loop steps straight through to CONTENT_BRIEF_SENT.
      if (state === "PAYMENT_RECEIVED" && !hasContentBriefNode(ctx.nodeGraph)) {
        return state;
      }

      // Stop at AWAITING_REPLY — harness injects a reply or triggers follow-ups manually
      if (state === "AWAITING_REPLY") {
        return state;
      }

      // Stop at NEGOTIATING — harness drives negotiation turns manually
      if (state === "NEGOTIATING") {
        return state;
      }

      // Stop at REWARD_PENDING — Reward Setup waits for the creator's agreement
      // reply (delivered via handleRewardReply), same as AWAITING_REPLY.
      if (state === "REWARD_PENDING") {
        return state;
      }

      // Stop at PAYMENT_PENDING — the payout-collection node (Content Brief in the
      // merged flow, or legacy Payment Info) waits for the creator's payout form
      // submission (delivered via handlePaymentSubmission), same as above.
      if (state === "PAYMENT_PENDING") {
        return state;
      }

      // Stop at CONTENT_LINKS_PENDING — after the payout form is submitted, the
      // merged Content Brief node parks here waiting for the creator's content-links
      // reply (delivered via handleContentLinksReply), same as the other waiting
      // states. Without this stop the loop would re-step the CONTENT_BRIEF node with
      // no reply to process.
      if (state === "CONTENT_LINKS_PENDING") {
        return state;
      }

      // PLU-70: stop at NEEDS_DEAL_FINALIZATION — the operator-handoff branch is
      // parked on a HUMAN finalizing the deal in main Pluvus. It leaves this
      // state only via the Manual Queue's complete action, never by stepping.
      if (state === "NEEDS_DEAL_FINALIZATION") {
        return state;
      }

      // Brand-approval gate: stop at AWAITING_BRAND_APPROVAL — the deal is parked on
      // the BRAND clicking Approve/Reject (delivered via handleBrandApproval from the
      // magic-link route). It leaves this state only via that action, never by
      // stepping, so without this stop the loop would re-run executeBrandApproval.
      if (state === "AWAITING_BRAND_APPROVAL") {
        return state;
      }

      ctx = await this.stepInstance(instanceId);
    }
  }

  // -------------------------------------------------------------------------
  // rewardSetupApplies — does this instance's workflow have a Reward Setup node?
  // -------------------------------------------------------------------------
  // Used by the node-execution worker to decide whether an ACCEPTED instance
  // should auto-chain into Reward Setup. Legacy workflows (no REWARD_SETUP node)
  // return false so ACCEPTED stays put — the pre-Reward-Setup terminal behavior.

  async rewardSetupApplies(instanceId: string): Promise<boolean> {
    const ctx = await this.loadContext(instanceId);
    return hasRewardSetupNode(ctx.nodeGraph);
  }

  // -------------------------------------------------------------------------
  // paymentInfoApplies — does this instance's workflow have a Payment Info node?
  // -------------------------------------------------------------------------
  // Used by the node-execution worker to decide whether a REWARD_CONFIRMED
  // instance should auto-chain into Payment Info. Legacy workflows (no
  // PAYMENT_INFO node) return false so REWARD_CONFIRMED stays terminal.

  async paymentInfoApplies(instanceId: string): Promise<boolean> {
    const ctx = await this.loadContext(instanceId);
    return hasPaymentInfoNode(ctx.nodeGraph);
  }

  // -------------------------------------------------------------------------
  // contentBriefApplies — does this instance's workflow have a Content Brief node?
  // -------------------------------------------------------------------------
  // Used by the node-execution worker to decide whether a PAYMENT_RECEIVED
  // instance should auto-chain into Content Brief. Legacy workflows (no
  // CONTENT_BRIEF node) return false so PAYMENT_RECEIVED stays terminal.

  async contentBriefApplies(instanceId: string): Promise<boolean> {
    const ctx = await this.loadContext(instanceId);
    return hasContentBriefNode(ctx.nodeGraph);
  }

  // -------------------------------------------------------------------------
  // Private: dispatch to executor
  // -------------------------------------------------------------------------

  private async dispatch(
    ctx: ExecutionContext,
    phase: "submission" | "reply" = "submission",
  ) {
    const { node } = ctx;

    // PLU-70: the operator-handoff branch is keyed on STATE + the execution's
    // stamped mode, not on a node type — there is no handoff node in any graph.
    // Checking it before the node-type switch means it works identically for the
    // merged flow (CONTENT_BRIEF), legacy graphs (REWARD_SETUP), and graphs with
    // neither, and means no published WorkflowVersion had to change.
    //
    // Gated on the instance's OWN postAcceptanceMode, which is stamped once at
    // enrollment. Every pre-existing instance is local_payment, so this branch is
    // unreachable for them and their behavior is untouched.
    if (
      ctx.instance.currentState === "ACCEPTED" &&
      ctx.instance.postAcceptanceMode === "operator_handoff"
    ) {
      return executeOperatorHandoff(ctx, this.email);
    }

    // Brand-approval gate: on ACCEPTED for a local_payment execution, when the
    // gate flag is ON, hold the deal for the brand's Approve/Reject BEFORE the
    // content brief goes out. Same keying discipline as operator_handoff — checked
    // before the node switch so it works for any graph. OFF by default, so every
    // existing run is unchanged; the flag is read here at ACCEPT time only, so
    // flipping it never re-gates an in-flight run. operator_handoff takes
    // precedence (its branch is above), so the two gates never both fire.
    if (
      ctx.instance.currentState === "ACCEPTED" &&
      ctx.instance.postAcceptanceMode === "local_payment" &&
      brandApprovalGateEnabled()
    ) {
      return executeBrandApproval(ctx, this.email);
    }

    switch (node.type) {
      case "IMPORT_CREATOR_LIST":
        return executeImportCreatorList(ctx, this.email, this.agent);
      case "INITIAL_OUTREACH":
        return executeInitialOutreach(ctx, this.email, this.agent);
      case "FOLLOW_UP":
        return executeFollowUp(ctx, this.email, this.agent);
      case "REPLY_DETECTION":
        return executeReplyDetection(ctx, this.email, this.agent);
      case "NEGOTIATION":
        return executeNegotiation(ctx, this.email, this.agent);
      case "REWARD_SETUP":
        // The Reward Setup node has two phases keyed on state:
        //   ACCEPTED       → send the agreement-confirmation email, enter waiting
        //   REWARD_PENDING → an inbound reply arrived; decide confirm vs. keep waiting
        // The reply phase is normally driven via handleRewardReply (inbound
        // worker); dispatching on state keeps a direct stepInstance() correct too.
        if (ctx.instance.currentState === "REWARD_PENDING") {
          return executeRewardReply(ctx, this.email, this.agent);
        }
        return executeRewardSetup(ctx, this.email, this.agent);
      case "PAYMENT_INFO":
        // The Payment Info node has three phases:
        //   REWARD_CONFIRMED            → send the payout-form email, enter waiting
        //   PAYMENT_PENDING + submission → the creator submitted the form; finalize + advance
        //   PAYMENT_PENDING + reply      → an inbound EMAIL arrived (often a
        //                                  re-negotiation attempt); send the "rate
        //                                  is fixed" auto-reply and stay waiting.
        // The submission phase is driven via handlePaymentSubmission (the hosted
        // payment route); the reply phase via handlePaymentReply (inbound worker).
        // The phase defaults to "submission" so a direct stepInstance() is
        // unchanged from before.
        if (ctx.instance.currentState === "PAYMENT_PENDING") {
          return phase === "reply"
            ? executePaymentReply(ctx, this.email, this.agent)
            : executePaymentSubmission(ctx, this.email, this.agent);
        }
        return executePaymentInfo(ctx, this.email, this.agent);
      case "CONTENT_BRIEF":
        // Content Brief is the merged post-negotiation node. Phases keyed on state:
        //   ACCEPTED                     → send the merged email (finalized offer +
        //                                  payout link + brief PDF), enter waiting
        //   PAYMENT_PENDING + submission → the creator submitted the payout form;
        //                                  mint the ledger and park on
        //                                  CONTENT_LINKS_PENDING (await content links)
        //   PAYMENT_PENDING + reply      → an inbound EMAIL arrived (often a
        //                                  re-negotiation attempt); send the "rate
        //                                  is fixed" auto-reply and stay waiting
        //   CONTENT_LINKS_PENDING        → an inbound content-links reply arrived;
        //                                  extract URLs → escalate, or nudge and wait
        //   PAYMENT_RECEIVED             → legacy path: Payment Info already
        //                                  collected payout; send the brief-only
        //                                  email and complete.
        // The submission phase is driven via handlePaymentSubmission (the hosted
        // payment route); the PAYMENT_PENDING reply phase via handlePaymentReply and
        // the CONTENT_LINKS_PENDING reply via handleContentLinksReply (inbound worker).
        if (ctx.instance.currentState === "CONTENT_LINKS_PENDING") {
          return executeContentLinksReply(ctx, this.email, this.agent);
        }
        if (ctx.instance.currentState === "PAYMENT_PENDING") {
          return phase === "reply"
            ? executePaymentReply(ctx, this.email, this.agent)
            : executeContentBriefSubmission(ctx, this.email, this.agent);
        }
        return executeContentBrief(ctx, this.email, this.agent);
      case "END":
        return executeEnd(ctx, this.email, this.agent);
      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// inferSourceFromEvent — attribute a transition to the responsible agent based
// on the domain event the executor emitted. Used when the caller (worker)
// doesn't pass an explicit source. The node-execution worker passes its own
// source for plain advances; classification/negotiation transitions are
// attributed here because the agent — not the worker — owns the decision.
// ---------------------------------------------------------------------------

// True when the workflow graph contains a Reward Setup node. Legacy workflows
// (published before Reward Setup) have only an END node and return false.
function hasRewardSetupNode(nodeGraph: NodeSnapshot[]): boolean {
  return nodeGraph.some((n) => n.type === "REWARD_SETUP");
}

// True when the workflow graph contains a Payment Info node. Legacy workflows
// (published before Payment Info) lack it and return false, so REWARD_CONFIRMED
// stays terminal for them.
function hasPaymentInfoNode(nodeGraph: NodeSnapshot[]): boolean {
  return nodeGraph.some((n) => n.type === "PAYMENT_INFO");
}

// True when the workflow graph contains a Content Brief node. Legacy workflows
// (published before Content Brief) lack it and return false, so PAYMENT_RECEIVED
// stays terminal for them.
function hasContentBriefNode(nodeGraph: NodeSnapshot[]): boolean {
  return nodeGraph.some((n) => n.type === "CONTENT_BRIEF");
}

// ---------------------------------------------------------------------------
// PLU-111 — apply a turn's conversation-obligation write-plan in the tx (§4.6)
// ---------------------------------------------------------------------------
// Runs INSIDE stepInstance's db.transaction, after the domain-event append, with
// the tx handle — so create/update + the reserve-time resolution link commit
// atomically with the NEGOTIATION_TURN event + OCC state write (invariant #5). A
// StaleInstanceError rolls the whole thing back → no half-written obligation.
//
// This does the CREATE/UPDATE and the reserve-time LINK only. The ANSWERED/
// COMPLETED transition happens LATER at flush time (resolveObligationsByResolution-
// Message), gated on the resolving Message's sentAt — never here, never on draft
// generation (invariant #2).
async function applyObligationWrites(
  instanceId: string,
  writes: NonNullable<NodeResult["obligationWrites"]>,
  tx: Db | DbTx,
): Promise<void> {
  // 1. Create/update this turn's creator-question obligations (§4.3, §4.4). A
  //    "touch" bumps the existing open row; an "insert" mints a fresh OPEN row.
  //    upsertQuestionObligation catches a concurrent double-insert on the partial-
  //    unique index, so a BullMQ retry racing the same turn can't double-list.
  for (const item of writes.questionPlan) {
    await upsertQuestionObligation(
      {
        instanceId,
        normalizedKey: item.normalizedKey,
        originalText: item.originalText,
        sourceMessageId: writes.sourceMessageId ?? null,
        category: item.category ?? null,
      },
      tx,
    );
  }

  // 2. Reserve-time resolution LINK (§4.5 step 1): the reserved outbound message
  //    is the one that WILL answer the currently-open questions. Link ALL of the
  //    instance's non-terminal CREATOR_QUESTION obligations to it (they are the
  //    must-answer checklist we handed /draft this turn). Status is left unchanged
  //    — the terminal ANSWERED transition is at flush. If this turn ESCALATED
  //    instead of sending, there's no reserved message and we skip the link.
  const openRows = await listOpenObligationsByInstance(instanceId, tx);
  if (writes.reservedResolutionMessageId) {
    const questionIds = openRows
      .filter((r) => r.type === "CREATOR_QUESTION")
      .map((r) => r.id);
    await linkResolutionMessage(questionIds, writes.reservedResolutionMessageId, tx);
  }

  // 3. Escalation (§4.2): move every non-terminal obligation to ESCALATED (non-
  //    terminal) when this turn escalated on an always-escalate topic. Nothing is
  //    lost — they stay in the AI context and surface in the Manual Queue. Applied
  //    AFTER the plan so rows this turn just created are included.
  if (writes.escalateAfterWrite) {
    await escalateObligations(
      openRows.map((r) => r.id),
      tx,
    );
  }
}

// PLU-113: apply the campaign-creator-memory write-plan INSIDE stepInstance's
// transaction (§4.7), mirroring applyObligationWrites. Each item is an
// insert-or-touch-or-conflict via upsertMemoryFact (which absorbs the concurrent-
// double-insert race on the partial-unique live index). A rolled-back turn rolls
// these back too — no half-written fact. Source is the creator's inbound row.
async function applyMemoryWrites(
  instanceId: string,
  writes: NonNullable<NodeResult["memoryWrites"]>,
  tx: Db | DbTx,
): Promise<void> {
  for (const item of writes.plan) {
    await upsertMemoryFact(
      {
        instanceId,
        key: item.key,
        singleton: item.singleton,
        value: item.value,
        valueNumber: item.valueNumber,
        normalizedValue: item.normalizedValue,
        matchValue: item.matchValue,
        sourceMessageId: writes.sourceMessageId ?? null,
        confidence: item.confidence,
        ...(item.category ? { category: item.category } : {}),
      },
      tx,
    );
  }
}

function inferSourceFromEvent(eventType: EventType): TransitionSource {
  switch (eventType) {
    case "REPLY_CLASSIFIED":
    case "MANUAL_REVIEW_FLAGGED":
      return "classification-agent";
    case "NEGOTIATION_TURN":
      return "negotiation-agent";
    default:
      return "node-execution-worker";
  }
}

// ---------------------------------------------------------------------------
// escalationReason — derive a stable reason code for a MANUAL_REVIEW transition
// from the executor's NodeResult, used in the brand notification + audit row.
//
//   reply detection (low confidence) → MANUAL_REVIEW_FLAGGED, no payload.reason → "low_confidence_reply"
//   negotiation escalations          → NEGOTIATION_TURN with payload.reason
//                                       (max_rounds_reached, output_guard_blocked,
//                                        escalated, max_rounds_reached_on_counter)
//   brand-decision handoff/re-ask    → MANUAL_REVIEW_FLAGGED WITH an explicit
//                                       payload.reason (brand_decision_*, handoff)
// An explicit payload.reason ALWAYS wins so a handoff/re-ask isn't mislabeled as
// low_confidence_reply. Only a MANUAL_REVIEW_FLAGGED with no reason (the original
// reply-detection case) keeps the low_confidence_reply default; otherwise fall
// back to "escalated".
// ---------------------------------------------------------------------------

function escalationReason(result: NodeResult): string {
  const payloadReason = result.eventPayload?.["reason"];
  if (typeof payloadReason === "string" && payloadReason) {
    return payloadReason;
  }
  if (result.eventType === "MANUAL_REVIEW_FLAGGED") {
    return "low_confidence_reply";
  }
  return "escalated";
}
