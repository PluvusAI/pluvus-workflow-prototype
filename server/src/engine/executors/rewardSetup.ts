import { listEventsByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { resolveAgreedFee } from "./agreedFee.js";
import {
  agreedFeeSource,
  resolveKnowledgeField,
  type SourceLabel,
} from "../knowledgePrecedence.js";
import { scanOutboundDraft, guardConstraintsFromConfig } from "../guards/outputGuard.js";
import { sendOnce } from "./idempotentSend.js";
import { blockedByGuard, blockedByMissingBrand, blockedBySnapshotIntegrity } from "./guardEscalation.js";
import { renderRewardConfirmationEmail } from "./rewardEmail.js";
import { resolveBrandName } from "../campaignContext.js";
import { loadPinnedTermsSnapshotForExecutor } from "../../db/campaignSnapshots.js";
import { resolveEffectiveNegotiationConfig } from "../effectiveTerms.js";

// ---------------------------------------------------------------------------
// Reward Setup executor
// ---------------------------------------------------------------------------
// Runs immediately after a successful negotiation (state ACCEPTED). It
// finalizes the commercial agreement:
//   1. Resolves the final agreed fee (the rate the negotiation closed on),
//      the commission %, and the deliverables — all from the node config +
//      the persisted NEGOTIATION_TURN history.
//   2. Sends the "Campaign Agreement Confirmation" email asking the creator to
//      reply "I Agree".
//   3. Transitions ACCEPTED → REWARD_PENDING and WAITS there.
//
// It does NOT negotiate. The creator's agreement reply is handled separately by
// executeRewardReply (driven by the inbound-email worker) which advances the
// instance to REWARD_CONFIRMED on a positive reply.

// resolveAgreedFee (plus firstNumber/firstString) now live in ./agreedFee.ts so
// the Content Brief executor can share the finalized-terms resolution. Re-exported
// here to keep existing importers (rewardReply, paymentReply, tests) unchanged.
export { resolveAgreedFee };

export async function executeRewardSetup(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;

  // PLU-137/138: this email is contract-forming, so its PUBLIC terms must come
  // from the pinned CampaignTermsSnapshot, not the stale nodeGraph config —
  // same discipline as contentBrief.ts. No-snapshot (legacy) journey overlays
  // nothing → the existing config chain runs unchanged.
  const pinnedTerms = await loadPinnedTermsSnapshotForExecutor(instance, ctx.campaign?.id);
  if (pinnedTerms.integrityFailure) {
    return blockedBySnapshotIntegrity(node.type, pinnedTerms.integrityFailure.reason);
  }
  const config = pinnedTerms.terms
    ? resolveEffectiveNegotiationConfig({ termsSnapshot: pinnedTerms.terms, config: node.config }).config
    : node.config;

  if (instance.currentState !== "ACCEPTED") {
    throw new Error(
      `REWARD_SETUP expects ACCEPTED state, got ${instance.currentState}`,
    );
  }

  // The brand's negotiation commission is stamped onto THIS node's config at
  // save/publish (stampRewardFromNegotiation in routes/workflows.ts), so the
  // reward node's own config is the finalized value the builder also displays.
  // We read the NEGOTIATION node as a defensive fallback for versions published
  // before the stamp (or instances created directly, e.g. in tests/harnesses).
  const negotiationConfig =
    nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};

  // Assemble the finalized terms from persisted negotiation history + config.
  const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const agreedFee = resolveAgreedFee(events, negotiationConfig, config);
  // PLU-82 (§4.3): finalized terms resolve through the ONE documented precedence
  // resolver instead of the inline firstString/firstNumber chains — byte-identical
  // (invariant #3), golden-test locked. This executor's inline chains are 2-tier
  // (config → negotiationConfig, NO campaign fallback), so campaignDefault is not
  // passed (undefined = skipped) and the resolved value/label match the inline
  // read exactly. `resolvedSources` records the winning label per field (§4.6).
  const resolvedSources: Record<string, SourceLabel> = {};
  resolvedSources["fixedFee"] = agreedFeeSource(agreedFee);
  const commission = resolveKnowledgeField("commissionRate", {
    workflowConfig: config["commissionRate"],
    negotiationState: negotiationConfig["commissionRate"],
  });
  const commissionRate = commission.value as number | undefined;
  resolvedSources["commissionRate"] = commission.source;
  // Deliverables are a campaign-level field stamped into every node's config
  // (see campaigns.ts / restampBrand). Prefer this node's stamped copy, then the
  // negotiation node's value.
  const deliverablesR = resolveKnowledgeField("deliverables", {
    workflowConfig: config["deliverables"],
    negotiationState: negotiationConfig["deliverables"],
  });
  const deliverables = deliverablesR.value as string | undefined;
  resolvedSources["deliverables"] = deliverablesR.source;
  // Timeline is likewise a campaign-level field stamped into node config; state
  // it in the confirmation only when present.
  const timelineR = resolveKnowledgeField("timeline", {
    workflowConfig: config["timeline"],
    negotiationState: negotiationConfig["timeline"],
  });
  const timeline = timelineR.value as string | undefined;
  resolvedSources["timeline"] = timelineR.source;
  // Product/sample reward blurb — also a campaign-level stamped field; rendered
  // as its own bullet in the confirmation only when present.
  const rewardDescriptionR = resolveKnowledgeField("rewardDescription", {
    workflowConfig: config["rewardDescription"],
    negotiationState: negotiationConfig["rewardDescription"],
  });
  const rewardDescription = rewardDescriptionR.value as string | undefined;
  resolvedSources["rewardDescription"] = rewardDescriptionR.source;

  // Draft the "Campaign Agreement Confirmation" email. The confirmation copy is
  // a fixed template (renderRewardConfirmationEmail); we still offer the AI draft
  // path (reward_confirmation purpose) so a real provider can enrich the copy,
  // but the template is the authoritative fallback — unlike the other executors
  // this never degrades to a generic body, since the confirmation must always
  // state the terms and ask for "I Agree".
  // L4: resolve the brand from config → parent campaign. If neither has it, fail
  // loud to MANUAL_REVIEW rather than email the creator "your brand".
  const brandName = resolveBrandName(config, ctx.campaign);
  if (brandName === undefined) {
    // L4 (#14): a genuinely mis-stamped instance with no resolvable brand name is
    // a config problem for a human to fix — route to MANUAL_REVIEW (clean one-way
    // handoff) rather than email the creator "your brand". runtime emails the
    // brand an FYI keyed on missing_brand_name.
    return blockedByMissingBrand(ctx.node.type);
  }
  // CRITICAL-3: the reward-confirmation email is contract-forming — it states the
  // agreed fee and asks the creator to reply "I Agree". If no genuine agreed rate
  // was recorded (resolveAgreedFee now returns undefined instead of falling back
  // to the internal ceiling), escalate to a human rather than confirm an invented
  // number. Code must never fabricate a fee (PRINCIPLES.md).
  if (agreedFee === undefined) {
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "MANUAL_REVIEW_FLAGGED",
      eventPayload: { outcome: "ESCALATE", reason: "no_agreed_fee", node: node.type },
    };
  }
  const senderName =
    typeof config["senderName"] === "string" ? (config["senderName"] as string) : brandName;
  const templateDraft = renderRewardConfirmationEmail({
    creatorName: creator.name,
    brandName,
    senderName,
    fixedFee: agreedFee,
    commissionRate,
    deliverables,
    timeline,
    rewardDescription,
  });
  const aiDraft = await agent.draftEmail("reward_confirmation", creator, config, {
    ...(agreedFee !== undefined ? { proposedTerms: { rate: agreedFee } } : {}),
  });
  const draft = aiDraft ?? templateDraft;

  // FIX-4 parity: scan the rendered draft for a leaked floor/ceiling before
  // sending. The agreed fee is the number we mean to present, so it's allowlisted.
  const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, agreedFee));
  if (!guard.ok) {
    return blockedByGuard(instance.negotiationRound, guard.hits);
  }

  // Idempotent send keyed on (instance, reward_confirmation) — a re-run of the
  // ACCEPTED auto-chain (e.g. a BullMQ retry) won't double-send the email.
  await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `reward:confirmation:${instance.id}`,
    undefined, // deps — default
    undefined, // recipient — creator
    ctx.campaign?.name, // Gmail Campaign Labels (§6.3)
  );

  // Enter the waiting state. Stay on THIS node so an inbound reply is handled by
  // the reward-reply path, and expose the normal output connection (nextNodeId
  // points at whatever node follows — Payment Info, once it exists) for later.
  return {
    nextState: "REWARD_PENDING",
    nextNodeId: node.id,
    eventType: "REWARD_SETUP_SENT",
    eventPayload: {
      ...(agreedFee !== undefined ? { fixedFee: agreedFee } : {}),
      ...(commissionRate !== undefined ? { commission: commissionRate } : {}),
      ...(deliverables ? { deliverables } : {}),
      // PLU-82 (§4.6): winning-source label per finalized term. Debug metadata only.
      resolvedSources,
    },
  };
}
