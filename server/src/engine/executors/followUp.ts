import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { describeDeal } from "../dealDescription.js";
import {
  scanOutboundDraft,
  guardConstraintsFromConfig,
  maskGuardHits,
  type GuardHit,
} from "../guards/outputGuard.js";
import { mergeCampaignFallback } from "../campaignContext.js";

// H4: guard the AI-generated follow-up before sending. A follow-up quotes no
// money, so any floor/ceiling number is a leak → halt for human review.
function followUpBlockedByGuard(hits: GuardHit[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    dueAt: null,
    eventType: "FOLLOW_UP_DUE",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "output_guard_blocked",
      // EASY-S2: mask the band VALUE — record only which KIND leaked.
      leaks: maskGuardHits(hits),
    },
  };
}

function resolveIntervalMs(config: Record<string, unknown>, followUpIndex: number): number {
  const intervals = Array.isArray(config["intervals"]) ? config["intervals"] as number[] : [3, 5, 7];
  const unit = typeof config["intervalUnit"] === "string" ? config["intervalUnit"] : "days";
  const value = intervals[followUpIndex] ?? intervals[intervals.length - 1] ?? 3;
  const multiplier =
    unit === "seconds" ? 1_000 :
    unit === "minutes" ? 60 * 1_000 :
    unit === "hours"   ? 60 * 60 * 1_000 :
    24 * 60 * 60 * 1_000; // days (default)
  return value * multiplier;
}

export async function executeFollowUp(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  // H5: fill missing brand context from the parent campaign (node config wins).
  const config = mergeCampaignFallback(node.config, ctx.campaign);
  const maxCount = typeof config["maxCount"] === "number" ? config["maxCount"] : 3;

  // Case 1: Just sent outreach — enter the first waiting period.
  if (instance.currentState === "OUTREACH_SENT") {
    const dueAt = new Date(Date.now() + resolveIntervalMs(config, 0));
    return {
      nextState: "AWAITING_REPLY",
      nextNodeId: node.id,
      dueAt,
      eventType: "NODE_ENTERED",
      eventPayload: { followUpCount: 0, nodeId: node.id, dueAt: dueAt.toISOString() },
    };
  }

  // Case 2: Rescheduled after sending a follow-up.
  if (instance.currentState === "FOLLOWED_UP") {
    const dueAt = new Date(Date.now() + resolveIntervalMs(config, instance.followUpCount));
    return {
      nextState: "AWAITING_REPLY",
      nextNodeId: node.id,
      dueAt,
      eventType: "NODE_ENTERED",
      eventPayload: { followUpCount: instance.followUpCount, nodeId: node.id, dueAt: dueAt.toISOString() },
    };
  }

  // Case 3: AWAITING_REPLY — a follow-up is due (triggered by scheduler).
  if (instance.currentState === "AWAITING_REPLY") {
    if (instance.followUpCount >= maxCount) {
      return {
        nextState: "NO_RESPONSE",
        nextNodeId: null,
        completedAt: new Date(),
        dueAt: null,
        eventType: "NODE_COMPLETED",
        eventPayload: { reason: "max_follow_ups_reached", followUpCount: instance.followUpCount },
      };
    }

    const bodyTemplate =
      typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";

    // Try AI-generated follow-up copy; fall back to template-based email.draft().
    const followUpRound = instance.followUpCount + 1;
    const dealDescription = describeDeal(nodeGraph.find((n) => n.type === "NEGOTIATION")?.config);
    const aiDraft = await agent.draftEmail("follow_up", creator, config, {
      round: followUpRound,
      ...(dealDescription ? { dealDescription } : {}),
    });
    const draft = aiDraft ?? await email.draft(creator, bodyTemplate, config);

    // H4: scan the rendered follow-up for a leaked floor/ceiling (band lives on
    // the NEGOTIATION node) before sending. Nothing is allowlisted — follow-ups
    // present no rate. A hit routes to MANUAL_REVIEW.
    const negotiationConfig = nodeGraph.find((n) => n.type === "NEGOTIATION")?.config;
    const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(negotiationConfig ?? {}));
    if (!guard.ok) {
      return followUpBlockedByGuard(guard.hits);
    }

    // FIX-11: reserve-before-send keyed on (instance, follow-up round) so a
    // crash between send and the row write can't double-send this follow-up on
    // a BullMQ retry.
    const { messageId, threadId } = await sendOnce(
      email,
      instance.id,
      creator,
      draft,
      `followup:${instance.id}:${followUpRound}`,
      undefined, // deps — default
      undefined, // recipient — creator
      // Gmail Campaign Labels (§6.3): label the thread from the loaded campaign.
      ctx.campaign?.name,
    );

    const newFollowUpCount = instance.followUpCount + 1;

    return {
      nextState: "FOLLOWED_UP",
      nextNodeId: node.id,
      followUpCount: newFollowUpCount,
      dueAt: null,
      eventType: "FOLLOW_UP_DUE",
      eventPayload: {
        followUpCount: newFollowUpCount,
        messageId,
        threadId,
        aiGenerated: aiDraft !== null,
      },
    };
  }

  throw new Error(
    `FOLLOW_UP executor called in unexpected state: ${instance.currentState}`,
  );
}
