// ---------------------------------------------------------------------------
// Design tokens — Tano-inspired editorial / neo-brutalist theme
// ---------------------------------------------------------------------------
// Warm cream canvas, near-black ink, a bold serif for display type, and
// candy-bright accent blocks (coral / butter / mint / pink / lavender). The
// signature move is *sticker* surfaces: a thick black border + a hard, un-
// blurred offset shadow, so cards read like paper cut-outs pinned to the page.
// This replaces the prior dark Linear-style inspector palette.

import type { InstanceState } from "./api/types";

// ---------------------------------------------------------------------------
// Dual-theme via CSS custom properties.
// ---------------------------------------------------------------------------
// Every screen reads `colors.bg`, `colors.text`, … as inline styles, so a
// runtime light/dark swap can't work by mutating this object. Instead each
// token resolves to a CSS variable (`var(--bg, <dark fallback>)`); the actual
// values live in index.css under `[data-theme="dark"]` / `[data-theme="light"]`
// and `<ThemeProvider>` flips `data-theme` on <html>. The fallback is the dark
// value so first paint (before the attribute is set) is already correct.
//
// PALETTES (source of truth — mirrored into index.css):
//   dark  — warm near-black canvas, cream ink, candy accents, ink-black borders
//   light — warm cream canvas, near-black ink, same candy accents
export const palettes = {
  dark: {
    bg: "#17140f", // warm near-black canvas
    panel: "#201c16", // card / panel surface
    panelAlt: "#2a251d", // grouped sub-region / subtle fill
    border: "#0a0805", // ink — heavy card outline (near-black, reads on dark too via shadow)
    borderStrong: "#3a342a",
    hairline: "#302a21", // faint divider inside a surface
    text: "#f6f0e2", // warm cream ink
    textMuted: "#b0a48c", // muted sand
    textDim: "#7c7159", // faint metadata
    accent: "#f0603c", // coral signature
    accentDim: "#d94e2c",
    accentWash: "rgba(240, 96, 60, 0.16)",
    warning: "#e8b23e",
    danger: "#f0603c",
    success: "#3ecf8e",
    shadowInk: "#000000", // the hard offset shadow colour
    cardBorder: "#0a0805", // heavy outline drawn on cards
  },
  light: {
    bg: "#f4efe3", // warm cream canvas
    panel: "#fbf8f0", // card / panel surface (lighter than the page)
    panelAlt: "#efe8d8", // grouped sub-region / subtle fill
    border: "#141210", // near-black ink — heavy card outline
    borderStrong: "#141210",
    hairline: "#e2d9c6", // faint warm divider inside a surface
    text: "#141210", // near-black ink
    textMuted: "#6b6152", // warm muted brown-grey
    textDim: "#9a8f7c", // faint metadata
    accent: "#f0603c", // coral signature
    accentDim: "#d94e2c",
    accentWash: "rgba(240, 96, 60, 0.12)",
    warning: "#c98a1e",
    danger: "#d0402c",
    success: "#2f9e6b",
    shadowInk: "#141210",
    cardBorder: "#141210",
  },
} as const;

// Token → CSS variable, with the dark value inlined as the fallback.
const v = (name: keyof typeof palettes.dark) => `var(--${name}, ${palettes.dark[name]})`;

export const colors = {
  bg: v("bg"),
  panel: v("panel"),
  panelAlt: v("panelAlt"),
  border: v("border"),
  borderStrong: v("borderStrong"),
  hairline: v("hairline"),
  text: v("text"),
  textMuted: v("textMuted"),
  textDim: v("textDim"),
  accent: v("accent"),
  accentDim: v("accentDim"),
  accentWash: v("accentWash"),
  warning: v("warning"),
  danger: v("danger"),
  success: v("success"),
  // The heavy ink outline colour drawn on sticker cards / bordered chips.
  cardBorder: v("cardBorder"),
};

// The candy accent blocks used as large solid card fills (à la Tano's sticky
// notes). Same hues in both themes — they sit on their own fill, so they read
// on either canvas; text/border on them is always the ink.
export const accents = {
  coral: "#f0603c",
  butter: "#f6cf4c",
  mint: "#a6e6c1",
  pink: "#f4b8c6",
  lavender: "#c9c2f2",
  sky: "#a9d8ef",
} as const;

// Back-compat alias — some call sites read `borderSoft`.
export const borderSoft = colors.hairline;

// ---------------------------------------------------------------------------
// Design-system scales (Phase A — additive, presentational only)
// ---------------------------------------------------------------------------
// One source of truth for spacing / radii / shadows / typography / z-index, so
// primitives and screens stop hard-coding magic numbers. Nothing here changes
// data flow — it's pure visual vocabulary.

// 4px base spacing scale. Use `space[3]` instead of literal `12`.
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

// Rounder corners than the old inspector — the sticker cards want a soft
// radius against their hard border.
export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

// Hard, un-blurred *offset* shadows — the defining Tano trait. Depth comes from
// a solid ink drop-shadow, not a soft blur, so surfaces read like cut paper.
// The ink colour is theme-aware (`--shadowInk`); `sm`/`md`/`lg` grow the offset;
// `focus` is the coral ring.
const shadowInk = `var(--shadowInk, ${palettes.dark.shadowInk})`;
export const shadow = {
  sm: `2px 2px 0 ${shadowInk}`,
  md: `4px 4px 0 ${shadowInk}`,
  lg: `6px 6px 0 ${shadowInk}`,
  focus: `0 0 0 3px ${palettes.dark.accent}55`,
} as const;

// Named font stacks: a bold serif for display headlines (the signature), the
// clean sans for body/UI, and mono for ids. Wired to the @font-face imports in
// index.css.
export const fontFamily = {
  serif: `"Fraunces", "Times New Roman", Georgia, serif`,
  sans: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
  mono: `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, monospace`,
} as const;

export const font = {
  family: fontFamily,
  size: {
    xs: 11,
    sm: 12,
    md: 13,
    lg: 15,
    xl: 18,
    xxl: 26,
    display: 32,
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    black: 900,
  },
} as const;

// ---------------------------------------------------------------------------
// Type roles — the missing hierarchy layer.
// ---------------------------------------------------------------------------
// Screens read as "uniform gray AI slop" when everything is 13px/semibold. These
// are ready-to-spread style objects that give each piece of text a *role*:
// page titles are big and tight, section labels are small/tracked/dim, metadata
// recedes. Spread them: `<h1 style={{ ...text.title }}>`.
import type { CSSProperties } from "react";

export const text: Record<
  "display" | "title" | "heading" | "subheading" | "body" | "label" | "caption" | "metric",
  CSSProperties
> = {
  // Hero number / marquee value (dashboard headline metric). Serif + heavy.
  display: {
    fontFamily: fontFamily.serif,
    fontSize: font.size.display,
    fontWeight: font.weight.black,
    letterSpacing: -1,
    lineHeight: 1.02,
    color: colors.text,
  },
  // Page title (top of a screen). One per view. Serif display.
  title: {
    fontFamily: fontFamily.serif,
    fontSize: font.size.xl + 4, // 22
    fontWeight: font.weight.bold,
    letterSpacing: -0.4,
    lineHeight: 1.15,
    color: colors.text,
  },
  // Card / panel heading.
  heading: {
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    letterSpacing: -0.2,
    lineHeight: 1.3,
    color: colors.text,
  },
  subheading: {
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    letterSpacing: -0.1,
    lineHeight: 1.4,
    color: colors.text,
  },
  body: {
    fontSize: font.size.md,
    fontWeight: font.weight.regular,
    lineHeight: 1.55,
    color: colors.textMuted,
  },
  // Uppercase tracked section label (the SectionHeader / StatTile caption look).
  label: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: colors.textDim,
  },
  // Timestamps, secondary metadata — recedes.
  caption: {
    fontSize: font.size.sm,
    fontWeight: font.weight.regular,
    lineHeight: 1.4,
    color: colors.textMuted,
  },
  // Big number inside a stat tile / receipt card. Serif, à la Tano's "3.5×".
  metric: {
    fontFamily: fontFamily.serif,
    fontSize: font.size.xxl,
    fontWeight: font.weight.black,
    letterSpacing: -0.5,
    lineHeight: 1.05,
    color: colors.text,
    fontVariantNumeric: "tabular-nums",
  },
} as const;

export const z = {
  canvas: 0,
  panel: 10,
  sticky: 20,
  overlay: 900,
  modal: 1000,
  toast: 1100,
  // Portalled hover cards sit above everything: they are transient,
  // pointer-transparent, and must not be clipped by a scrolling ancestor.
  tooltip: 1200,
} as const;

// Semantic status colour keyed by the workflow/version status strings the API
// already returns. Centralises the ad-hoc ternaries scattered across screens.
export type StatusKey = "draft" | "published" | "archived" | "invalid";

export const statusColor: Record<StatusKey, string> = {
  draft: colors.warning,
  published: colors.success,
  archived: colors.textDim,
  invalid: colors.danger,
};

// Map an API status string (e.g. "PUBLISHED", "DRAFT") to a StatusKey.
export function statusKey(status: string): StatusKey {
  switch (status.toUpperCase()) {
    case "PUBLISHED":
      return "published";
    case "ARCHIVED":
      return "archived";
    case "INVALID":
      return "invalid";
    default:
      return "draft";
  }
}

// Semantic colour per workflow state. Active states are indigo, positive
// terminals green, negative terminals red/grey, review amber.
// Tuned for the cream canvas: saturated but dark enough to read as text/dot on
// a light surface. Active states lean coral/lavender, positive terminals green,
// negative red/brown, review amber.
export const stateColor: Record<InstanceState, string> = {
  ENROLLED: "#8a7f6c", // neutral warm — just entered
  OUTREACH_SENT: "#7a6fd0", // active lavender
  AWAITING_REPLY: "#6b5fc4", // active lavender (deeper)
  FOLLOWED_UP: "#9265c9", // purple — re-engagement
  REPLY_RECEIVED: "#2f9e6b", // a reply came in
  NEGOTIATING: "#c98a1e", // amber — in play
  ACCEPTED: "#2f9e6b", // success — negotiation agreed
  REWARD_PENDING: "#6b5fc4", // active — awaiting creator confirmation
  REWARD_CONFIRMED: "#238055", // deep green — agreement confirmed
  PAYMENT_PENDING: "#6b5fc4", // active — awaiting payout form submission
  PAYMENT_RECEIVED: "#238055", // deep green — payout info received
  CONTENT_BRIEF_SENT: "#238055", // green — campaign brief sent (terminal success)
  NEEDS_DEAL_FINALIZATION: "#c98a1e", // amber — parked, waiting on an operator
  HANDOFF_COMPLETE: "#238055", // green — operator finished onboarding (terminal)
  AWAITING_BRAND_APPROVAL: "#6b5fc4", // active — parked, waiting on the brand
  REJECTED: "#d0402c", // failure
  OPTED_OUT: "#c76032", // opted out
  NO_RESPONSE: "#8a7f6c", // timed out
  MANUAL_REVIEW: "#c98a1e", // needs a human
};

export const stateLabel: Record<InstanceState, string> = {
  ENROLLED: "Enrolled",
  OUTREACH_SENT: "Outreach Sent",
  AWAITING_REPLY: "Awaiting Reply",
  FOLLOWED_UP: "Followed Up",
  REPLY_RECEIVED: "Reply Received",
  NEGOTIATING: "Negotiating",
  ACCEPTED: "Accepted",
  REWARD_PENDING: "Awaiting Confirmation",
  REWARD_CONFIRMED: "Confirmed",
  PAYMENT_PENDING: "Awaiting Payout Info",
  PAYMENT_RECEIVED: "Payout Info Received",
  CONTENT_BRIEF_SENT: "Brief Sent",
  NEEDS_DEAL_FINALIZATION: "Needs Finalization",
  HANDOFF_COMPLETE: "Handoff Complete",
  AWAITING_BRAND_APPROVAL: "Awaiting Brand Approval",
  REJECTED: "Rejected",
  OPTED_OUT: "Opted Out",
  NO_RESPONSE: "No Response",
  MANUAL_REVIEW: "Manual Review",
};

// Plain-English "what does this state mean" for non-engineers (node tooltips).
export const stateDescription: Record<InstanceState, string> = {
  ENROLLED: "Imported into the campaign; outreach not yet sent.",
  OUTREACH_SENT: "First email sent; waiting to mark as awaiting reply.",
  AWAITING_REPLY: "Outreach delivered; waiting on the creator to respond.",
  FOLLOWED_UP: "A follow-up nudge was sent; waiting on a response.",
  REPLY_RECEIVED: "A reply arrived and is being classified by the AI.",
  NEGOTIATING: "In an active back-and-forth on terms with the AI agent.",
  ACCEPTED: "Negotiation agreed — finalizing the agreement in Reward Setup.",
  REWARD_PENDING: "Agreement email sent; waiting on the creator to confirm.",
  REWARD_CONFIRMED: "Creator confirmed — collecting payout info in Payment Info.",
  PAYMENT_PENDING: "Payout form emailed; waiting on the creator to submit it.",
  PAYMENT_RECEIVED: "Creator submitted payout info — sending the campaign brief.",
  CONTENT_BRIEF_SENT: "Campaign brief emailed to the creator — terminal success state.",
  NEEDS_DEAL_FINALIZATION:
    "Creator agreed. Paused for an operator to finalize the deal and onboard them in Pluvus.",
  HANDOFF_COMPLETE:
    "An operator finalized the deal and onboarded the creator — terminal success state.",
  AWAITING_BRAND_APPROVAL:
    "Creator agreed. Paused for the brand to Approve or Reject before the content brief goes out.",
  REJECTED: "Creator declined — terminal state.",
  OPTED_OUT: "Creator asked to stop being contacted — terminal state.",
  NO_RESPONSE: "All follow-ups exhausted with no reply — terminal state.",
  MANUAL_REVIEW: "Needs a human: low-confidence reply or escalated negotiation.",
};

export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return `${formatDuration(secs)} ago`;
}

// Map a transition source string to a short, human label + colour.
export const sourceMeta: Record<string, { label: string; color: string }> = {
  scheduler: { label: "Scheduler", color: "#9265c9" },
  "node-execution-worker": { label: "Worker", color: "#7a6fd0" },
  "inbound-email-worker": { label: "Inbound Worker", color: "#2f9e6b" },
  "inbound-email": { label: "Inbound Email", color: "#2f9e6b" },
  "classification-agent": { label: "Classifier AI", color: "#c98a1e" },
  "negotiation-agent": { label: "Negotiator AI", color: "#c76032" },
  "payment-form": { label: "Payout Form", color: "#238055" },
  manual: { label: "Manual", color: "#6b6152" },
  system: { label: "System", color: "#8a7f6c" },
};

export function sourceInfo(source: string | null): { label: string; color: string } {
  if (!source) return { label: "—", color: colors.textDim };
  return sourceMeta[source] ?? { label: source, color: colors.textMuted };
}
