// ---------------------------------------------------------------------------
// PLU-143 — Deliverable[] -> creator-readable prose
// ---------------------------------------------------------------------------
// Pure, no I/O. Turns the structured, validated Deliverable[] (PLU-169) into
// the human-readable summary lines a creator actually reads in their Content
// Brief email — e.g. "2 Instagram Reels", "3 Instagram Stories", "1 Raw
// Footage package". Internal stable ids and the raw enum values never reach
// this output; only the derived prose does.
//
// Consumes the COMPLETE array, unmodified — no filtering, no "changed vs
// unchanged" distinction, no delta application (there is nothing to reapply:
// PLU-169 decision #5 deferred negotiation-delta support to a separate
// ticket, so `finalDeliverables` is already the fully-resolved final package
// by construction). A mixed package therefore renders every item by
// construction, not by a rule this function has to remember.

import type { Deliverable, DeliverableFormat, DeliverablePlatform } from "./deliverables.js";

const PLATFORM_LABELS: Record<Exclude<DeliverablePlatform, "other">, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  twitter: "Twitter",
};

const FORMAT_LABELS: Record<Exclude<DeliverableFormat, "other">, { singular: string; plural: string }> = {
  reel: { singular: "Reel", plural: "Reels" },
  story: { singular: "Story", plural: "Stories" },
  carousel: { singular: "Carousel Post", plural: "Carousel Posts" },
  video: { singular: "Video", plural: "Videos" },
  dedicated: { singular: "Dedicated Video", plural: "Dedicated Videos" },
  integrated: { singular: "Integrated Video", plural: "Integrated Videos" },
  post: { singular: "Post", plural: "Posts" },
};

/** Best-effort English pluralization for a brand-authored custom label
 *  (platform: "other") — there is no closed vocabulary to look up, so this
 *  is a simple heuristic, not a full pluralizer. Documented as such rather
 *  than pretending to be exhaustive. */
function pluralizeCustomLabel(label: string): string {
  const trimmed = label.trim();
  if (/[sxz]$|[cs]h$/i.test(trimmed)) return `${trimmed}es`;
  if (/[^aeiou]y$/i.test(trimmed)) return `${trimmed.slice(0, -1)}ies`;
  return `${trimmed}s`;
}

function formatDurationRequirement(requirements: Deliverable["requirements"]): string | undefined {
  const duration = requirements?.durationSeconds;
  if (!duration || (duration.min === undefined && duration.max === undefined)) return undefined;
  if (duration.min !== undefined && duration.max !== undefined) {
    return `${duration.min}–${duration.max}s`;
  }
  if (duration.min !== undefined) return `${duration.min}s+`;
  return `up to ${duration.max}s`;
}

/** One human-readable line per deliverable, e.g. "2 Instagram Reels (30–60s)".
 *  Order matches the input array's own order — no re-sorting, no grouping. */
export function formatDeliverablesForCreator(deliverables: Deliverable[]): string[] {
  return deliverables.map((d) => {
    const quantity = d.quantity;
    const plural = quantity > 1;

    let noun: string;
    if (d.platform === "other") {
      const label = (d.customLabel ?? "").trim() || "Custom deliverable";
      noun = plural ? pluralizeCustomLabel(label) : label;
    } else {
      const platformLabel = PLATFORM_LABELS[d.platform];
      const formatLabel = FORMAT_LABELS[d.format as Exclude<DeliverableFormat, "other">];
      const formatNoun = formatLabel ? (plural ? formatLabel.plural : formatLabel.singular) : d.format;
      noun = `${platformLabel} ${formatNoun}`;
    }

    let line = `${quantity} ${noun}`;

    const duration = formatDurationRequirement(d.requirements);
    if (duration) line += ` (${duration})`;

    const notes = d.notes?.trim();
    if (notes) line += ` — ${notes}`;

    return line;
  });
}
