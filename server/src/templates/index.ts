// ---------------------------------------------------------------------------
// Workflow templates — Phase 10
// ---------------------------------------------------------------------------
// Hardcoded preset node graphs for the three campaign types.
// Each template produces a NodeSnapshot[] that becomes the initial draftNodes
// on the Workflow record. On publish, draftNodes becomes an immutable
// WorkflowVersion.nodeGraph snapshot.

import type { NodeSnapshot } from "../engine/types.js";

export type TemplateKey = "affiliate" | "hybrid" | "fixed_fee";

export interface WorkflowTemplate {
  key: TemplateKey;
  name: string;
  description: string;
  nodes: NodeSnapshot[];
}

// ---------------------------------------------------------------------------
// Affiliate Campaign
// ---------------------------------------------------------------------------
// Performance-based: brand pays only on conversions.
// Standard outreach → follow-up → reply detection → negotiation pipeline.

const affiliateNodes: NodeSnapshot[] = [
  {
    id: "node-outreach",
    type: "INITIAL_OUTREACH",
    order: 0,
    config: {
      // Manual-first: the operator's copy is the email sent to each creator.
      outreachMode: "manual",
      subjectTemplate: "Partnership opportunity with {{brandName}}",
      bodyTemplate:
        "Hi {{creatorName}},\n\nWe love your content and think you'd be a great fit for our affiliate program. You'd earn a commission on every sale driven by your unique link.\n\nInterested in learning more?\n\nBest,\n{{brandName}} Team",
    },
  },
  {
    id: "node-followup",
    type: "FOLLOW_UP",
    order: 1,
    config: {
      intervals: [3, 5],
      intervalUnit: "days",
      maxCount: 2,
      bodyTemplate:
        "Hi {{creatorName}},\n\nJust following up on our earlier message about the affiliate partnership. Would love to connect!\n\nBest,\n{{brandName}} Team",
      stopOnReply: true,
    },
  },
  {
    id: "node-reply-detection",
    type: "REPLY_DETECTION",
    order: 2,
    config: {
      // M4: kept in sync with the effective gate (LOW_CONFIDENCE_THRESHOLD =
      // 0.50 in replyDetection). This value is currently informational — the
      // executor uses the hardcoded 0.50 constant, not this config — so it must
      // not imply a 0.70 gate that never runs.
      lowConfidenceThreshold: 0.5,
      manualReviewOnLowConfidence: true,
    },
  },
  {
    id: "node-negotiation",
    type: "NEGOTIATION",
    order: 3,
    config: {
      // V1 #1 labels: minBudget is "Preferred Budget" (the rate the brand would
      // ideally close at) and maxBudget is "Maximum Budget" (the walk-away cap)
      // in the builder UI. Field names kept for config compatibility.
      // HARD-N3: this is a fee band with a POSITIVE ceiling, so the floor must be
      // > 0 too. Previously minBudget was 0, which — combined with open-at-floor
      // (position 0.0) — computed a recommended opening offer of $0 for a bare
      // "I'm interested" (the $0-offer bug). Opening at the floor (V1 #2, below)
      // is only safe because every template keeps minBudget > 0.
      minBudget: 50,
      maxBudget: 500,
      maxRounds: 3,
      approvalMode: "auto",
      commissionRate: 15,
      // V1 #2: open at the FLOOR (preferred budget) and concede UP. Threaded
      // through buildNegotiationRequest → CampaignConstraints.recommendedOfferPosition
      // and clamped to [0,1] in the agent; 0.0 = floor. Requires minBudget > 0
      // (HARD-N3 guard above) so the opening offer can never be $0.
      recommendedOfferPosition: 0.0,
      // Phase C (#12): merchant tolerance ABOVE maxBudget, as a percentage. 0 =
      // zero tolerance (escalate the moment an ask exceeds the ceiling — today's
      // behavior). E.g. 10 means an ask up to ceiling*1.10 is countered AT the
      // ceiling (never above) rather than escalated; anything higher still
      // escalates to a human. Only the fixed fee has tolerance in V1.
      overCeilingTolerance: 0,
    },
  },
  {
    id: "node-content-brief",
    type: "CONTENT_BRIEF",
    order: 4,
    // The merged post-negotiation node: on ACCEPTED it sends ONE email with the
    // finalized offer (commission read from the NEGOTIATION node, deliverables
    // stamped from the campaign), a secure payout-form link, and the campaign
    // brief PDF, then waits for the creator to submit the form. The brand uploads
    // the Campaign Brief PDF (briefFileRef) and optionally sets a referral link +
    // creator notes in the builder before launch.
    config: {},
  },
];

// ---------------------------------------------------------------------------
// Hybrid Campaign
// ---------------------------------------------------------------------------
// Mix of fixed fee + performance bonus. Suitable for mid-tier creators.

const hybridNodes: NodeSnapshot[] = [
  {
    id: "node-outreach",
    type: "INITIAL_OUTREACH",
    order: 0,
    config: {
      // Manual-first: the operator's copy is the email sent to each creator.
      outreachMode: "manual",
      subjectTemplate: "Paid partnership + affiliate opportunity",
      bodyTemplate:
        "Hi {{creatorName}},\n\nWe'd love to work with you on a hybrid deal — a base fee for the content plus an affiliate commission on sales. It's the best of both worlds.\n\nOpen to a quick chat?\n\nBest,\n{{brandName}} Team",
    },
  },
  {
    id: "node-followup",
    type: "FOLLOW_UP",
    order: 1,
    config: {
      intervals: [2, 4],
      intervalUnit: "days",
      maxCount: 2,
      bodyTemplate:
        "Hi {{creatorName}},\n\nWanted to follow up on our hybrid partnership proposal. We have budget flexibility for the right fit.\n\nBest,\n{{brandName}} Team",
      stopOnReply: true,
    },
  },
  {
    id: "node-reply-detection",
    type: "REPLY_DETECTION",
    order: 2,
    config: {
      // M4: kept in sync with the effective gate (LOW_CONFIDENCE_THRESHOLD =
      // 0.50 in replyDetection). This value is currently informational — the
      // executor uses the hardcoded 0.50 constant, not this config — so it must
      // not imply a 0.70 gate that never runs.
      lowConfidenceThreshold: 0.5,
      manualReviewOnLowConfidence: true,
    },
  },
  {
    id: "node-negotiation",
    type: "NEGOTIATION",
    order: 3,
    config: {
      minBudget: 200,
      maxBudget: 2000,
      maxRounds: 4,
      approvalMode: "auto",
      commissionRate: 10,
      // V1 #2: open at the floor (preferred budget), concede up. minBudget > 0
      // guards the $0-offer regression (HARD-N3). See the first template's note.
      recommendedOfferPosition: 0.0,
      // Phase C (#12): tolerance % above maxBudget; 0 = escalate the moment an ask
      // exceeds the ceiling (today's behavior). See the first template's note.
      overCeilingTolerance: 0,
    },
  },
  {
    id: "node-content-brief",
    type: "CONTENT_BRIEF",
    order: 4,
    // The merged post-negotiation node: sends the finalized offer + secure payout
    // link + campaign brief PDF in one email, then waits for the payout form.
    // Commission is read at runtime from the NEGOTIATION node; deliverables from
    // the campaign. The brand uploads the Campaign Brief PDF (briefFileRef) and
    // optionally sets a referral link + creator notes in the builder before launch.
    config: {},
  },
];

// ---------------------------------------------------------------------------
// Fixed Fee Campaign
// ---------------------------------------------------------------------------
// Flat payment for content. No performance component.
// Simpler negotiation: just agree on the price.

const fixedFeeNodes: NodeSnapshot[] = [
  {
    id: "node-outreach",
    type: "INITIAL_OUTREACH",
    order: 0,
    config: {
      // Manual-first: the operator's copy is the email sent to each creator.
      outreachMode: "manual",
      subjectTemplate: "Paid collaboration with {{brandName}}",
      bodyTemplate:
        "Hi {{creatorName}},\n\nWe're looking for creators to partner with on a paid collaboration — one dedicated post in exchange for a flat fee. No strings attached.\n\nInterested?\n\nBest,\n{{brandName}} Team",
    },
  },
  {
    id: "node-followup",
    type: "FOLLOW_UP",
    order: 1,
    config: {
      intervals: [3, 7],
      intervalUnit: "days",
      maxCount: 2,
      bodyTemplate:
        "Hi {{creatorName}},\n\nFollowing up on our paid collaboration offer. We have dedicated budget set aside for this campaign.\n\nBest,\n{{brandName}} Team",
      stopOnReply: true,
    },
  },
  {
    id: "node-reply-detection",
    type: "REPLY_DETECTION",
    order: 2,
    config: {
      // M4: kept in sync with the effective gate (LOW_CONFIDENCE_THRESHOLD =
      // 0.50 in replyDetection). This value is currently informational — the
      // executor uses the hardcoded 0.50 constant, not this config — so it must
      // not imply a 0.70 gate that never runs.
      lowConfidenceThreshold: 0.5,
      manualReviewOnLowConfidence: true,
    },
  },
  {
    id: "node-negotiation",
    type: "NEGOTIATION",
    order: 3,
    config: {
      minBudget: 500,
      maxBudget: 5000,
      maxRounds: 3,
      approvalMode: "manual",
      // V1 #2: open at the floor (preferred budget), concede up. minBudget > 0
      // guards the $0-offer regression (HARD-N3). See the first template's note.
      recommendedOfferPosition: 0.0,
      // Phase C (#12): tolerance % above maxBudget; 0 = escalate the moment an ask
      // exceeds the ceiling (today's behavior). See the first template's note.
      overCeilingTolerance: 0,
    },
  },
  {
    id: "node-content-brief",
    type: "CONTENT_BRIEF",
    order: 4,
    // The merged post-negotiation node: sends the finalized offer + secure payout
    // link + campaign brief PDF in one email, then waits for the payout form.
    // Fixed-fee campaign: no commission component. The brand uploads the Campaign
    // Brief PDF (briefFileRef) and optionally sets a referral link + creator notes
    // in the builder before launch.
    config: {},
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const WORKFLOW_TEMPLATES: Record<TemplateKey, WorkflowTemplate> = {
  affiliate: {
    key: "affiliate",
    name: "Affiliate Campaign",
    description: "Performance-based. Creators earn commission on conversions. Zero upfront cost.",
    nodes: affiliateNodes,
  },
  hybrid: {
    key: "hybrid",
    name: "Hybrid Campaign",
    description: "Base fee + affiliate commission. Best for mid-tier creators who want guaranteed payment.",
    nodes: hybridNodes,
  },
  fixed_fee: {
    key: "fixed_fee",
    name: "Fixed Fee Campaign",
    description: "Flat payment for deliverables. Simple, predictable, no performance tracking needed.",
    nodes: fixedFeeNodes,
  },
};

export function getTemplate(key: string): WorkflowTemplate | null {
  return WORKFLOW_TEMPLATES[key as TemplateKey] ?? null;
}

/** Validate a nodeGraph array — same rules as publish. */
export function validateNodeGraph(nodes: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(nodes)) {
    return { valid: false, errors: ["nodeGraph must be an array"] };
  }
  if (nodes.length === 0) {
    return { valid: false, errors: ["workflow must have at least one node"] };
  }
  const validTypes = new Set([
    "IMPORT_CREATOR_LIST",
    "INITIAL_OUTREACH",
    "FOLLOW_UP",
    "REPLY_DETECTION",
    "NEGOTIATION",
    // REWARD_SETUP finalizes the agreement; PAYMENT_INFO follows it to collect
    // payout details; CONTENT_BRIEF follows that to send the campaign brief and is
    // the current terminal node. END is still accepted so workflows published
    // before these changes remain valid.
    "REWARD_SETUP",
    "PAYMENT_INFO",
    "CONTENT_BRIEF",
    "END",
  ]);
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Record<string, unknown>;
    if (!n || typeof n !== "object") {
      errors.push(`node[${i}] is not an object`);
      continue;
    }
    if (typeof n["id"] !== "string" || !n["id"]) {
      errors.push(`node[${i}].id is required`);
    } else if (seenIds.has(n["id"] as string)) {
      errors.push(`node[${i}].id '${n["id"]}' is duplicate`);
    } else {
      seenIds.add(n["id"] as string);
    }
    if (typeof n["type"] !== "string" || !validTypes.has(n["type"] as string)) {
      errors.push(`node[${i}].type '${n["type"]}' is invalid`);
    }
    if (typeof n["order"] !== "number") {
      errors.push(`node[${i}].order must be a number`);
    } else if (seenOrders.has(n["order"] as number)) {
      errors.push(`node[${i}].order ${n["order"]} is duplicate`);
    } else {
      seenOrders.add(n["order"] as number);
    }
  }

  // Must have INITIAL_OUTREACH and END
  const types = nodes
    .filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null)
    .map((n) => n["type"] as string);
  if (!types.includes("INITIAL_OUTREACH")) {
    errors.push("workflow must include an INITIAL_OUTREACH node");
  }
  // The workflow must end in a terminal node: CONTENT_BRIEF (current merged flow),
  // REWARD_SETUP (legacy Reward Setup flow), or END (legacy, pre-Reward-Setup).
  if (
    !types.includes("CONTENT_BRIEF") &&
    !types.includes("REWARD_SETUP") &&
    !types.includes("END")
  ) {
    errors.push("workflow must include a CONTENT_BRIEF node");
  }

  // Content Brief requires an uploaded Campaign Brief PDF (briefFileRef). The
  // referral link and creator notes are optional. Only enforced when the workflow
  // actually contains a CONTENT_BRIEF node, so legacy graphs stay valid.
  const contentBriefNode = nodes.find(
    (n): n is Record<string, unknown> =>
      typeof n === "object" && n !== null && (n as { type?: unknown })["type"] === "CONTENT_BRIEF",
  );
  if (contentBriefNode) {
    const cfg = contentBriefNode["config"];
    const ref =
      cfg && typeof cfg === "object"
        ? (cfg as Record<string, unknown>)["briefFileRef"]
        : undefined;
    if (typeof ref !== "string" || !ref.trim()) {
      errors.push("Content Brief node requires an uploaded Campaign Brief PDF");
    }
  }

  return { valid: errors.length === 0, errors };
}
