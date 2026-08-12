// ---------------------------------------------------------------------------
// PLU-138 (1d) — Effective negotiation terms: snapshot-wins over nodeGraph
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
// Units (the sharp edge): the NegotiationPolicySnapshot band is stored in integer
// CENTS (floorCents/ceilingCents); the config band (termFloor.rate / minBudget)
// is DOLLARS. We convert cents→dollars (÷100) exactly once, here.
//
// PLU-138 owns the removal of the nodeGraph stamping writers (restampBrand etc.);
// this file is the READ-side cutover that makes those writes inert on read.

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
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

// Overlay a PUBLIC snapshot field onto the effective config. The snapshot OWNS the
// field whenever the source key is PRESENT (detailsSnapshot always copies every
// CampaignDetails column, so an unset public field arrives as an explicit null —
// NOT an absent key). Present ⇒ write the valid value, or DELETE the target key so
// a present-but-null/blank snapshot clears the stale node-graph value instead of
// retaining it. Absent key (legacy blob predating the field) ⇒ leave config alone.
function overlaySnapshotField(
  overlay: Record<string, unknown>,
  details: DetailsSnapshot,
  sourceKey: string,
  targetKey: string,
  parse: (v: unknown) => unknown,
): void {
  if (!(sourceKey in details)) return;
  const parsed = parse(details[sourceKey]);
  if (parsed !== undefined) overlay[targetKey] = parsed;
  else delete overlay[targetKey];
}

/**
 * Overlay the pinned launch snapshots onto the node config. Snapshot ALWAYS wins;
 * config is read per-field only when the corresponding snapshot is absent.
 */
export function resolveEffectiveNegotiationConfig(input: EffectiveTermsInput): EffectiveTerms {
  const { policyAuthority, termsSnapshot, config } = input;
  const overlay: Record<string, unknown> = { ...config };

  // -- Band (private → policyAuthority; CENTS → DOLLARS) ---------------------
  const bandLegacyFallback = !policyAuthority;
  if (policyAuthority) {
    const floorDollars =
      policyAuthority.floorCents != null ? policyAuthority.floorCents / 100 : undefined;
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
    const commissionOnly =
      policyAuthority.floorCents == null && policyAuthority.ceilingCents == null;

    const baseFloor = (isObject(config["termFloor"]) ? config["termFloor"] : {}) as NegotiationTerm;
    const baseCeiling = (isObject(config["termCeiling"])
      ? config["termCeiling"]
      : {}) as NegotiationTerm;

    if (commissionOnly) {
      overlay["termFloor"] = { ...baseFloor, rate: 0 };
      overlay["termCeiling"] = { ...baseCeiling, rate: 0 };
    } else {
      if (floorDollars !== undefined) overlay["termFloor"] = { ...baseFloor, rate: floorDollars };
      if (ceilingDollars !== undefined) {
        overlay["termCeiling"] = { ...baseCeiling, rate: ceilingDollars };
      }
    }

    // The effective ceiling after the overlay above. When it is exactly 0
    // (commission-only), the opening-position / over-ceiling knobs are inert AND
    // the shipped 0/0 templates deliberately omit recommendedOfferPosition — so we
    // skip those overlays there to keep the config byte-identical on that shape.
    const effectiveCeiling = commissionOnly ? 0 : ceilingDollars;
    const ceilingIsZero = effectiveCeiling === 0;

    if (!ceilingIsZero) {
      const openingPosition = finiteNumber(policyAuthority.openingOfferPosition);
      if (openingPosition !== undefined) overlay["recommendedOfferPosition"] = openingPosition;
      const tolerance = finiteNumber(policyAuthority.overCeilingTolerance);
      if (tolerance !== undefined && tolerance >= 0) overlay["overCeilingTolerance"] = tolerance;
    }

    const maxRounds = finiteNumber(policyAuthority.maxRounds);
    if (maxRounds !== undefined) overlay["maxRounds"] = maxRounds;
  }

  // -- Public terms (public → termsSnapshot.detailsSnapshot) -----------------
  const details: DetailsSnapshot | undefined =
    termsSnapshot && isObject(termsSnapshot.detailsSnapshot)
      ? (termsSnapshot.detailsSnapshot as DetailsSnapshot)
      : undefined;
  const termsLegacyFallback = !details;
  if (details) {
    // PUBLIC commission ONLY — never the private commission triad on policyAuthority.
    overlaySnapshotField(overlay, details, "publicCommissionRate", "commissionRate", finiteNumber);

    overlaySnapshotField(overlay, details, "deliverables", "deliverables", nonEmptyString);
    overlaySnapshotField(overlay, details, "timeline", "timeline", nonEmptyString);
    // detailsSnapshot uses the CampaignDetails column names; the node-config wire
    // keys differ for two fields (productOrOffer→rewardDescription,
    // publicPaymentTerms→paymentTerms), matching toCampaignBrandFields.
    overlaySnapshotField(overlay, details, "productOrOffer", "rewardDescription", nonEmptyString);
    overlaySnapshotField(overlay, details, "publicPaymentTerms", "paymentTerms", nonEmptyString);

    for (const key of ["usageRights", "exclusivity", "attributionWindow"] as const) {
      overlaySnapshotField(overlay, details, key, key, nonEmptyString);
    }
  }

  const source: EffectiveTerms["source"] =
    bandLegacyFallback && termsLegacyFallback ? "legacy_nodegraph" : "snapshot";

  return { config: overlay, source, bandLegacyFallback, termsLegacyFallback };
}
