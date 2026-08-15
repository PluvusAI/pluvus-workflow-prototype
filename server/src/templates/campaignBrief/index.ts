// PLU-139 §2/§4: the deterministic campaign-brief HTML template. A pure
// function — no I/O, no randomness, no AI on this path — mirroring how
// workflow templates already live under templates/ (templates/index.ts).
// Every material field from CampaignBriefInput is interpolated as literal,
// HTML-escaped text; only the narrative intro/summary (already produced,
// validated, and defaulted by narrative.ts before this function ever runs)
// carries any AI-influenced prose, and even that is escaped identically to
// everything else — this function does not know or care where a string
// came from.
import type { CampaignBriefInput, CompensationProjection } from "../../db/campaignBriefRender.js";
import type { NarrativeSlots } from "./narrative.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape, then turn newlines into <br> so multi-line free text stays readable. */
function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

/**
 * §2's "omit empty sections" helper, used for every section so the rule is
 * enforced structurally once, not per-section by convention. Returns "" (an
 * omitted section) for null/undefined/whitespace-only values.
 */
function renderSectionIfPresent(
  label: string,
  value: string | null | undefined,
  formatter: (v: string) => string = escapeMultiline,
): string {
  if (value == null || value.trim() === "") return "";
  return `
    <section class="brief-section">
      <h2>${escapeHtml(label)}</h2>
      <p>${formatter(value)}</p>
    </section>`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRate(rate: number): string {
  // Stored as a fraction (0.1 = 10%) throughout this codebase's compensation
  // fields (see NegotiationPolicy.commissionFloorRate etc.) — same convention here.
  return `${(rate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

const GIFT_DISPOSITION_LABEL: Record<string, string> = {
  KEEP: "yours to keep",
  LOAN: "on loan for the collaboration, then returned",
  RETURN: "returned after the collaboration",
};

/** §6 of the ticket's own document structure — the compensation/reward section body. */
function renderCompensationBody(input: CampaignBriefInput): string {
  const c: CompensationProjection = input.compensation;
  const parts: string[] = [];

  if (c.kind === "GIFT_ONLY") {
    parts.push(
      `This collaboration is compensated with product${
        input.productOrOffer ? `: ${escapeHtml(input.productOrOffer)}` : ""
      }.`,
    );
    if (c.giftDisposition) {
      parts.push(`The product is ${escapeHtml(GIFT_DISPOSITION_LABEL[c.giftDisposition] ?? c.giftDisposition)}.`);
    }
  } else {
    if (c.kind === "PAID" || c.kind === "HYBRID") {
      if (c.startingFeeCents != null) {
        parts.push(`Starting fee: ${escapeHtml(formatCents(c.startingFeeCents))}.`);
      } else if (c.priceStrategy === "REQUEST_RATE_CARD") {
        parts.push("Fee: to be discussed based on your rate card.");
      }
    }
    if (c.kind === "AFFILIATE" || c.kind === "HYBRID") {
      if (c.commissionRate != null) {
        const duration = c.commissionDurationDays
          ? ` over a ${escapeHtml(String(c.commissionDurationDays))}-day attribution window`
          : "";
        parts.push(`Commission: ${escapeHtml(formatRate(c.commissionRate))}${duration}.`);
      }
      if (c.commissionConditions) {
        parts.push(escapeHtml(c.commissionConditions));
      }
    }
    if (c.includesGifting) {
      parts.push(
        `This collaboration also includes a product${
          input.productOrOffer ? `: ${escapeHtml(input.productOrOffer)}` : ""
        }${c.giftDisposition ? `, ${escapeHtml(GIFT_DISPOSITION_LABEL[c.giftDisposition] ?? c.giftDisposition)}` : ""}.`,
      );
    }
  }

  if (input.publicPaymentTerms) {
    parts.push(`Payment terms: ${escapeMultiline(input.publicPaymentTerms)}`);
  }

  return parts.join("<br>");
}

const NEUTRAL_LOGO_INITIAL_BG = "#f5f4ef";

function renderHeader(input: CampaignBriefInput): string {
  const { brandIdentity } = input;
  const logo = brandIdentity.logoRef
    ? `<img class="brief-logo" src="${escapeHtml(brandIdentity.logoRef)}" alt="${escapeHtml(input.brand)} logo">`
    : `<div class="brief-logo brief-logo-placeholder">${escapeHtml(input.brand.slice(0, 1).toUpperCase())}</div>`;
  return `
    <header class="brief-header">
      ${logo}
      <div>
        <h1>${escapeHtml(input.campaignName)}</h1>
        <p class="brief-brand">${escapeHtml(input.brand)}</p>
      </div>
    </header>`;
}

/**
 * §2/§4: renders the complete deterministic HTML document for one
 * CampaignBrief. Format decision (§2): this HTML is never itself stored or
 * served — it is immediately converted to PDF via Puppeteer
 * (renderCampaignBrief(), §6/§9) and only the PDF is persisted, so preview
 * and stored asset are always the exact same render.
 */
export function renderCampaignBriefHtml(input: CampaignBriefInput, narrative: NarrativeSlots): string {
  const { brandIdentity } = input;

  const sections = [
    renderSectionIfPresent("The opportunity", narrative.introduction),
    renderSectionIfPresent("Product or offer", input.productOrOffer),
    renderSectionIfPresent("Objective", input.objective),
    renderSectionIfPresent("Key messages", input.keyMessages),
    renderSectionIfPresent("Deliverables", input.deliverables),
    renderSectionIfPresent("Content requirements", input.contentRequirements),
    renderSectionIfPresent("Timeline", input.timeline),
    `
    <section class="brief-section">
      <h2>Compensation</h2>
      <p>${renderCompensationBody(input)}</p>
    </section>`,
    renderSectionIfPresent("Usage rights", input.usageRights),
    renderSectionIfPresent("Exclusivity", input.exclusivity),
    renderSectionIfPresent("Attribution window", input.attributionWindow),
    renderSectionIfPresent("Prohibited claims", input.prohibitedClaims),
    input.creatorRequirements
      ? renderSectionIfPresent(
          "Who we're looking for",
          [
            Array.isArray(input.creatorRequirements.platforms)
              ? `Platforms: ${input.creatorRequirements.platforms.map(String).join(", ")}`
              : null,
            Array.isArray(input.creatorRequirements.niches)
              ? `Niches: ${input.creatorRequirements.niches.map(String).join(", ")}`
              : null,
            input.creatorRequirements.minFollowers != null
              ? `Minimum followers: ${input.creatorRequirements.minFollowers.toLocaleString()}`
              : null,
            input.creatorRequirements.audienceNotes,
            input.creatorRequirements.contentStyle,
            input.creatorRequirements.brandSafety,
          ]
            .filter((v): v is string => typeof v === "string" && v.trim() !== "")
            .join("\n"),
        )
      : "",
    `
    <section class="brief-section brief-section-process">
      <h2>Next steps</h2>
      <p>Reply to this email to confirm you're in. We'll follow up with everything you need to get started.</p>
    </section>`,
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.campaignName)} — Campaign Brief</title>
<style>
  :root {
    --brief-primary: ${brandIdentity.primaryColor};
    --brief-secondary: ${brandIdentity.secondaryColor};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 56px;
    font-family: ${brandIdentity.typography}, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    line-height: 1.5;
  }
  .brief-header {
    display: flex;
    align-items: center;
    gap: 20px;
    border-bottom: 3px solid var(--brief-primary);
    padding-bottom: 20px;
    margin-bottom: 28px;
  }
  .brief-logo { width: 56px; height: 56px; object-fit: contain; }
  .brief-logo-placeholder {
    width: 56px; height: 56px; border-radius: 8px;
    background: var(--brief-primary);
    color: ${NEUTRAL_LOGO_INITIAL_BG};
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; font-weight: 600;
  }
  h1 { margin: 0; font-size: 26px; color: var(--brief-secondary); }
  .brief-brand { margin: 4px 0 0; color: var(--brief-primary); font-weight: 600; }
  .brief-section { margin-bottom: 22px; }
  .brief-section h2 {
    font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--brief-primary); margin: 0 0 6px;
  }
  .brief-section p { margin: 0; white-space: pre-line; }
  .brief-section-process { border-top: 1px solid #e2e2e2; padding-top: 18px; }
</style>
</head>
<body>
${renderHeader(input)}
${sections.join("\n")}
</body>
</html>`;
}
