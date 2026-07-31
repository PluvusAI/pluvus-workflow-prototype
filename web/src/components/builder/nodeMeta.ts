// ---------------------------------------------------------------------------
// Node presentation metadata (Phase B) — single source of truth for how each
// node TYPE renders: label, icon, accent colour, one-line summary, config
// chips, validity hint, and the execution state it maps to.
//
// Pure presentation derived from the existing DraftNode.config shapes. No data
// is mutated and no config field names change — this only READS config.
// ---------------------------------------------------------------------------
import type { ComponentType } from "react";
import {
  Mail,
  Bell,
  Bot,
  MessagesSquare,
  Handshake,
  CreditCard,
  FileText,
  CheckCircle2,
  Users,
  Diamond,
  type LucideProps,
} from "lucide-react";
import type { DraftNode, NodeType } from "../../api/builderTypes";
import { colors } from "../../theme";

export const NODE_LABEL: Record<NodeType, string> = {
  INITIAL_OUTREACH: "Initial Outreach",
  FOLLOW_UP: "Follow-Up",
  REPLY_DETECTION: "Reply Detection",
  NEGOTIATION: "Negotiation",
  REWARD_SETUP: "Reward Setup",
  PAYMENT_INFO: "Payment Info",
  CONTENT_BRIEF: "Content Brief",
  END: "End",
  IMPORT_CREATOR_LIST: "Import Creators",
};

// Aesthetic geometric icons (lucide) — replaces the old pictographic emoji so
// the canvas nodes read as an intentional icon set, not stock emoji.
type IconComponent = ComponentType<LucideProps>;

export const NODE_ICON_COMPONENT: Record<NodeType, IconComponent> = {
  INITIAL_OUTREACH: Mail,
  FOLLOW_UP: Bell,
  REPLY_DETECTION: Bot,
  NEGOTIATION: MessagesSquare,
  REWARD_SETUP: Handshake,
  PAYMENT_INFO: CreditCard,
  CONTENT_BRIEF: FileText,
  END: CheckCircle2,
  IMPORT_CREATOR_LIST: Users,
};

export function nodeIconComponent(type: string): IconComponent {
  return NODE_ICON_COMPONENT[type as NodeType] ?? Diamond;
}

export const NODE_COLOR: Record<NodeType, string> = {
  INITIAL_OUTREACH: "#8b96f8",
  FOLLOW_UP: "#a78bfa",
  REPLY_DETECTION: "#57d9a3",
  NEGOTIATION: "#d9a03f",
  REWARD_SETUP: "#2eb67d",
  PAYMENT_INFO: "#27a06c",
  CONTENT_BRIEF: "#34b378",
  END: "#3ecf8e",
  IMPORT_CREATOR_LIST: "#6a7080",
};

// Plain-English description of what each node does (node tooltips / a11y).
export const NODE_DESCRIPTION: Record<NodeType, string> = {
  IMPORT_CREATOR_LIST: "Entry point — creators enrolled into the campaign land here.",
  INITIAL_OUTREACH: "The first email sent to each creator.",
  FOLLOW_UP: "Automated follow-up nudges sent at set intervals until a reply.",
  REPLY_DETECTION: "AI classifies each reply (positive, negative, question, opt-out).",
  NEGOTIATION: "AI negotiates terms within your budget, escalating when needed.",
  REWARD_SETUP:
    "Finalizes the agreement: confirms fee, commission & deliverables, and emails the creator to confirm.",
  PAYMENT_INFO:
    "Collects the creator's payout details via a secure hosted form, then resumes the workflow.",
  CONTENT_BRIEF:
    "After a successful negotiation, sends one email with the finalized offer, a secure payout link, and the campaign brief PDF, then waits for the creator to submit their payout details.",
  END: "Terminal node — marks the creator's journey complete.",
};

export function nodeLabel(type: string): string {
  return NODE_LABEL[type as NodeType] ?? type;
}
export function nodeColor(type: string): string {
  return NODE_COLOR[type as NodeType] ?? colors.textMuted;
}
export function nodeDescription(type: string): string {
  return NODE_DESCRIPTION[type as NodeType] ?? "";
}

// One-line human summary (mirrors the prior configSummary in BuilderNode).
export function configSummary(node: DraftNode): string {
  const cfg = node.config as Record<string, unknown>;
  switch (node.type) {
    case "INITIAL_OUTREACH": {
      const subj = cfg["subjectTemplate"] as string | undefined;
      return subj ? `“${subj.slice(0, 40)}${subj.length > 40 ? "…" : ""}”` : "No subject set";
    }
    case "FOLLOW_UP": {
      const count = cfg["maxCount"] as number | undefined;
      const unit = cfg["intervalUnit"] as string | undefined;
      const intervals = cfg["intervals"] as number[] | undefined;
      if (count && intervals) {
        return `${count} follow-up${count !== 1 ? "s" : ""} · every ${intervals.join(", ")} ${unit ?? "days"}`;
      }
      return "Not configured";
    }
    case "REPLY_DETECTION":
      // No config — fixed 50% threshold, low-confidence always to Manual Review.
      return "Classifies replies · low-confidence → Manual Review";
    case "NEGOTIATION": {
      const min = cfg["minBudget"] as number | undefined;
      const max = cfg["maxBudget"] as number | undefined;
      const rounds = cfg["maxRounds"] as number | undefined;
      if (min !== undefined && max !== undefined) {
        return `$${min}–$${max} budget · ${rounds ?? "?"} rounds`;
      }
      return "Not configured";
    }
    case "REWARD_SETUP": {
      const commission = cfg["commissionRate"] as number | undefined;
      return commission && commission > 0
        ? `Final fee + ${commission}% commission · awaits confirmation`
        : "Final fee · awaits creator confirmation";
    }
    case "PAYMENT_INFO":
      return "Collects payout details · awaits form submission";
    case "CONTENT_BRIEF": {
      const hasBrief = typeof cfg["briefFileRef"] === "string" && !!(cfg["briefFileRef"] as string);
      return hasBrief
        ? "Finalized offer + payout link + brief PDF · awaits payout"
        : "Upload a campaign brief PDF to launch";
    }
    case "END":
      return "Terminal node";
    case "IMPORT_CREATOR_LIST":
      return "Workflow entry point";
    default:
      return "—";
  }
}

// Compact config "chips" surfaced in the node body. Derived purely from config.
export function configChips(node: DraftNode): string[] {
  const cfg = node.config as Record<string, unknown>;
  switch (node.type) {
    case "INITIAL_OUTREACH": {
      const chips: string[] = [];
      // Lead with the mode so the canvas shows at a glance whether the first
      // email is operator-written or AI-drafted. Absent = legacy AI default.
      chips.push(cfg["outreachMode"] === "manual" ? "manual" : "AI");
      if (cfg["subjectTemplate"]) chips.push("subject");
      if (cfg["bodyTemplate"]) chips.push("body");
      return chips;
    }
    case "FOLLOW_UP": {
      const chips: string[] = [];
      const max = cfg["maxCount"] as number | undefined;
      const unit = cfg["intervalUnit"] as string | undefined;
      if (max !== undefined) chips.push(`max ${max}`);
      if (unit) chips.push(unit);
      // Follow-ups always stop on reply (hardcoded) — surface it as a fixed fact.
      chips.push("stops on reply");
      return chips;
    }
    case "REPLY_DETECTION":
      // No configurable fields; the behavior is fixed (see nodeDescription).
      return ["auto-classify", "→ manual review"];
    case "NEGOTIATION": {
      const chips: string[] = [];
      const rounds = cfg["maxRounds"] as number | undefined;
      const commission = cfg["commissionRate"] as number | undefined;
      if (rounds !== undefined) chips.push(`${rounds} rounds`);
      // No approve-mode chip: the engine always auto-accepts within budget.
      if (commission && commission > 0) chips.push(`${commission}% commission`);
      return chips;
    }
    case "REWARD_SETUP": {
      // Suggested chips: Final Fee · Commission · Deliverables · Status.
      const commission = cfg["commissionRate"] as number | undefined;
      const deliverables = cfg["deliverables"] as string | undefined;
      const chips = ["final fee"];
      chips.push(commission && commission > 0 ? `${commission}% commission` : "no commission");
      if (deliverables && deliverables.trim()) chips.push("deliverables");
      chips.push("awaits confirmation");
      return chips;
    }
    case "PAYMENT_INFO":
      // Payout method + the fields the hosted form collects, then the wait state.
      return ["payout method", "account id", "hosted form", "awaits submission"];
    case "CONTENT_BRIEF": {
      // Offer + payout link are always in the merged email · Brief (Uploaded/
      // Missing) · then the payout wait state. (No referral chip: the unique
      // per-creator tracking link is minted server-side, not configured here.)
      const hasBrief = typeof cfg["briefFileRef"] === "string" && !!(cfg["briefFileRef"] as string);
      return [
        "finalized offer",
        "payout link",
        hasBrief ? "brief uploaded" : "brief missing",
        "awaits payout",
      ];
    }
    default:
      return [];
  }
}

// NOTE: Per-node validity is NOT computed here anymore. It used to live in a
// `nodeWarning(node)` heuristic that re-implemented the rules independently of
// the real validator, which let a node's badge and the publish gate disagree
// ("valid summary but Needs configuration"). The single source of truth is now
// `validateGraph()` in web/src/workflow/graphValidation.ts — WorkflowBuilder
// runs it once and threads the per-node ValidationIssue[] down to the card,
// sidebar, and issues panel. This file stays purely presentational.

// Execution state a node TYPE corresponds to (for live counts).
const TYPE_TO_STATE: Record<string, string> = {
  INITIAL_OUTREACH: "OUTREACH_SENT",
  FOLLOW_UP: "FOLLOWED_UP",
  REPLY_DETECTION: "REPLY_RECEIVED",
  NEGOTIATION: "NEGOTIATING",
  // Reward Setup surfaces creators currently awaiting their agreement confirmation.
  REWARD_SETUP: "REWARD_PENDING",
  // Payment Info surfaces creators currently awaiting their payout-form submission.
  PAYMENT_INFO: "PAYMENT_PENDING",
  // Content Brief owns the payout-collection wait in the merged flow, so it
  // surfaces creators currently awaiting their payout-form submission (the active
  // bucket) rather than the terminal CONTENT_BRIEF_SENT.
  CONTENT_BRIEF: "PAYMENT_PENDING",
  END: "ACCEPTED",
};

export function nodeTypeToState(type: string): string | null {
  return TYPE_TO_STATE[type] ?? null;
}
