import type { JsonObject } from "../../db/schema.js";
import {
  createDealHandoffOnce,
  listEventsByInstance,
  listMessagesByInstance,
} from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { renderOperatorHandoffEmail } from "./operatorHandoffEmail.js";
import { resolveAgreedFee } from "./agreedFee.js";
import { resolveKnowledgeField, type SourceLabel } from "../knowledgePrecedence.js";
import { resolveBand } from "../band.js";
import { resolveBrandName } from "../campaignContext.js";
import { blockedByMissingBrand } from "./guardEscalation.js";
import { resolveBrandRecipient } from "../../notifications/escalation.js";

// ---------------------------------------------------------------------------
// Operator handoff executor (PLU-70)
// ---------------------------------------------------------------------------
// The post-acceptance path for an execution enrolled with
// postAcceptanceMode = "operator_handoff". It replaces the merged Content Brief
// step entirely — the prototype has proven what it set out to prove (the AI
// closed a real agreement) and the rest of the deal is finished by a human in
// the main Pluvus platform.
//
// What it does, in order:
//   1. Snapshot the agreed terms into DealHandoff (idempotent on instanceId).
//   2. Email the creator a short "looping in our campaign manager" note, CC'ing
//      the campaign's escalation contact so the operator is a real participant
//      in the thread from here on.
//   3. Park the execution in NEEDS_DEAL_FINALIZATION.
//
// What it deliberately does NOT do:
//   - mint a payout token or send the hosted payout form (handoff mode collects
//     no payout information at all),
//   - attach the campaign brief,
//   - mint the Partnership / fee Obligation ledger rows.
//
// Idempotency: every side effect is individually at-most-once — the DealHandoff
// insert is guarded by a UNIQUE instanceId, and the send by sendOnce's reserved
// idempotency key. A BullMQ retry of this step re-runs the whole function and
// changes nothing. The follow-on operator notification is fired by
// runtime.stepInstance AFTER the state commit and is itself idempotent, so
// retrying delivery can never duplicate the transition or the acceptance record.

export async function executeOperatorHandoff(
  ctx: ExecutionContext,
  email: IEmailProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator, campaign } = ctx;
  const config = node.config;

  if (instance.currentState !== "ACCEPTED") {
    throw new Error(
      `Operator handoff expects ACCEPTED state, got ${instance.currentState}`,
    );
  }

  // 1. Resolve the brand for the creator-facing note. Same L4 contract as every
  //    other creator-facing executor: with no resolvable brand name we escalate
  //    for a human to fix the config rather than email the creator "your brand".
  const brandName = resolveBrandName(config, campaign);
  if (brandName === undefined) {
    return blockedByMissingBrand(node.type);
  }

  // 2. Resolve the agreed terms from the same sources the local flow uses.
  const negotiationConfig = nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
  const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });

  // NOTE: unlike executeContentBrief (CRITICAL-3), an absent fee is NOT an
  // escalation here. That rule exists because the merged brief email is
  // contract-forming — it states a dollar figure to the creator — so a missing
  // agreed rate there would mean emailing a fabricated number. This path states
  // no figure to anyone except the operator, who is already the human reviewer,
  // and commission-only campaigns legitimately close with no fee at all. So we
  // record `null` and let the operator see "30% commission".
  const fixedFee = resolveAgreedFee(events, negotiationConfig, config);
  // PLU-82 (§4.3): the finalized terms now resolve through the ONE documented
  // precedence resolver instead of the inline firstString/firstNumber chains. The
  // resolver reuses firstString/firstNumber, so this is byte-identical (invariant
  // #3) — the golden test locks it. Each call passes only the source slots this
  // executor had inline (an omitted slot is undefined = skipped), which reproduces
  // this executor's exact 3-tier deliverables/timeline and 2-tier commission +
  // NS-skipping paymentTerms without a per-executor policy table. `resolvedSources`
  // records the winning-source label per field for the debug event payload (§4.6).
  const resolvedSources: Record<string, SourceLabel> = {};
  const commission = resolveKnowledgeField("commissionRate", {
    workflowConfig: config["commissionRate"],
    negotiationState: negotiationConfig["commissionRate"],
  });
  const commissionRate = commission.value as number | undefined;
  resolvedSources["commissionRate"] = commission.source;
  const deliverablesR = resolveKnowledgeField("deliverables", {
    workflowConfig: config["deliverables"],
    negotiationState: negotiationConfig["deliverables"],
    campaignDefault: campaign?.deliverables,
  });
  const deliverables = deliverablesR.value as string | undefined;
  resolvedSources["deliverables"] = deliverablesR.source;
  const timelineR = resolveKnowledgeField("timeline", {
    workflowConfig: config["timeline"],
    negotiationState: negotiationConfig["timeline"],
    campaignDefault: campaign?.timeline,
  });
  const timeline = timelineR.value as string | undefined;
  resolvedSources["timeline"] = timelineR.source;
  // paymentTerms: WC → CD only (negotiationConfig deliberately NOT passed — the
  // preserved inconsistency, §7 / invariant #3).
  const paymentTermsR = resolveKnowledgeField("paymentTerms", {
    workflowConfig: config["paymentTerms"],
    campaignDefault: campaign?.paymentTerms,
  });
  const paymentTerms = paymentTermsR.value as string | undefined;
  resolvedSources["paymentTerms"] = paymentTermsR.source;

  // The negotiation band the deal closed within, so the brand confirmation email
  // can restate "your range: $X–$Y". Read from the SAME node config the agent
  // negotiated against (accepting either termFloor/termCeiling or minBudget/
  // maxBudget). Absent for an unconfigured band — the email omits the range then.
  const { floor: negotiationFloor, ceiling: negotiationCeiling } =
    resolveBand(negotiationConfig);

  // The campaign perk/reward blurb ("one pair of the Tempo trainer"), for the
  // "Perk" line of the confirmation email. Same config-then-campaign precedence
  // as the other denormalized terms.
  const rewardDescriptionR = resolveKnowledgeField("rewardDescription", {
    workflowConfig: config["rewardDescription"],
    negotiationState: negotiationConfig["rewardDescription"],
    campaignDefault: campaign?.rewardDescription,
  });
  const rewardDescription = rewardDescriptionR.value as string | undefined;
  resolvedSources["rewardDescription"] = rewardDescriptionR.source;

  // The accepting turn's own message — the "acceptance message or event" the
  // snapshot records. Not the thread: the full conversation stays in Message and
  // is read through the existing execution inspector.
  const acceptEvent = [...events]
    .reverse()
    .find((e) => {
      const p = e.payload as Record<string, unknown> | null;
      return typeof p?.["outcome"] === "string" && p["outcome"].toLowerCase() === "accept";
    });
  const acceptanceMessage =
    typeof (acceptEvent?.payload as Record<string, unknown> | null)?.["message"] === "string"
      ? ((acceptEvent!.payload as Record<string, unknown>)["message"] as string)
      : undefined;

  // Thread pointer, so the operator (and the inspector) can find the existing
  // conversation. Best-effort: a missing thread must not block the handoff.
  let threadId: string | undefined;
  try {
    const messages = await listMessagesByInstance(instance.id);
    threadId = [...messages].reverse().find((m) => m.threadId)?.threadId ?? undefined;
  } catch (err) {
    console.error(
      `[operatorHandoff] could not resolve threadId for ${instance.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const acceptedAt = acceptEvent?.occurredAt ?? new Date();

  // 3. Persist the snapshot. Idempotent: a retry returns the existing row.
  await createDealHandoffOnce({
    instanceId: instance.id,
    creatorName: creator.name,
    creatorEmail: creator.email,
    campaignName: campaign?.name ?? null,
    fixedFee: fixedFee ?? null,
    commissionRate: commissionRate ?? null,
    negotiationFloor: negotiationFloor ?? null,
    negotiationCeiling: negotiationCeiling ?? null,
    deliverables: deliverables ?? null,
    timeline: timeline ?? null,
    paymentTerms: paymentTerms ?? null,
    rewardDescription: rewardDescription ?? null,
    acceptanceMessage: acceptanceMessage ?? null,
    threadId: threadId ?? null,
    acceptedAt,
  });

  // 4. Tell the creator a human is taking over, with the operator on CC.
  //
  //    CC only when the campaign has an EXPLICIT notifyEmail. resolveBrandRecipient
  //    otherwise falls through to BRAND_NOTIFY_EMAIL and finally the platform
  //    operator constant — fine for an internal alert nobody else sees, but a CC
  //    is visible to the creator, and putting a fallback address on a brand's
  //    creator-facing email is not ours to do. When it is unset the operator is
  //    still reached: the notification email fires as normal, and any creator
  //    reply is forwarded to them (see notifyOperatorOfHandoffReply).
  const explicitNotifyEmail = campaign?.notifyEmail?.trim();
  const ccOperator = explicitNotifyEmail
    ? resolveBrandRecipient(explicitNotifyEmail)
    : null;

  const draft = renderOperatorHandoffEmail({ creatorName: creator.name, brandName });

  // The note states no fee, commission, floor or ceiling, so there is nothing for
  // the output guard to scan for — unlike every other post-acceptance email.
  await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `deal-handoff:${instance.id}`,
    undefined, // deps — default
    {
      email: creator.email,
      name: creator.name,
      ...(ccOperator ? { cc: [ccOperator] } : {}),
    },
    ctx.campaign?.name, // Gmail Campaign Labels (§6.3)
  );

  // 5. Park. NOT terminal and NOT completed — the run is waiting on a human, and
  //    HANDOFF_COMPLETE is what closes it. nextNodeId is null because no node
  //    owns this state: the operator's "mark completed" action resumes it from a
  //    route, not from the graph.
  return {
    nextState: "NEEDS_DEAL_FINALIZATION",
    nextNodeId: null,
    eventType: "DEAL_HANDOFF_REQUESTED",
    eventPayload: {
      ...(fixedFee !== undefined ? { fixedFee } : {}),
      ...(commissionRate !== undefined ? { commissionRate } : {}),
      acceptedAt: acceptedAt.toISOString(),
      ccOperator: ccOperator ?? null,
      // PLU-82 (§4.6): the winning-source label per finalized term — the "selected
      // source in internal debug context" criterion. Debug metadata only (the
      // observability mapper reads it); never a money/term input.
      resolvedSources,
    } as JsonObject,
  };
}
