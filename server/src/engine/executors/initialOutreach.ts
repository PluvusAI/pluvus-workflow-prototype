import type { ExecutionContext, NodeResult, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { describeDeal, dealShape } from "../dealDescription.js";
import {
  scanOutboundDraft,
  guardConstraintsFromConfig,
  maskGuardHits,
  type GuardHit,
} from "../guards/outputGuard.js";
import { mergeCampaignFallback } from "../campaignContext.js";
import { missingRequiredValues } from "../outreachVariables.js";

// Manual Initial Outreach: the operator can write the first email by hand in the
// builder ("manual" mode) instead of having the AI draft it ("ai" mode). The
// mode lives on the node config. An ABSENT field means the node config was saved
// before this feature — those already-published versions keep doing exactly what
// they did (AI-first), so absent → "ai". New nodes default to "manual" via the
// builder / templates, so the product ships manual-first without silently
// changing what an already-launched campaign sends.
type OutreachMode = "manual" | "ai";
function resolveOutreachMode(config: Record<string, unknown>): OutreachMode {
  const m = config["outreachMode"];
  return m === "manual" || m === "ai" ? m : "ai"; // absent → legacy AI behavior
}

// H4: the output guard is documented as a MANDATORY net before ANY AI-generated
// email is sent, but outreach/follow-up sent unguarded. Outreach quotes NO money
// (rates are negotiated on reply), so any floor/ceiling number in the body is a
// leak. On a hit we route to MANUAL_REVIEW and do NOT send — a human reviews.
function outreachBlockedByGuard(hits: GuardHit[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "OUTREACH_DRAFTED",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "output_guard_blocked",
      // EASY-S2: mask the band VALUE — record only which KIND leaked.
      leaks: maskGuardHits(hits),
    },
  };
}

// PLU-117 §3 / AC10: a REQUIRED placeholder the template uses resolved empty for
// THIS creator (e.g. a creator row with a blank name). We do NOT mail a broken
// sentence or invent a value — this creator's send is blocked and routed to
// MANUAL_REVIEW with the missing variable names recorded, so a human can fix the
// creator record (or the template). Per-creator: other creators still send.
function outreachBlockedByMissingRequired(missing: string[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "OUTREACH_DRAFTED",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "outreach_missing_required_value",
      missingVariables: missing,
    },
  };
}

export async function executeInitialOutreach(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;

  if (instance.currentState !== "ENROLLED") {
    throw new Error(
      `INITIAL_OUTREACH expects ENROLLED state, got ${instance.currentState}`,
    );
  }

  // H5: fill missing brand context from the parent campaign (node config wins).
  const config = mergeCampaignFallback(node.config, ctx.campaign);

  // Describe the deal structure (fixed fee / commission / both) from the
  // NEGOTIATION node so the outreach email explains the real offer instead of
  // vague filler. No dollar figures — those are negotiated on reply.
  const negotiationConfig = nodeGraph.find((n) => n.type === "NEGOTIATION")?.config;
  const dealDescription = describeDeal(negotiationConfig);

  // PLU-117 §2: stamp the campaign name + deal-shape placeholder sources onto the
  // render config so {{campaignName}}, {{collaborationType}}, {{offerSummary}}
  // resolve deterministically. These are NOT plain brand fields (campaignName
  // comes off the campaign row; the other two off the NEGOTIATION deal shape), so
  // the executor is the one place that has both in hand. Node config still wins —
  // we only fill a key the operator hasn't set.
  const shape = dealShape(negotiationConfig);
  const stampIfUnset = (key: string, value: string | undefined): void => {
    if (value && typeof config[key] !== "string") config[key] = value;
  };
  stampIfUnset("campaignName", ctx.campaign?.name);
  stampIfUnset("collaborationType", shape?.type);
  stampIfUnset("offerSummary", shape?.summary);

  const bodyTemplate = typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";
  const subjectTemplate = typeof config["subjectTemplate"] === "string" ? config["subjectTemplate"] : "";

  // Manual vs AI. In "manual" mode the operator's written subject/body ARE the
  // email — we skip the AI entirely and render their copy through the shared
  // variable resolver (email.draft → resolveOutreachTemplate substitutes
  // {{creatorName}} etc. and strips any unknown token). In "ai" mode (and for
  // legacy nodes with no mode field) we keep today's behavior: AI first, written
  // template as the fallback.
  const mode = resolveOutreachMode(config);
  let draft: EmailDraft;
  let aiGenerated: boolean;
  if (mode === "manual") {
    // PLU-117 §3 / AC10: block (don't send) when a REQUIRED placeholder the
    // operator's template uses has no value for THIS creator. We check BEFORE
    // rendering so we never mail a broken sentence or a silent blank. Only the
    // manual template is subject to this — the AI path builds its own copy.
    const missing = missingRequiredValues(subjectTemplate, bodyTemplate, creator, config);
    if (missing.length > 0) {
      return outreachBlockedByMissingRequired(missing);
    }
    draft = await email.draft(creator, bodyTemplate, config);
    aiGenerated = false;
  } else {
    const aiDraft = await agent.draftEmail("initial_outreach", creator, config, {
      ...(dealDescription ? { dealDescription } : {}),
    });
    draft = aiDraft ?? await email.draft(creator, bodyTemplate, config);
    aiGenerated = aiDraft !== null;
  }

  // H4: scan the rendered draft for a leaked floor/ceiling before sending. The
  // band lives on the NEGOTIATION node; outreach presents no rate, so nothing is
  // allowlisted. A hit routes to MANUAL_REVIEW instead of emailing the creator.
  const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(negotiationConfig ?? {}));
  if (!guard.ok) {
    return outreachBlockedByGuard(guard.hits);
  }

  // FIX-11: reserve-before-send so a crash between send and the row write can't
  // double-send the outreach on a BullMQ retry. One outreach per instance.
  const { messageId, threadId } = await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `outreach:${instance.id}`,
    undefined, // deps — default
    undefined, // recipient — creator (not a brand-outbound send)
    // Gmail Campaign Labels (§6.3): pass the already-loaded campaign name so the
    // thread is labeled Pluvus/<name>. Free field read on ctx.campaign — no query.
    ctx.campaign?.name,
  );

  const nextNode = nodeGraph.find((n) => n.order === node.order + 1) ?? null;

  return {
    nextState: "OUTREACH_SENT",
    nextNodeId: nextNode?.id ?? null,
    eventType: "OUTREACH_DRAFTED",
    eventPayload: {
      subject: draft.subject,
      messageId,
      threadId,
      // aiGenerated=false marks an operator-written outreach so history and the
      // inspector can distinguish it from an AI draft. outreachMode records which
      // path produced this email for observability.
      aiGenerated,
      outreachMode: mode,
    },
  };
}
