// ---------------------------------------------------------------------------
// Node defaults + palette catalog (Phase 17).
// ---------------------------------------------------------------------------
// When a user drags a NEW node from the palette we need (a) a fresh unique id
// and (b) a sensible starting config so the node isn't gratuitously invalid.
// These defaults mirror the shapes used in the server templates.
// ---------------------------------------------------------------------------

import type { NodeType, NodeConfig } from "../api/builderTypes";
import { nodeLabel, nodeColor, nodeDescription } from "../components/builder/nodeMeta";

// Types a user may add from the palette. IMPORT_CREATOR_LIST is an implicit
// entry concept (creators enroll into the first node) and END is legacy, so the
// palette exposes the meaningful building blocks. Terminal nodes are addable so
// users can build a complete pipeline from scratch. REWARD_SETUP and PAYMENT_INFO
// are deprecated (merged into CONTENT_BRIEF, which now sends the finalized offer +
// payout link + brief in one email) — kept as valid types so legacy published
// graphs still render, but removed from the palette so new drafts don't add them.
export const PALETTE_NODE_TYPES: NodeType[] = [
  "INITIAL_OUTREACH",
  "FOLLOW_UP",
  "REPLY_DETECTION",
  "NEGOTIATION",
  "CONTENT_BRIEF",
];

export interface PaletteItem {
  type: NodeType;
  label: string;
  color: string;
  description: string;
}

export function paletteItems(): PaletteItem[] {
  return PALETTE_NODE_TYPES.map((type) => ({
    type,
    label: nodeLabel(type),
    color: nodeColor(type),
    description: nodeDescription(type),
  }));
}

// Default config for a freshly added node. Kept intentionally minimal — required
// fields where a sensible default exists are pre-filled; genuinely user-specific
// required fields (e.g. the Content Brief PDF) are left blank so validation nudges
// the user to fill them in.
export function defaultConfigFor(type: NodeType): NodeConfig {
  switch (type) {
    case "INITIAL_OUTREACH":
      // Ships manual-first: the operator writes the first email and it's sent
      // as-is. The starter copy is a genuine, sendable first-touch (no price —
      // rates are negotiated on reply) rather than a placeholder.
      return {
        outreachMode: "manual",
        subjectTemplate: "Partnership opportunity with {{brandName}}",
        bodyTemplate:
          "Hi {{creatorName}},\n\nI'm reaching out from {{brandName}} — we've been enjoying your {{platform}} content and think there could be a great fit for a partnership.\n\nWould you be open to hearing the details? Happy to share what we have in mind.\n\nBest,\n{{senderName}}",
      };
    case "FOLLOW_UP":
      return {
        intervals: [3, 5],
        intervalUnit: "days",
        maxCount: 2,
        bodyTemplate:
          "Hi {{creatorName}},\n\nJust following up on our earlier message. Would love to connect!\n\nBest,\n{{brandName}} Team",
        // No stopOnReply: follow-ups always stop on reply (hardcoded in runtime).
      };
    case "REPLY_DETECTION":
      // No configurable fields — the low-confidence threshold (0.50) and the
      // route-to-Manual-Review behavior are fixed engine constants, never read
      // from config. (Former lowConfidenceThreshold / manualReviewOnLowConfidence
      // defaults were dead.)
      return {};
    case "NEGOTIATION":
      return {
        minBudget: 0,
        maxBudget: 500,
        maxRounds: 3,
        // No approvalMode: the engine always auto-accepts within budget; the old
        // "manual" default promised a human gate that was never implemented.
      };
    case "REWARD_SETUP":
    case "PAYMENT_INFO":
    case "CONTENT_BRIEF":
    case "END":
    case "IMPORT_CREATOR_LIST":
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Fresh node id — stable, collision-resistant, human-readable-ish.
// ---------------------------------------------------------------------------
// Not cryptographic; just unique within a graph. We include the type slug and a
// short random suffix. Avoids Math.random reliance on any single call by mixing
// a monotonic counter with a random tail.
let _seq = 0;
export function freshNodeId(type: NodeType): string {
  _seq += 1;
  const slug = type.toLowerCase().replace(/_/g, "-");
  const rand = Math.random().toString(36).slice(2, 7);
  return `node-${slug}-${_seq}-${rand}`;
}
