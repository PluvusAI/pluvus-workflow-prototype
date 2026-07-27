// ---------------------------------------------------------------------------
// PLU-82: Campaign-knowledge precedence resolver
// ---------------------------------------------------------------------------
// ONE documented, deterministic source order per knowledge category, replacing
// the scattered inline `firstString(config, negotiationConfig, campaign)` chains
// copy-pasted across the three post-acceptance executors (operatorHandoff.ts /
// rewardSetup.ts / contentBrief.ts).
//
// The issue's central mandate (PLU-82 / invariant #1): the LLM never decides
// between conflicting sources — CODE does, by a documented ordered walk that
// returns the first PRESENT value AND a label naming which source won. The
// winning-source label is the "selected source recorded in internal debug
// context" acceptance criterion (§4.6).
//
// This module is a THIN, documented wrapper (invariant #3): it (a) picks the
// category's ordered slot list from PRECEDENCE_BY_CATEGORY, (b) delegates the
// actual first-present pick to firstString/firstNumber from agreedFee.ts —
// REUSED, never re-implemented, so the whitespace-empty / NaN-absent semantics
// are byte-identical to the inline chains it replaces — and (c) additionally
// reports which slot won. A hand-rolled `?.` chain would treat "" as present and
// change output, so we do NOT do that.
//
// Precedence is BY FIELD CATEGORY (invariant #2) — one universal hierarchy does
// not fit every field. See PRECEDENCE_BY_CATEGORY / §4.2 for the two families and
// the per-field annotations. The brief is deliberately NOT a source slot here: it
// is a CONFLICT CHALLENGER, never a resolution fallback (invariant #2, §4.5).
//
// This module is PURE and, on this branch, INERT until Phase 2 migrates the
// executor call sites to it. It touches no money path: `fixedFee` is special-
// cased out of this resolver entirely (CA via resolveAgreedFee, or escalate — the
// resolver must never fabricate a fee; agreedFee.ts / §9).

import { firstString, firstNumber } from "./executors/agreedFee.js";

// The knowledge categories this resolver arbitrates. `fixedFee` is intentionally
// ABSENT — it comes only from a real confirmed agreement (resolveAgreedFee) or it
// escalates; code must never fabricate a fee, so it never walks a fallback ladder
// (invariant #2, §4.2). brandName/senderName/brandDescription resolve through
// resolveBrandName / mergeCampaignFallback (a different, untouched layer,
// invariant #4) and are documented in §4.2 for completeness but are not resolved
// here.
export type KnowledgeCategory =
  | "commissionRate"
  | "deliverables"
  | "timeline"
  | "rewardDescription"
  | "paymentTerms"
  | "usageRights"
  | "exclusivity"
  | "attributionWindow";

// The ordered, typed source slots. Every category's precedence walks a SUBSET of
// these, in this canonical order (the issue's finalized-terms ladder). A slot the
// call site does not have is simply passed `undefined` — the walk skips it, which
// is byte-identical to the inline chain never having listed it (§4.3, invariant
// #3). This is why one canonical order + per-call-site slots reproduces all three
// executors' differing chains without per-executor policy tables.
export interface KnowledgeSources {
  /** Top of the ladder — a real confirmed creator agreement (e.g.
   *  resolveAgreedFee(events) for fee). Rarely populated for the string terms. */
  confirmedAgreement?: unknown;
  /** PLU-113 SEAM — no producer on this branch; ALWAYS undefined here (§8-a). The
   *  slot + its 2nd-tier position are proven correct by a unit test (it wins when
   *  present) so a future operator-override feature lights up with no resolver
   *  change and no re-litigation of the order. */
  operatorOverride?: unknown;
  /** The NEGOTIATION node's config (negotiationConfig). */
  negotiationState?: unknown;
  /** THIS node's published config (node.config) — "node config wins". */
  workflowConfig?: unknown;
  /** campaign.* column. */
  campaignDefault?: unknown;
  // briefSection is deliberately NOT a slot — the brief is a CONFLICT CHALLENGER,
  // never a resolution fallback (invariant #2, §4.2). It never appears here.
}

export type SourceLabel =
  | "confirmed_agreement"
  | "operator_override"
  | "negotiation_state"
  | "workflow_config"
  | "campaign_default"
  | null;

export interface Resolved<T> {
  value: T | undefined;
  /** Which slot the value came from, or null when no slot had a present value. */
  source: SourceLabel;
}

// Label → slot lookup. This is NOT the precedence order (that lives per-category
// in PRECEDENCE_BY_CATEGORY); it only maps a category's label list back to the
// KnowledgeSources field to read.
const SLOT_BY_LABEL: Record<NonNullable<SourceLabel>, keyof KnowledgeSources> = {
  confirmed_agreement: "confirmedAgreement",
  operator_override: "operatorOverride",
  negotiation_state: "negotiationState",
  workflow_config: "workflowConfig",
  campaign_default: "campaignDefault",
};

// PLU-82 §4.2: the documented precedence BY CATEGORY, as data (rendered human-
// readably in readme_docs/). Each entry is the ORDERED list of source labels that
// category consults. Two families (invariant #2):
//
//   Finalized-terms family (commissionRate / deliverables / timeline /
//   rewardDescription / paymentTerms) — walks a subset of the CA/OO/NS/WC/CD
//   ladder. This is what resolveKnowledgeField consolidates from the inline
//   chains.
//
//   General-knowledge family (usageRights / exclusivity / attributionWindow) —
//   WC/CD only, with the brief as a CONFLICT CHALLENGER (never a resolution
//   source, so it has no slot here). The Campaign field stays authoritative for
//   the VALUE; the brief only disagrees loudly (PLU-107 invariant #5, §4.5).
//
// Canonical order (matching the live inline chains, byte-identical — invariant
// #3): OPERATOR_OVERRIDE (seam) → WORKFLOW_CONFIG (node.config, "node config
// wins") → NEGOTIATION_STATE (negotiationConfig) → CAMPAIGN_DEFAULT. That is,
// node config beats negotiation-node state beats campaign, exactly as
// `firstString(config, negotiationConfig, campaign)` does.
//
// Ordering notes that make "one universal ladder doesn't fit" concrete:
//   - commissionRate has NO confirmed-agreement tier (commission is a fixed brand
//     term, not per-creator-negotiated) and no campaign_default.
//   - paymentTerms deliberately SKIPS negotiation_state (WC → CD only). This
//     preserves the one known inline inconsistency (operatorHandoff.ts resolves
//     paymentTerms as config → campaign, skipping negotiationConfig, while
//     deliverables/timeline include it). It snapshots into DealHandoff and renders
//     to the brand, so harmonizing it silently would change a real deal — that is
//     a separate, labeled, golden-tested change, OUT OF SCOPE here (invariant #3,
//     §7). DO NOT add negotiation_state to paymentTerms in this migration.
//   - operator_override leads every finalized-terms category as the typed seam
//     (§8-a); it is always undefined on this branch, so it never changes a result
//     today, but its position is fixed and unit-proven.
export const PRECEDENCE_BY_CATEGORY: Record<KnowledgeCategory, SourceLabel[]> = {
  // Finalized-terms family. WC before NS (node config wins over negotiation state).
  commissionRate: ["operator_override", "workflow_config", "negotiation_state"],
  deliverables: ["operator_override", "workflow_config", "negotiation_state", "campaign_default"],
  timeline: ["operator_override", "workflow_config", "negotiation_state", "campaign_default"],
  rewardDescription: [
    "operator_override",
    "workflow_config",
    "negotiation_state",
    "campaign_default",
  ],
  // paymentTerms: WC → CD, NS SKIPPED (inconsistency preserved, invariant #3).
  paymentTerms: ["operator_override", "workflow_config", "campaign_default"],
  // General-knowledge family (brief is a conflict challenger, not a slot).
  usageRights: ["operator_override", "workflow_config", "campaign_default"],
  exclusivity: ["operator_override", "workflow_config", "campaign_default"],
  attributionWindow: ["operator_override", "workflow_config", "campaign_default"],
};

// The categories whose value is NUMERIC (resolved with firstNumber's finite-number
// semantics); everything else is a string (firstString's whitespace-empty
// semantics). Keeping this as data rather than a per-call flag means the call site
// only names the category and the resolver picks the right emptiness rule.
const NUMERIC_CATEGORIES: ReadonlySet<KnowledgeCategory> = new Set<KnowledgeCategory>([
  "commissionRate",
]);

/**
 * Resolve a knowledge field by its documented category precedence (§4.1).
 *
 * Walks the category's ordered slot list (PRECEDENCE_BY_CATEGORY), collects the
 * present candidates in order, and delegates the actual "first present" pick to
 * firstString/firstNumber (REUSED from agreedFee.ts — same whitespace-empty / NaN-
 * absent semantics as the inline chains, invariant #3), then reports WHICH slot
 * that first-present value came from.
 *
 * Byte-identical to the inline chain it replaces: an absent/empty/NaN slot is
 * skipped exactly as `firstString(a, b, c)` skipped it, and slots the caller does
 * not pass are `undefined` (skipped). The returned `source` label is the only new
 * information — it is the "selected source in debug context" criterion (§4.6) and
 * never affects the value.
 *
 * NB: `fixedFee` is NOT a category here — it never falls back through this ladder
 * (CA via resolveAgreedFee or escalate; never fabricate a fee, §9).
 */
export function resolveKnowledgeField(
  category: KnowledgeCategory,
  sources: KnowledgeSources,
): Resolved<string> | Resolved<number> {
  const order = PRECEDENCE_BY_CATEGORY[category];
  const isNumeric = NUMERIC_CATEGORIES.has(category);

  for (const label of order) {
    if (label === null) continue;
    const slot = SLOT_BY_LABEL[label];
    if (!slot) continue;
    const candidate = sources[slot];
    // Delegate the presence check to the SAME helpers the inline chains used, one
    // candidate at a time, so the first slot that is "present" under those exact
    // semantics wins — and we know its label because we tested slots in order.
    const present = isNumeric
      ? firstNumber(candidate)
      : firstString(candidate);
    if (present !== undefined) {
      return { value: present, source: label } as Resolved<string> | Resolved<number>;
    }
  }
  return { value: undefined, source: null };
}
