// ---------------------------------------------------------------------------
// PLU-169 (1f) — the shared, structured Deliverable representation
// ---------------------------------------------------------------------------
// ONE type used by Campaign Brief intake (CampaignDetails.deliverableQuantities),
// the pinned CampaignTermsSnapshot (a full copy of CampaignDetails, so this
// shape rides along for free), and FinalAgreement.finalDeliverables. Content
// Brief (PLU-143) is the eventual last consumer.
//
// Lowercase platform/format values match what the 8 existing DELIVERABLE_CARDS
// already persist today (web/src/components/builder/campaignIntake/sections.ts)
// — recasing already-saved rows would be pure churn for no functional gain.
//
// Negotiation-delta support (DeliverableChange / applyDeliverableChanges) is
// PLU-169 decision #5: a SEPARATE ticket, not built here. Deliverables stay
// atomic/non-negotiable in this phase, exactly as they behave today — only the
// representation becomes structured instead of a free-text passthrough.

export type DeliverablePlatform =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "linkedin"
  | "twitter"
  | "other";

export type DeliverableFormat =
  | "reel"
  | "story"
  | "carousel"
  | "video"
  | "dedicated" // YouTube dedicated video
  | "integrated" // YouTube integrated video
  | "post"
  | "other";

export interface DeliverableRequirements {
  durationSeconds?: {
    min?: number;
    max?: number;
  };
}

// PLU-169 decision #8: "other" is a platform-less custom slot
// (platform: "other", format: "other") — not an additional format option on
// every real platform. A real platform + custom format can be added to
// PLATFORM_FORMAT_MATRIX (deliverablesValidator.ts) later if a real need
// shows up; nothing about this shape blocks that later addition.
export interface Deliverable {
  /** Stable, cuid2 (server-side) / crypto.randomUUID (client-side) — see the
   *  PLU-169 doc's "ID stability" risk and decision #3 (one-time backfill for
   *  existing rows). Referenced by name only once negotiation deltas exist
   *  (a future ticket); kept on every item now so that ticket needs no
   *  migration of its own. */
  id: string;
  platform: DeliverablePlatform;
  format: DeliverableFormat;
  quantity: number;
  requirements?: DeliverableRequirements | null;
  /** Required when platform === "other" (enforced by deliverablesSchema). */
  customLabel?: string | null;
  notes?: string | null;
}
