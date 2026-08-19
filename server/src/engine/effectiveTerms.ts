// ---------------------------------------------------------------------------
// PLU-137/138 — Effective negotiation terms: snapshot-wins over nodeGraph
// ---------------------------------------------------------------------------
// PLU-137 pinned + loaded both launch snapshots per creator journey, but nothing
// CONSUMED them in a decision — the negotiation agent, the output guard, and the
// offer/counter email copy still read the band + public terms from the (legacy)
// node config (mergeCampaignFallback → resolveBand). This resolver closes that
// gap: it overlays the pinned snapshots onto the merged config so a VALID
// SNAPSHOT ALWAYS WINS, and the node config is used for a field ONLY when the
// corresponding snapshot is absent (a legacy no-snapshot journey).
//
// Two deliberate properties (the whole safety story):
//   1. Overlay onto a shallow copy of `config` → every downstream consumer
//      (resolveBand, buildNegotiationRequest, guardConstraintsFromConfig,
//      describeDeal) keeps its exact signature; it just receives the effective
//      config. No signature churn across the ~6 call sites.
//   2. No-snapshot journey ⇒ ZERO overlay ⇒ effective config is shape-identical
//      to the input ⇒ the /negotiate + /draft prompts stay byte-identical (the
//      golden matrix is the enforcement gate). The config path is an OBSERVABLE
//      legacy fallback, never a competing authority over a present snapshot.
//
// Units (the sharp edge): the NegotiationPolicySnapshot fee band is stored in
// integer CENTS (floorCents/ceilingCents); the config band (termFloor.rate /
// minBudget) is DOLLARS. We convert cents→dollars (÷100) exactly once, here.
// (The commission triad on PolicyAuthority — commissionFloorRate/
// commissionCeilingRate/preferredCommissionRate — is a future-only field per
// docs/PLU-140-future-only-fields.md: nothing in the negotiation engine reads
// it as a band yet, so it is deliberately NOT overlaid here. Wiring it is 2E,
// out of scope for this cutover.)
//
// Removal of the nodeGraph stamping writers (restampBrand etc.) is a SEPARATE
// change (routes/workflows.ts, routes/campaigns.ts); this file is the READ-side
// cutover that makes those writes inert on read.

import type { NegotiationTerm } from "../adapters/negotiation/types.js";
import type { PolicyAuthority } from "./conversationContext/types.js";

// Only the PUBLIC keys of CampaignTermsSnapshot.detailsSnapshot we overlay. The
// snapshot column is an untyped jsonb blob (a frozen copy of CampaignDetails), so
// we read it defensively rather than trusting a type.
type DetailsSnapshot = Record<string, unknown>;

export interface EffectiveTermsInput {
  /** The pinned NegotiationPolicySnapshot projected to PolicyAuthority — present
   *  ONLY for an authorized decision context (else undefined ⇒ band from config). */
  policyAuthority?: PolicyAuthority | undefined;
  /** The pinned CampaignTermsSnapshot row (its detailsSnapshot carries the PUBLIC
   *  terms) — present ⇒ public terms from snapshot; absent ⇒ from config. */
  termsSnapshot?: { detailsSnapshot: unknown } | undefined;
  /** The already-merged node config (mergeCampaignFallback output). */
  config: Record<string, unknown>;
}

export interface EffectiveTerms {
  /** The config overlaid with snapshot-sourced material terms. Never the input
   *  object — always a shallow copy (input is not mutated). */
  config: Record<string, unknown>;
  /** 'snapshot' when EITHER snapshot supplied a material term; 'legacy_nodegraph'
   *  only when BOTH the band and the public terms fell back to config. */
  source: "snapshot" | "legacy_nodegraph";
  /** The private band came from config (no policy snapshot) — DISTINCT from the
   *  context's legacyFallbackUsed (which means the TERMS snapshot was absent). */
  bandLegacyFallback: boolean;
  /** The public terms came from config (no terms snapshot). */
  termsLegacyFallback: boolean;
  /** The node-config KEYS (e.g. "deliverables", "rewardDescription") the pinned
   *  terms snapshot explicitly CLEARED — the snapshot key was present but blank/
   *  null, so overlaySnapshotField deleted any stale config value rather than
   *  leaving it. Callers pass this to resolveKnowledgeField (explicitlyCleared)
   *  so an intentional clear cannot be resurrected from a stale NEGOTIATION node
   *  (the negotiation_state fallback tier) once the snapshot has spoken. */
  clearedFields: ReadonlySet<string>;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

// The wire-key mapping between a CampaignTermsSnapshot.detailsSnapshot column
// and the node-config key downstream consumers read — matches
// toCampaignBrandFields exactly (two columns rename; the rest pass through).
const PUBLIC_STRING_FIELD_MAP: ReadonlyArray<readonly [snapshotKey: string, configKey: string]> = [
  ["deliverables", "deliverables"],
  ["timeline", "timeline"],
  ["productOrOffer", "rewardDescription"],
  ["publicPaymentTerms", "paymentTerms"],
  ["usageRights", "usageRights"],
  ["exclusivity", "exclusivity"],
  ["attributionWindow", "attributionWindow"],
];

/**
 * Overlay one snapshot-sourced field onto the config copy. Keyed off `key in
 * details` (presence), NOT truthiness: `detailsSnapshot` always copies every
 * CampaignDetails column at launch time, so an unset public field arrives as
 * an explicit `null`, not a missing key. Present-but-empty therefore means
 * "the snapshot authoritatively has nothing here" and must CLEAR any stale
 * config value, not fall through to it; a genuinely absent key (a legacy blob
 * predating this column) leaves config alone.
 */
function overlaySnapshotField(
  overlay: Record<string, unknown>,
  details: DetailsSnapshot,
  snapshotKey: string,
  configKey: string,
  parse: (v: unknown) => unknown,
  cleared: Set<string>,
): void {
  if (!(snapshotKey in details)) return;
  const parsed = parse(details[snapshotKey]);
  if (parsed === undefined) {
    delete overlay[configKey];
    // The snapshot key was PRESENT but blank/null — an authoritative clear, not
    // an absent legacy blob. Record it so callers can suppress the
    // negotiation_state fallback for this field (see EffectiveTerms.clearedFields).
    cleared.add(configKey);
  } else {
    overlay[configKey] = parsed;
  }
}

/**
 * Overlay the pinned launch snapshots onto the node config. Snapshot ALWAYS wins;
 * config is read per-field only when the corresponding snapshot is absent.
 */
export function resolveEffectiveNegotiationConfig(input: EffectiveTermsInput): EffectiveTerms {
  const { policyAuthority, termsSnapshot, config } = input;
  const overlay: Record<string, unknown> = { ...config };
  const cleared = new Set<string>();

  // -- Band (private → policyAuthority; CENTS → DOLLARS) ---------------------
  const bandLegacyFallback = !policyAuthority;
  if (policyAuthority) {
    const floorDollars = policyAuthority.floorCents != null ? policyAuthority.floorCents / 100 : undefined;
    const ceilingDollars =
      policyAuthority.ceilingCents != null ? policyAuthority.ceilingCents / 100 : undefined;

    // Commission-only / no-fee shape (PLU-129, the sharp edge): BOTH cents null is
    // a VALID configured state, not "unset". Emit an EXPLICIT 0/0 band (both rates
    // defined), not undefined — the agent keys commission-only off ceiling === 0
    // (negotiate.py: commission_only = ceiling_rate == 0). Blanket null→undefined
    // would leave the ceiling to default to +inf downstream = the PLU-129
    // unbounded-agree bug. A mixed shape (one side null) sets only the present side
    // and leaves the other to config — so "floor without ceiling" still trips the
    // H1 no-ceiling escalation, which is the correct behavior.
    const commissionOnly = policyAuthority.floorCents == null && policyAuthority.ceilingCents == null;

    const baseFloor = (typeof config["termFloor"] === "object" ? config["termFloor"] : {}) as NegotiationTerm;
    const baseCeiling = (typeof config["termCeiling"] === "object" ? config["termCeiling"] : {}) as NegotiationTerm;

    if (commissionOnly) {
      overlay["termFloor"] = { ...baseFloor, rate: 0 };
      overlay["termCeiling"] = { ...baseCeiling, rate: 0 };
    } else {
      if (floorDollars !== undefined) overlay["termFloor"] = { ...baseFloor, rate: floorDollars };
      if (ceilingDollars !== undefined) overlay["termCeiling"] = { ...baseCeiling, rate: ceilingDollars };
    }

    // The effective ceiling after the overlay above. When it is exactly 0
    // (commission-only), the opening-position / over-ceiling knobs are inert AND
    // the shipped 0/0 templates deliberately omit recommendedOfferPosition — so we
    // skip those overlays there to keep the config byte-identical on that shape.
    const effectiveCeiling = commissionOnly ? 0 : ceilingDollars;
    if (effectiveCeiling !== 0) {
      const openingPosition = finiteNumber(policyAuthority.openingOfferPosition);
      if (openingPosition !== undefined) overlay["recommendedOfferPosition"] = openingPosition;
      const tolerance = finiteNumber(policyAuthority.overCeilingTolerance);
      if (tolerance !== undefined && tolerance >= 0) overlay["overCeilingTolerance"] = tolerance;
    }

    const maxRounds = finiteNumber(policyAuthority.maxRounds);
    if (maxRounds !== undefined) overlay["maxRounds"] = maxRounds;
  }

  // -- Public terms (public → termsSnapshot.detailsSnapshot) -----------------
  const details =
    termsSnapshot && typeof termsSnapshot.detailsSnapshot === "object" && termsSnapshot.detailsSnapshot !== null
      ? (termsSnapshot.detailsSnapshot as DetailsSnapshot)
      : undefined;
  const termsLegacyFallback = !details;
  if (details) {
    // PUBLIC commission ONLY — never the private commission triad on policyAuthority.
    overlaySnapshotField(overlay, details, "publicCommissionRate", "commissionRate", finiteNumber, cleared);
    for (const [snapshotKey, configKey] of PUBLIC_STRING_FIELD_MAP) {
      overlaySnapshotField(overlay, details, snapshotKey, configKey, nonEmptyString, cleared);
    }
  }

  return {
    config: overlay,
    source: bandLegacyFallback && termsLegacyFallback ? "legacy_nodegraph" : "snapshot",
    bandLegacyFallback,
    termsLegacyFallback,
    clearedFields: cleared,
  };
}
