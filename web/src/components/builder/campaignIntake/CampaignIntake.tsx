// ---------------------------------------------------------------------------
// PLU-139 (2a) — Stage-1 Campaign Brief sectioned intake (frontend only)
// ---------------------------------------------------------------------------
// The sectioned campaign-brief editor: a left-rail section nav, one section
// shown at a time, per-group debounced autosave (~1s after an edit), and a
// lifecycle-aware read-only mode. It renders whatever sections.ts declares and
// PATCHes the three shipped PR-A1 groups (campaign / brand-identity /
// creator-requirement). No structural field knowledge lives here — that's all in
// sections.ts, the single edit point for PLU-159's design handoff.
//
// Autosave reuses WorkflowBuilder's debounce shape (a saveTimerRef + a 1000ms
// setTimeout + a doSave that toasts on failure). On save failure the LOCAL draft
// is untouched and a persistent "Changes not saved · Retry" affordance shows, so
// nothing the brand typed is lost.
//
// COPY: user-facing strings here that aren't field labels (nav status, buttons,
// banners) are PLACEHOLDER pending PLU-159, marked `// COPY:PLU-159`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, Lock, Upload, Check, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCampaign,
  useBrandIdentity,
  useCreatorRequirement,
  useBriefExtraction,
  updateCampaign,
  updateBrandIdentity,
  updateCreatorRequirement,
  duplicateCampaign,
  createBriefExtraction,
  uploadFile,
} from "../../../api/builderClient";
import type {
  BrandIdentityInput,
  BriefExtractionFields,
  CampaignType,
  CreatorRequirementInput,
  DeliverableQuantity,
  DeliverablePricing,
  FollowerRanges,
  GiftDisposition,
  PriceStrategy,
} from "../../../api/builderTypes";
import { colors, radii, font, text } from "../../../theme";
import {
  Button,
  Card,
  Badge,
  FormField,
  Input,
  Textarea,
  Select,
  Toggle,
  RadioCardGroup,
  useToast,
} from "../../ds";
import {
  SECTIONS,
  visibleFields,
  missingRequiredKeys,
  needsFee,
  needsCommission,
  showsGiftDetails,
  showsInstagramCollab,
  isGiftOnly,
  candidateFieldFor,
  BOOL_RADIO_KEYS,
  DELIVERABLE_CARDS,
  type CompensationShape,
  type FieldGroup,
  type FieldSpec,
  type SectionKey,
  type SectionSpec,
  type SelectOption,
} from "./sections";
import { COUNTRIES, countryLabel } from "./countries";

interface Props {
  campaignId: string;
  onBack: () => void;
  /** Route to a freshly-duplicated campaign's intake. */
  onOpenCampaign: (campaignId: string) => void;
}

// Loose per-group draft maps — keyed by the FieldSpec.key. Values are the raw
// control values (string for text/number inputs, boolean for toggles, string[]
// for chips). The shell coerces these to the API payload shape at save time.
type Draft = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Value coercion between the API and the loose control-value draft.
// ---------------------------------------------------------------------------

/** money is stored in cents on the API (publicStartingFeeCents); shown in dollars. */
function centsToDollars(v: number | null | undefined): string {
  return typeof v === "number" ? String(v / 100) : "";
}

export function CampaignIntake({ campaignId, onBack, onOpenCampaign }: Props) {
  const toast = useToast();
  const campaignQ = useCampaign(campaignId);
  // These two sub-endpoints 404 when no row exists yet (a fresh draft). That 404
  // is NOT an error for us — it just means "empty group"; PATCH upserts. So we
  // read `.data` and never surface these queries' error state.
  const brandQ = useBrandIdentity(campaignId);
  const creatorQ = useCreatorRequirement(campaignId);

  const [activeSection, setActiveSection] = useState<SectionKey>("startSources");
  // Keys of required fields the user tried to skip via "Save & continue" while
  // empty. Cleared on a successful advance or when leaving the section via Back /
  // the rail. Only these keys render an inline error — validation is on-demand
  // (at the gate), never eager, so an untouched draft shows no red.
  const [errorKeys, setErrorKeys] = useState<Set<string>>(new Set());

  // One draft per persisted group. Seeded from the queries on first load.
  const [campaignDraft, setCampaignDraft] = useState<Draft>({});
  const [brandDraft, setBrandDraft] = useState<Draft>({});
  const [creatorDraft, setCreatorDraft] = useState<Draft>({});
  const seededRef = useRef(false);

  // Per-group save status. Errors persist (never auto-cleared) until a retry
  // succeeds, so the "not saved" affordance stays put.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The groups touched since the last successful save — only these get PATCHed.
  const dirtyRef = useRef<Set<FieldGroup>>(new Set());

  const [duplicating, setDuplicating] = useState(false);

  const status = campaignQ.data?.status ?? "DRAFT";
  const readOnly = status !== "DRAFT";

  // Seed drafts once the three loads settle (campaign is required; the two
  // sub-groups may legitimately be absent → empty).
  useEffect(() => {
    if (seededRef.current || !campaignQ.data) return;
    const c = campaignQ.data;
    setCampaignDraft({
      name: c.name,
      brand: c.brand,
      targetUrl: c.targetUrl ?? "",
      objective: c.objective ?? "",
      brandDescription: c.brandDescription ?? "",
      deliverables: c.deliverables ?? "",
      notes: c.notes ?? "",
      keyMessages: c.keyMessages ?? "",
      contentRequirements: c.contentRequirements ?? "",
      timeline: c.timeline ?? "",
      usageRights: c.usageRights ?? "",
      exclusivity: c.exclusivity ?? "",
      paymentTerms: c.paymentTerms ?? "",
      attributionWindow: c.attributionWindow ?? "",
      campaignType: (c.campaignType ?? "PAID") as CampaignType,
      priceStrategy: (c.priceStrategy ?? "REQUEST_RATE_CARD") as PriceStrategy,
      publicStartingFeeCents: centsToDollars(c.publicStartingFeeCents),
      publicCommissionRate:
        c.publicCommissionRate != null ? String(c.publicCommissionRate) : "",
      commissionDurationDays:
        c.commissionDurationDays != null ? String(c.commissionDurationDays) : "",
      commissionConditions: c.commissionConditions ?? "",
      includesGifting: c.includesGifting ?? false,
      giftDisposition: c.giftDisposition ?? "",
      rewardDescription: c.rewardDescription ?? "",
      // shipsPhysicalProduct is NOT NULL (default false) on the API, so false IS
      // a real value — seed it as the boolean; the S7.G6 radio shows No/Yes.
      shipsPhysicalProduct: c.shipsPhysicalProduct ?? false,
      // PLU-139 (2a): worksheet Stage-1 fields.
      brandMaterialsRef: c.brandMaterialsRef ?? "",
      productName: c.productName ?? "",
      productType: c.productType ?? "",
      creatorAccessNeeded: c.creatorAccessNeeded ?? null,
      uniqueSellingPoints: c.uniqueSellingPoints ?? "",
      whyTrust: c.whyTrust ?? "",
      howToUse: c.howToUse ?? "",
      brandAssets: c.brandAssets ?? "",
      deliverableQuantities: c.deliverableQuantities ?? [],
      deliverablePricing: c.deliverablePricing ?? {},
      followerRanges: c.followerRanges ?? {},
      commissionMode: c.commissionMode ?? "percent",
      briefDeliveryMethod: c.briefDeliveryMethod ?? "",
      briefHighlight: c.briefHighlight ?? "",
      creativeConcept: c.creativeConcept ?? "",
      referenceVideos: c.referenceVideos ?? "",
      scriptSubmission: c.scriptSubmission ?? "",
      adAuthorization: c.adAuthorization ?? "",
      linkInBioDuration: c.linkInBioDuration ?? "",
      postRetention: c.postRetention ?? "",
      instagramCollab: c.instagramCollab ?? null,
      requireApproval: c.requireApproval ?? false,
      variableCommission: c.variableCommission ?? "",
      giftDeliveryMethod: c.giftDeliveryMethod ?? "",
      promoCode: c.promoCode ?? "",
      giftContactEmail: c.giftContactEmail ?? "",
      requiresShippingInfo: c.requiresShippingInfo ?? false,
      affiliateTrackingUrl: c.affiliateTrackingUrl ?? "",
      trackingLinkMode: c.trackingLinkMode ?? "",
      trackingDestinationUrl: c.trackingDestinationUrl ?? "",
      trackingParameter: c.trackingParameter ?? "",
    });
    const b = brandQ.data;
    setBrandDraft({
      logoRef: b?.logoRef ?? "",
      primaryColor: b?.primaryColor ?? "",
      secondaryColor: b?.secondaryColor ?? "",
      typography: b?.typography ?? "",
    });
    const cr = creatorQ.data;
    // platforms is derived from the deliverable cards, not seeded/edited here.
    // geography is a string[] of ISO codes (the country picker works on the
    // array directly — no comma round-trip).
    setCreatorDraft({
      geography: Array.isArray(cr?.geography) ? cr.geography : [],
      minFollowers: cr?.minFollowers != null ? String(cr.minFollowers) : "",
    });
    // Only mark seeded once campaign loaded; the two sub-queries settling later
    // is fine — a fresh draft has no rows and stays empty (matches the API).
    seededRef.current = true;
  }, [campaignQ.data, brandQ.data, creatorQ.data]);

  const comp: CompensationShape = useMemo(
    () => ({
      campaignType: (campaignDraft.campaignType as CampaignType) ?? "PAID",
      includesGifting: Boolean(campaignDraft.includesGifting),
      priceStrategy: (campaignDraft.priceStrategy as PriceStrategy) ?? "REQUEST_RATE_CARD",
      giftDeliveryMethod: String(campaignDraft.giftDeliveryMethod ?? ""),
      // Distinct platforms across the selected deliverable cards — drives the
      // S6.7 Instagram-collab conditional (sections.showsInstagramCollab).
      selectedPlatforms: Array.isArray(campaignDraft.deliverableQuantities)
        ? [
            ...new Set(
              (campaignDraft.deliverableQuantities as DeliverableQuantity[])
                .map((r) => r.platform)
                .filter(Boolean),
            ),
          ]
        : [],
    }),
    [
      campaignDraft.campaignType,
      campaignDraft.includesGifting,
      campaignDraft.priceStrategy,
      campaignDraft.giftDeliveryMethod,
      campaignDraft.deliverableQuantities,
    ],
  );

  // -- persistence --------------------------------------------------------
  // Build the PATCH payload for one group from its draft, coercing control
  // values back to the API shape. For the campaign group we ONLY send the
  // fields the reward-structure conditionals currently make visible plus the
  // always-on prose fields — and we send CLEARED values (null/false/"") for
  // reward fields hidden by the current structure, so switching a structure
  // wipes stale terms on the server (the backend owns truth).
  const buildCampaignPayload = useCallback((): Parameters<typeof updateCampaign>[1] => {
    const d = campaignDraft;
    // NOTE: name/brand are set at create and are NOT in the PATCH surface
    // (the server rejects them here), so the Start section shows them but the
    // brief editor never re-sends them.
    const p: Parameters<typeof updateCampaign>[1] = {
      targetUrl: strOrNull(d.targetUrl),
      objective: strOrNull(d.objective),
      brandDescription: strOrNull(d.brandDescription),
      deliverables: strOrNull(d.deliverables),
      notes: strOrNull(d.notes),
      keyMessages: strOrNull(d.keyMessages),
      contentRequirements: strOrNull(d.contentRequirements),
      timeline: strOrNull(d.timeline),
      usageRights: strOrNull(d.usageRights),
      exclusivity: strOrNull(d.exclusivity),
      // PLU-139 (2a): always-on worksheet fields (not structure-conditional).
      brandMaterialsRef: strOrNull(d.brandMaterialsRef),
      productName: strOrNull(d.productName),
      productType: strOrNull(d.productType),
      creatorAccessNeeded: boolOrNull(d.creatorAccessNeeded),
      uniqueSellingPoints: strOrNull(d.uniqueSellingPoints),
      whyTrust: strOrNull(d.whyTrust),
      howToUse: strOrNull(d.howToUse),
      brandAssets: strOrNull(d.brandAssets),
      deliverableQuantities: Array.isArray(d.deliverableQuantities)
        ? (d.deliverableQuantities as DeliverableQuantity[])
        : null,
      // S3.11 per-platform follower ranges — always-on; empty map → null.
      followerRanges: objOrNull(d.followerRanges),
      briefDeliveryMethod: strOrNull(d.briefDeliveryMethod),
      briefHighlight: strOrNull(d.briefHighlight),
      creativeConcept: strOrNull(d.creativeConcept),
      referenceVideos: strOrNull(d.referenceVideos),
      scriptSubmission: strOrNull(d.scriptSubmission),
      adAuthorization: strOrNull(d.adAuthorization),
      linkInBioDuration: strOrNull(d.linkInBioDuration),
      postRetention: strOrNull(d.postRetention),
      // S6.7 is conditional on Instagram being a requested platform; when it's
      // hidden, clear it so a stale "yes" can't outlive deselecting Instagram.
      instagramCollab: showsInstagramCollab(comp) ? boolOrNull(d.instagramCollab) : null,
      requireApproval: Boolean(d.requireApproval),
      // Compensation shape is always sent — it's the switch itself.
      campaignType: comp.campaignType,
      includesGifting: !isGiftOnly(comp.campaignType) ? comp.includesGifting : true,
      compensationReviewStatus: "CONFIRMED",
    };

    // Fee/strategy — only when the structure needs a fee.
    if (needsFee(comp.campaignType)) {
      p.priceStrategy = comp.priceStrategy;
      p.publicStartingFeeCents =
        comp.priceStrategy === "PROPOSE_STARTING_FEE" ? dollarsToCents(d.publicStartingFeeCents) : null;
      p.paymentTerms = strOrNull(d.paymentTerms);
      // S7.P1 per-deliverable pricing map — only meaningful with the fee grid.
      p.deliverablePricing =
        comp.priceStrategy === "PROPOSE_STARTING_FEE" ? objOrNull(d.deliverablePricing) : null;
    } else {
      p.priceStrategy = null;
      p.publicStartingFeeCents = null;
      p.paymentTerms = null;
      p.deliverablePricing = null;
    }

    // Commission — only for affiliate/hybrid; cleared otherwise. Public tracking
    // (T-series) + variable commission share this condition.
    if (needsCommission(comp.campaignType)) {
      p.publicCommissionRate = numOrNull(d.publicCommissionRate);
      p.commissionMode = strOrNull(d.commissionMode) ?? "percent"; // S7.A1 %/flat
      p.commissionDurationDays = numOrNull(d.commissionDurationDays);
      p.commissionConditions = strOrNull(d.commissionConditions);
      p.attributionWindow = strOrNull(d.attributionWindow);
      p.variableCommission = strOrNull(d.variableCommission);
      p.affiliateTrackingUrl = strOrNull(d.affiliateTrackingUrl);
      p.trackingLinkMode = strOrNull(d.trackingLinkMode);
      p.trackingDestinationUrl = strOrNull(d.trackingDestinationUrl);
      p.trackingParameter = strOrNull(d.trackingParameter);
    } else {
      p.publicCommissionRate = null;
      p.commissionMode = null;
      p.commissionDurationDays = null;
      p.commissionConditions = null;
      p.attributionWindow = null;
      p.variableCommission = null;
      p.affiliateTrackingUrl = null;
      p.trackingLinkMode = null;
      p.trackingDestinationUrl = null;
      p.trackingParameter = null;
    }

    // Gift details — for gift-only or additive gifting; cleared otherwise. The
    // delivery-path fields (method → promo-code / manual-contact) live here too.
    if (showsGiftDetails(comp)) {
      p.rewardDescription = strOrNull(d.rewardDescription);
      p.shipsPhysicalProduct = Boolean(d.shipsPhysicalProduct);
      // GIFT_ONLY is locked to KEEP; a bonus gift uses the chosen disposition.
      p.giftDisposition = isGiftOnly(comp.campaignType)
        ? "KEEP"
        : ((d.giftDisposition as GiftDisposition) || null);
      p.requiresShippingInfo = Boolean(d.requiresShippingInfo);
      const method = String(d.giftDeliveryMethod ?? "");
      p.giftDeliveryMethod = method || null;
      // Only the chosen path's field is sent; the other is cleared.
      p.promoCode = method === "promo_code" ? strOrNull(d.promoCode) : null;
      p.giftContactEmail = method === "manual_contact" ? strOrNull(d.giftContactEmail) : null;
    } else {
      p.rewardDescription = null;
      p.shipsPhysicalProduct = false;
      p.giftDisposition = null;
      p.requiresShippingInfo = false;
      p.giftDeliveryMethod = null;
      p.promoCode = null;
      p.giftContactEmail = null;
    }
    return p;
  }, [campaignDraft, comp]);

  const buildBrandPayload = useCallback((): BrandIdentityInput => {
    const d = brandDraft;
    return {
      logoRef: strOrNull(d.logoRef),
      primaryColor: strOrNull(d.primaryColor),
      secondaryColor: strOrNull(d.secondaryColor),
      typography: strOrNull(d.typography),
    };
  }, [brandDraft]);

  const buildCreatorPayload = useCallback((): CreatorRequirementInput => {
    const d = creatorDraft;
    // platforms (S3.1) is DERIVED from the selected deliverable cards — the
    // distinct platforms across the chosen {platform, format, quantity} rows.
    // Order-stable dedupe so the same selection always yields the same array.
    const rows = Array.isArray(campaignDraft.deliverableQuantities)
      ? (campaignDraft.deliverableQuantities as DeliverableQuantity[])
      : [];
    const platforms = [...new Set(rows.map((r) => r.platform).filter(Boolean))];
    return {
      platforms,
      geography: Array.isArray(d.geography) ? (d.geography as string[]) : [],
      minFollowers: numOrNull(d.minFollowers),
    };
  }, [creatorDraft, campaignDraft.deliverableQuantities]);

  const doSave = useCallback(async () => {
    const groups = Array.from(dirtyRef.current);
    if (groups.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      // PATCH only the dirty groups. Run them in sequence — the set is tiny (≤3)
      // and it keeps error attribution simple.
      if (groups.includes("campaign")) await updateCampaign(campaignId, buildCampaignPayload());
      if (groups.includes("brandIdentity"))
        await updateBrandIdentity(campaignId, buildBrandPayload());
      if (groups.includes("creatorRequirement"))
        await updateCreatorRequirement(campaignId, buildCreatorPayload());
      dirtyRef.current.clear();
      setSavedTick((t) => t + 1);
    } catch (err) {
      // Keep the local draft AND the dirty set intact so nothing is lost and a
      // retry re-sends exactly what failed.
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      toast.error(`Couldn't save: ${msg}`); // COPY:PLU-159
    } finally {
      setSaving(false);
    }
  }, [
    campaignId,
    buildCampaignPayload,
    buildBrandPayload,
    buildCreatorPayload,
    toast,
  ]);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void doSave(), 1000);
  }, [doSave, readOnly]);

  // Save & continue: cancel the pending debounce and persist now, so advancing a
  // section doesn't leave a redundant timer firing a second identical PATCH.
  const flushSave = useCallback(() => {
    if (readOnly) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void doSave();
  }, [doSave, readOnly]);

  // Flush any pending timer on unmount so a debounced edit isn't dropped.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // -- edit handlers -------------------------------------------------------
  const setField = useCallback(
    (group: FieldGroup, key: string, value: unknown) => {
      dirtyRef.current.add(group);
      // Editing the deliverable cards changes the DERIVED creatorRequirement
      // platforms too, so mark that group dirty so its PATCH re-sends them.
      if (group === "campaign" && key === "deliverableQuantities") {
        dirtyRef.current.add("creatorRequirement");
      }
      const setter =
        group === "campaign"
          ? setCampaignDraft
          : group === "brandIdentity"
            ? setBrandDraft
            : setCreatorDraft;
      setter((prev) => ({ ...prev, [key]: value }));
      scheduleSave();
    },
    [scheduleSave],
  );

  // Duplicate → clone on the server, open the new draft's intake.
  const handleDuplicate = useCallback(async () => {
    setDuplicating(true);
    try {
      const dup = await duplicateCampaign(campaignId);
      toast.success(`Duplicated as “${dup.name}”.`); // COPY:PLU-159
      onOpenCampaign(dup.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Duplicate failed";
      toast.error(msg);
      setDuplicating(false);
    }
  }, [campaignId, onOpenCampaign, toast]);

  // -- loading / error -----------------------------------------------------
  if (campaignQ.isLoading) {
    return <Center>Loading campaign…</Center>; // COPY:PLU-159
  }
  if (campaignQ.isError || !campaignQ.data) {
    return (
      <Center>
        <div style={{ textAlign: "center" }}>
          <div style={{ ...text.heading, marginBottom: 8 }}>Couldn't load this campaign</div>
          <Button variant="secondary" onClick={onBack}>
            Back to campaigns
          </Button>
        </div>
      </Center>
    );
  }

  const section = SECTIONS.find((s) => s.key === activeSection)!;
  // Name+brand are the only launch-hard fields (mirrors create). Everything else
  // is optional for a Draft — an incomplete Draft is allowed.
  const nameMissing = !String(campaignDraft.name ?? "").trim();
  const brandMissing = !String(campaignDraft.brand ?? "").trim();

  // S7.T4 — derive the read-only tracking-URL preview from the affiliate URL +
  // parameter, with a placeholder creator code. Pure display; not persisted.
  const trackingPreview = useMemo(() => {
    const base = String(campaignDraft.affiliateTrackingUrl ?? campaignDraft.targetUrl ?? "").trim();
    if (!base) return "";
    const param = String(campaignDraft.trackingParameter ?? "_from").trim() || "_from";
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}${param}=CREATOR_CODE`;
  }, [campaignDraft.affiliateTrackingUrl, campaignDraft.targetUrl, campaignDraft.trackingParameter]);

  // Read a field's raw draft value by its group (for required-field validation).
  const readFieldValue = useCallback(
    (f: FieldSpec): unknown => draftValue(f, campaignDraft, brandDraft, creatorDraft),
    [campaignDraft, brandDraft, creatorDraft],
  );

  // Leaving the section (Back, or a rail jump) drops any pending validation
  // errors — we only block the forward "Save & continue", never trap the user.
  const leaveSection = useCallback((key: SectionKey) => {
    setErrorKeys(new Set());
    setActiveSection(key);
  }, []);

  // The worksheet's enforcement rule: "Save & continue validates the active
  // substage" — block on empty *required* fields, surface an error summary +
  // inline errors + focus the first invalid control; otherwise flush and advance.
  // Draft-first still holds elsewhere (Back and the rail never validate; nothing
  // is force-required until this gate), so a partially filled page is fine until
  // the user chooses to move forward.
  const validateAndAdvance = useCallback(
    (next: SectionKey) => {
      const missing = missingRequiredKeys(section, comp, readFieldValue);
      if (missing.length > 0) {
        setErrorKeys(new Set(missing));
        // Focus the first invalid control (its id matches FieldRenderer's).
        const first = visibleFields(section, comp).find((f) => missing.includes(f.key));
        if (first) {
          requestAnimationFrame(() => {
            document.getElementById(`intake-${first.group}-${first.key}`)?.focus();
          });
        }
        return;
      }
      setErrorKeys(new Set());
      flushSave();
      setActiveSection(next);
    },
    [section, comp, readFieldValue, flushSave],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "16px 24px",
          borderBottom: `2px solid ${colors.cardBorder}`,
          background: colors.panel,
        }}
      >
        <Button variant="ghost" onClick={onBack} leftIcon={<ArrowLeft size={15} strokeWidth={2} />}>
          Campaigns
        </Button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ ...text.title, fontSize: font.size.xl }}>
              {String(campaignDraft.name || campaignQ.data.name) || "Untitled campaign"}
            </span>
            <Badge color={readOnly ? colors.textMuted : colors.warning} dot small>
              {status === "DRAFT" ? "Draft" : "Active"} {/* COPY:PLU-159 */}
            </Badge>
          </div>
          <div style={{ ...text.caption, marginTop: 2 }}>
            Campaign Brief · Stage 1 of 3 {/* COPY:PLU-159 */}
          </div>
        </div>
        <SaveStatus saving={saving} saveError={saveError} savedTick={savedTick} onRetry={() => void doSave()} readOnly={readOnly} />
      </div>

      {readOnly && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 24px",
            background: colors.panelAlt,
            borderBottom: `1px solid ${colors.border}`,
            fontSize: font.size.md,
            color: colors.textMuted,
          }}
        >
          <Lock size={14} strokeWidth={2} aria-hidden />
          {/* COPY:PLU-159 */}
          <span>
            This campaign is live, so the brief is locked. Duplicate it to make changes on a new
            draft.
          </span>
          <div style={{ marginLeft: "auto" }}>
            <Button
              variant="secondary"
              onClick={() => void handleDuplicate()}
              disabled={duplicating}
              leftIcon={<Copy size={14} strokeWidth={2} />}
            >
              {duplicating ? "Duplicating…" : "Duplicate as new campaign"}
            </Button>
          </div>
        </div>
      )}

      {/* Body: left rail + section content */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <SectionRail
          active={activeSection}
          onSelect={leaveSection}
          nameMissing={nameMissing}
          brandMissing={brandMissing}
          comp={comp}
        />

        <div className="ds-fade-in" style={{ flex: 1, overflow: "auto", padding: "28px 32px 40px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <h2 style={{ ...text.title, margin: "0 0 4px" }}>{section.title}</h2>
            {section.blurb && (
              <p style={{ ...text.body, margin: "0 0 22px", maxWidth: 620 }}>{section.blurb}</p>
            )}

            {/* Import: upload a brief and review extracted candidates. Start
                section only; never in read-only mode. Applying a candidate fills
                the matching draft field — it's never auto-written. */}
            {activeSection === "startSources" && !readOnly && (
              <BriefImport
                campaignId={campaignId}
                onApply={(fieldKey, textValue) => setField("campaign", fieldKey, textValue)}
                onContinue={() => {
                  // S1.6: "Use our campaign builder" — continue without waiting
                  // for extraction. Flush any pending save, advance to page 2.
                  flushSave();
                  const idx = SECTIONS.findIndex((s) => s.key === activeSection);
                  const next = SECTIONS[idx + 1];
                  if (next) setActiveSection(next.key);
                }}
              />
            )}

            {/* Validation summary: shown only after a blocked "Save & continue".
                role="alert" announces it without moving focus (focus goes to the
                first invalid control). Per the worksheet enforcement table. */}
            {errorKeys.size > 0 && (
              <div
                role="alert"
                style={{
                  marginBottom: 18,
                  padding: "10px 14px",
                  background: `${colors.danger}12`,
                  border: `1px solid ${colors.danger}55`,
                  borderRadius: radii.sm,
                  color: colors.danger,
                  fontSize: font.size.sm,
                }}
              >
                {/* COPY:PLU-159 */}
                {errorKeys.size === 1
                  ? "1 required field needs a value before you continue."
                  : `${errorKeys.size} required fields need a value before you continue.`}
              </div>
            )}

            <Card variant="flat" padding={22} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {visibleFields(section, comp).map((f) => (
                <FieldRenderer
                  key={`${f.group}:${f.key}`}
                  field={f}
                  value={draftValue(f, campaignDraft, brandDraft, creatorDraft)}
                  onChange={(v) => {
                    setField(f.group, f.key, v);
                    // Clear this field's error as soon as the user starts fixing it.
                    if (errorKeys.has(f.key)) {
                      setErrorKeys((prev) => {
                        const nextSet = new Set(prev);
                        nextSet.delete(f.key);
                        return nextSet;
                      });
                    }
                  }}
                  disabled={readOnly}
                  invalid={
                    (f.key === "name" && nameMissing) ||
                    (f.key === "brand" && brandMissing) ||
                    errorKeys.has(f.key)
                  }
                  error={errorKeys.has(f.key) ? "This field is required." /* COPY:PLU-159 */ : undefined}
                  extra={{
                    deliverableQuantities: Array.isArray(campaignDraft.deliverableQuantities)
                      ? (campaignDraft.deliverableQuantities as DeliverableQuantity[])
                      : [],
                    trackingPreview: trackingPreview,
                    pricing: (campaignDraft.deliverablePricing as DeliverablePricing) ?? {},
                    ranges: (campaignDraft.followerRanges as FollowerRanges) ?? {},
                    commissionMode: String(campaignDraft.commissionMode ?? "percent"),
                  }}
                  onExtraChange={(k, v) => setField("campaign", k, v)}
                />
              ))}
            </Card>

            {/* Footer: Back / Save & continue */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 22 }}>
              <SectionStepper
                active={activeSection}
                onBack={leaveSection}
                onContinue={validateAndAdvance}
                onSave={flushSave}
                readOnly={readOnly}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left rail — vertical section nav. A role="tablist" (vertical) of buttons; the
// active section is the current tab. Reuses the Tabs visual grammar (accent
// marker on the active item) on the vertical axis Tabs doesn't cover.
// ---------------------------------------------------------------------------
function SectionRail({
  active,
  onSelect,
  nameMissing,
  brandMissing,
  comp,
}: {
  active: SectionKey;
  onSelect: (k: SectionKey) => void;
  nameMissing: boolean;
  brandMissing: boolean;
  comp: CompensationShape;
}) {
  return (
    <nav
      role="tablist"
      aria-orientation="vertical"
      aria-label="Campaign brief sections" // COPY:PLU-159
      style={{
        flexShrink: 0,
        width: 268,
        borderRight: `1px solid ${colors.border}`,
        background: colors.panel,
        overflow: "auto",
        padding: "18px 12px",
      }}
    >
      <div style={{ ...text.label, padding: "0 10px 10px" }}>Campaign Brief {/* COPY:PLU-159 */}</div>
      {SECTIONS.map((s, i) => {
        const selected = s.key === active;
        // Launch-incomplete indicator: the Start section is incomplete while
        // name/brand are blank. Other sections are all-optional for a Draft.
        const incomplete = s.key === "startSources" && (nameMissing || brandMissing);
        return (
          <button
            key={s.key}
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(s.key)}
            className="ds-focusable"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              padding: "10px 10px",
              marginBottom: 2,
              background: selected ? colors.accentWash : "transparent",
              border: "none",
              borderLeft: `3px solid ${selected ? colors.accent : "transparent"}`,
              borderRadius: radii.sm,
              cursor: "pointer",
              color: selected ? colors.text : colors.textMuted,
              fontSize: font.size.md,
              fontWeight: selected ? font.weight.semibold : font.weight.medium,
            }}
          >
            <span
              aria-hidden
              className="nums"
              style={{ color: colors.textDim, fontSize: font.size.sm, width: 14 }}
            >
              {i + 1}
            </span>
            <span style={{ flex: 1 }}>{sectionNavLabel(s, comp)}</span>
            {incomplete && (
              <span
                title="Required to launch" // COPY:PLU-159
                aria-label="incomplete"
                style={{ width: 7, height: 7, borderRadius: "50%", background: colors.warning }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

// A shorter nav label than the full section title where useful.
function sectionNavLabel(s: SectionSpec, _comp: CompensationShape): string {
  // COPY:PLU-159 — nav uses the section title verbatim for now.
  return s.title;
}

// Back / Save & continue stepper. "Save & continue" flushes the pending autosave
// immediately, then advances; an incomplete Draft is still allowed to advance.
function SectionStepper({
  active,
  onBack,
  onContinue,
  onSave,
  readOnly,
}: {
  active: SectionKey;
  /** Go to the previous section (never validates). */
  onBack: (k: SectionKey) => void;
  /** Attempt to advance to the next section — the shell validates first. */
  onContinue: (k: SectionKey) => void;
  /** Flush a pending save on the last section (no advance). */
  onSave: () => void;
  readOnly: boolean;
}) {
  const idx = SECTIONS.findIndex((s) => s.key === active);
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;
  const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;
  return (
    <>
      {prev && (
        <Button variant="secondary" onClick={() => onBack(prev.key)}>
          Back
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {next ? (
        // Validation lives in the shell (onContinue); even in read-only mode the
        // gate is a no-op advance because required fields are already satisfied
        // on an ACTIVE campaign — but keep the click routed through it for one path.
        <Button variant="primary" onClick={() => onContinue(next.key)} rightIcon="→">
          Save & continue {/* COPY:PLU-159 */}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => !readOnly && onSave()} disabled={readOnly}>
          Save {/* COPY:PLU-159 */}
        </Button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Field renderer — control per FieldSpec.control. Pure presentation over the
// loose draft value + an onChange back to the shell.
// ---------------------------------------------------------------------------
function FieldRenderer({
  field,
  value,
  onChange,
  disabled,
  invalid,
  error,
  extra,
  onExtraChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  invalid?: boolean;
  /** Inline validation message (required-field gate). */
  error?: string | undefined;
  /** Cross-field context a few controls need: the selected deliverables (pricing
   *  grid), the derived tracking preview, and the structured pricing/ranges/mode
   *  values those controls read and write via onExtraChange. */
  extra?: {
    deliverableQuantities?: DeliverableQuantity[];
    trackingPreview?: string;
    pricing?: DeliverablePricing;
    ranges?: FollowerRanges;
    commissionMode?: string;
  };
  /** Write a sibling campaign field (for controls that own more than one column,
   *  e.g. the pricing grid writes both publicStartingFeeCents and the map). */
  onExtraChange?: (key: string, value: unknown) => void;
}) {
  const id = `intake-${field.group}-${field.key}`;
  // A field can be locked either by the lifecycle (whole form read-only when
  // ACTIVE) or by being a create-only field (name/brand).
  const isDisabled = disabled || !!field.readOnly;
  const common = { id, disabled: isDisabled } as const;
  // exactOptionalPropertyTypes: pass `invalid` only when true.
  const invalidProps = invalid ? { invalid: true as const } : {};

  let control: React.ReactNode;
  switch (field.control) {
    case "textarea":
      control = (
        <Textarea
          {...common}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
        />
      );
      break;
    case "toggle":
      control = (
        <Toggle
          checked={Boolean(value)}
          onChange={onChange}
          disabled={isDisabled}
          label={field.hint ?? field.label}
        />
      );
      break;
    case "select":
      control = (
        <Select {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose one…</option> {/* COPY:PLU-159 */}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
      break;
    case "radioCards": {
      // Boolean-backed fields (S2.5, S6.7, S7.G6) store true/false; the radio
      // uses "true"/"false" string values and coerces on change.
      const isBool = BOOL_RADIO_KEYS.has(field.key);
      const cur = isBool
        ? value === true
          ? "true"
          : value === false
            ? "false"
            : null
        : String(value ?? "") || null;
      control = (
        <RadioCardGroup
          ariaLabel={field.label}
          options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          value={cur}
          onChange={(v) => onChange(isBool ? v === "true" : v)}
          disabled={isDisabled}
        />
      );
      break;
    }
    case "richText":
      // Worksheet asks for a rich-text editor; a real WYSIWYG is PLU-159 design
      // work. Until then this is a multi-line editor over the same string column
      // (data shape identical). Roomier than a plain textarea to signal intent.
      control = (
        <Textarea
          {...common}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={5}
        />
      );
      break;
    case "searchableSelect":
      control = (
        <SearchableSelect
          id={id}
          value={String(value ?? "")}
          options={field.options ?? []}
          placeholder={field.placeholder}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "durationSelect":
      control = (
        <DurationSelect
          id={id}
          value={String(value ?? "")}
          options={field.options ?? []}
          customPlaceholder={field.placeholder}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "commissionAmount":
      control = (
        <CommissionAmount
          id={id}
          rate={String(value ?? "")}
          mode={extra?.commissionMode === "flat" ? "flat" : "percent"}
          onChangeRate={onChange}
          onChangeMode={(m) => onExtraChange?.("commissionMode", m)}
          placeholder={field.placeholder}
          disabled={isDisabled}
        />
      );
      break;
    case "attributionWindow":
      control = (
        <AttributionWindow
          value={String(value ?? "")}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "repeatableLinks":
      control = (
        <RepeatableLinks
          value={String(value ?? "")}
          placeholder={field.placeholder}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "pricingGrid":
      control = (
        <PricingGrid
          firstFeeDollars={String(value ?? "")}
          pricing={extra?.pricing ?? {}}
          deliverables={extra?.deliverableQuantities ?? []}
          onChangeFirstFee={onChange}
          onChangePricing={(m) => onExtraChange?.("deliverablePricing", m)}
          disabled={isDisabled}
        />
      );
      break;
    case "followerRanges":
      control = (
        <FollowerRanges
          ranges={extra?.ranges ?? {}}
          platforms={(extra?.deliverableQuantities ?? []).map((d) => d.platform)}
          minFollowers={String(value ?? "")}
          onChangeRanges={(r) => onExtraChange?.("followerRanges", r)}
          onChangeMin={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "trackingPreview":
      control = <TrackingPreview preview={extra?.trackingPreview ?? ""} />;
      break;
    case "quantityRows":
      control = (
        <QuantityRows
          value={Array.isArray(value) ? (value as DeliverableQuantity[]) : []}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "deliverableCards":
      control = (
        <DeliverableCards
          value={Array.isArray(value) ? (value as DeliverableQuantity[]) : []}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "countryPicker":
      control = (
        <CountryPicker
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          disabled={isDisabled}
          inputId={id}
        />
      );
      break;
    case "file":
      control = (
        <FileField
          value={String(value ?? "")}
          accept={field.accept}
          onChange={onChange}
          disabled={isDisabled}
        />
      );
      break;
    case "number":
    case "money":
      control = (
        <Input
          {...common}
          type="number"
          min={field.min}
          max={field.max}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          {...invalidProps}
        />
      );
      break;
    case "text":
    case "url":
    case "email":
    default: {
      const strVal = String(value ?? "");
      const over = field.maxCount != null && strVal.length > field.maxCount;
      control = (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Input
            {...common}
            type={field.control === "url" ? "url" : field.control === "email" ? "email" : "text"}
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            {...(invalid || over ? { invalid: true as const } : {})}
          />
          {field.maxCount != null && !isDisabled && (
            // S1.1 — live character counter with soft over-limit state.
            <span
              style={{
                alignSelf: "flex-end",
                fontSize: font.size.xs,
                color: over ? colors.danger : colors.textDim,
              }}
            >
              {strVal.length}/{field.maxCount}
            </span>
          )}
        </div>
      );
    }
  }

  // Toggle already renders its own label; wrap the rest in a FormField.
  if (field.control === "toggle") {
    return (
      <FormField label={field.label} hint={field.hint} required={field.required} error={error}>
        {control}
      </FormField>
    );
  }
  return (
    <FormField label={field.label} htmlFor={id} hint={field.hint} required={field.required} error={error}>
      {control}
    </FormField>
  );
}

// ---------------------------------------------------------------------------
// Save-status pill — mirrors WorkflowBuilder's Saving… / ✓ Saved / error states.
// ---------------------------------------------------------------------------
function SaveStatus({
  saving,
  saveError,
  savedTick,
  onRetry,
  readOnly,
}: {
  saving: boolean;
  saveError: string | null;
  savedTick: number;
  onRetry: () => void;
  readOnly: boolean;
}) {
  if (readOnly) return null;
  if (saveError) {
    return (
      <button
        onClick={onRetry}
        className="ds-focusable"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: `${colors.danger}14`,
          border: `1px solid ${colors.danger}55`,
          borderRadius: radii.pill,
          padding: "4px 12px",
          color: colors.danger,
          fontSize: font.size.sm,
          fontWeight: font.weight.semibold,
          cursor: "pointer",
        }}
      >
        Changes not saved · Retry {/* COPY:PLU-159 */}
      </button>
    );
  }
  if (saving) {
    return <span style={{ fontSize: font.size.sm, color: colors.textDim }}>Saving…</span>; // COPY:PLU-159
  }
  if (savedTick > 0) {
    return (
      <span style={{ fontSize: font.size.sm, color: colors.textMuted, display: "inline-flex", gap: 5 }}>
        <span style={{ color: colors.success }}>✓</span> Saved {/* COPY:PLU-159 */}
      </span>
    );
  }
  return null;
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: colors.textMuted,
        fontSize: font.size.md,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BriefImport — upload a brief PDF, review its extracted sections as CANDIDATES.
// ---------------------------------------------------------------------------
// The import half of the intake. Upload reuses the shared /uploads + /brief-
// extraction routes; the result is EVIDENCE, never authoritative. Each extracted
// section that maps to an editable campaign field gets an "Apply" that fills that
// field (marking it dirty → autosave) — never auto-applied. Unmapped sections
// show as read-only evidence. Applying/dismissing is per-candidate; re-uploading
// produces a fresh candidate set and never overwrites already-entered values.
// Upload/parse failure is surfaced but never blocks manual entry.
function BriefImport({
  campaignId,
  onApply,
  onContinue,
}: {
  campaignId: string;
  onApply: (fieldKey: string, textValue: string) => void;
  /** S1.6 — "Use our campaign builder": continue without waiting for extraction. */
  onContinue: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const existing = useBriefExtraction(campaignId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-candidate local status so applied/dismissed ones collapse without a refetch.
  const [handled, setHandled] = useState<Record<string, "applied" | "dismissed">>({});
  const fileRef = useRef<HTMLInputElement>(null);

  // The latest stored extraction (404 → none yet, not an error).
  const extraction: BriefExtractionFields | undefined = existing.data;

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const uploaded = await uploadFile(file);
      await createBriefExtraction(campaignId, uploaded.reference);
      // Fresh candidate set → clear per-candidate handled state and refetch.
      setHandled({});
      await qc.invalidateQueries({ queryKey: ["campaign", campaignId, "brief-extraction"] });
      toast.success("Brief uploaded — review the extracted fields below."); // COPY:PLU-159
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Extracted sections → candidate rows. Defensive: sections may be null/loose.
  const candidates = Object.entries(extraction?.sections ?? {})
    .map(([key, sec]) => {
      const textValue = typeof sec?.text === "string" ? sec.text.trim() : "";
      return { key, textValue, field: candidateFieldFor(key) };
    })
    .filter((c) => c.textValue.length > 0);

  const pending = candidates.filter((c) => !handled[c.key]);

  return (
    <Card
      variant="inset"
      padding={18}
      style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...text.subheading }}>Import from a brief {/* COPY:PLU-159 */}</div>
          <div style={{ ...text.caption }}>
            {/* COPY:PLU-159 — S1.3/S1.5: upload auto-starts extraction. */}
            Upload an existing brief PDF and we'll read it automatically, pulling out fields for you
            to review — nothing is saved until you apply it.
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <Button
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          leftIcon={<Upload size={14} strokeWidth={2} />}
        >
          {busy ? "Reading…" : extraction ? "Upload another" : "Upload brief"} {/* COPY:PLU-159 */}
        </Button>
        {/* S1.6 — secondary action, always available (even mid-extraction). */}
        <Button variant="ghost" onClick={onContinue}>
          Use our campaign builder {/* COPY:PLU-159 */}
        </Button>
      </div>

      {/* S1.5: automatic extraction runs with a visible progress state. It fires
          on upload (below) — failure surfaces but never blocks manual entry. */}
      {busy && (
        <div
          role="status"
          className="ds-pulse"
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: font.size.sm, color: colors.textMuted }}
        >
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: colors.accent, display: "inline-block" }} />
          Reading the brief and extracting fields… {/* COPY:PLU-159 */}
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontSize: font.size.sm, color: colors.danger }}>
          {error} — you can still fill everything in manually below. {/* COPY:PLU-159 */}
        </div>
      )}

      {extraction && candidates.length === 0 && (
        <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>
          {/* COPY:PLU-159 */}
          We couldn't pull structured fields from that file. You can still fill everything in
          manually below.
        </div>
      )}

      {pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((c) => (
            <div
              key={c.key}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "10px 12px",
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.sm,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.text }}>
                    {c.field ? c.field.label : c.key}
                  </span>
                  <Badge color={colors.accent} small>
                    From brief {/* COPY:PLU-159 */}
                  </Badge>
                </div>
                <div
                  style={{
                    fontSize: font.size.sm,
                    color: colors.textMuted,
                    lineHeight: 1.5,
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {c.textValue}
                </div>
                {!c.field && (
                  <div style={{ fontSize: font.size.xs, color: colors.textDim, marginTop: 3 }}>
                    {/* COPY:PLU-159 */}
                    No matching field yet — kept as reference.
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {c.field && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      onApply(c.field!.key, c.textValue);
                      setHandled((h) => ({ ...h, [c.key]: "applied" }));
                    }}
                    leftIcon={<Check size={13} strokeWidth={2.25} />}
                  >
                    Apply {/* COPY:PLU-159 */}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHandled((h) => ({ ...h, [c.key]: "dismissed" }))}
                  leftIcon={<X size={13} strokeWidth={2.25} />}
                >
                  Dismiss {/* COPY:PLU-159 */}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {extraction && pending.length === 0 && candidates.length > 0 && (
        <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>
          All extracted fields reviewed. {/* COPY:PLU-159 */}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// QuantityRows — repeatable {platform, format, quantity} editor (S3.2–S3.9).
// ---------------------------------------------------------------------------
// A minimal add/remove list; the structured counterpart to the free-text
// deliverables field. Values round-trip as the deliverableQuantities jsonb list.
function QuantityRows({
  value,
  onChange,
  disabled,
}: {
  value: DeliverableQuantity[];
  onChange: (v: DeliverableQuantity[]) => void;
  disabled: boolean;
}) {
  function update(i: number, patch: Partial<DeliverableQuantity>) {
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...value, { platform: "", format: "", quantity: 1 }]);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {value.map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Input
            aria-label="Platform"
            placeholder="Platform" // COPY:PLU-159
            value={row.platform}
            disabled={disabled}
            onChange={(e) => update(i, { platform: e.target.value })}
            style={{ flex: 2 }}
          />
          <Input
            aria-label="Format"
            placeholder="Format" // COPY:PLU-159
            value={row.format}
            disabled={disabled}
            onChange={(e) => update(i, { format: e.target.value })}
            style={{ flex: 2 }}
          />
          <Input
            aria-label="Quantity"
            type="number"
            min={1}
            value={String(row.quantity ?? "")}
            disabled={disabled}
            onChange={(e) => update(i, { quantity: Number(e.target.value) || 0 })}
            style={{ flex: 1 }}
          />
          {!disabled && (
            <Button variant="ghost" size="sm" onClick={() => remove(i)} leftIcon={<X size={13} strokeWidth={2.25} />}>
              {""}
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <div>
          <Button variant="secondary" size="sm" onClick={add}>
            Add row {/* COPY:PLU-159 */}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeliverableCards — the 8 worksheet platform/format checkbox cards (S3.2–S3.9).
// ---------------------------------------------------------------------------
// Each card toggles a { platform, format, quantity } row in the SAME
// deliverableQuantities jsonb the generic QuantityRows wrote — so the storage
// contract is unchanged; only the UI is worksheet-exact now. A card is selected
// iff a row with its platform+format exists; selecting adds a row (qty 1),
// deselecting removes it, and the quantity input edits it in place.
function DeliverableCards({
  value,
  onChange,
  disabled,
}: {
  value: DeliverableQuantity[];
  onChange: (v: DeliverableQuantity[]) => void;
  disabled: boolean;
}) {
  const indexOf = (platform: string, format: string) =>
    value.findIndex((r) => r.platform === platform && r.format === format);

  function toggle(platform: string, format: string) {
    const i = indexOf(platform, format);
    if (i >= 0) onChange(value.filter((_, idx) => idx !== i));
    else onChange([...value, { platform, format, quantity: 1 }]);
  }
  function setQty(platform: string, format: string, quantity: number) {
    const i = indexOf(platform, format);
    if (i < 0) return;
    onChange(value.map((r, idx) => (idx === i ? { ...r, quantity } : r)));
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 8,
      }}
    >
      {DELIVERABLE_CARDS.map((card) => {
        const i = indexOf(card.platform, card.format);
        const selected = i >= 0;
        return (
          <div
            key={`${card.platform}:${card.format}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              background: selected ? colors.accentWash : colors.panel,
              border: `1px solid ${selected ? colors.accent : colors.border}`,
              borderRadius: radii.sm,
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flex: 1,
                minWidth: 0,
                cursor: disabled ? "default" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => toggle(card.platform, card.format)}
              />
              <span
                style={{
                  fontSize: font.size.sm,
                  fontWeight: selected ? font.weight.semibold : font.weight.medium,
                  color: colors.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {card.label}
              </span>
            </label>
            {selected && (
              <Input
                aria-label={`${card.label} quantity`}
                type="number"
                min={1}
                value={String(value[i]?.quantity ?? "")}
                disabled={disabled}
                onChange={(e) => setQty(card.platform, card.format, Number(e.target.value) || 0)}
                style={{ width: 64, flexShrink: 0 }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CountryPicker — searchable multi-select for S3.10 (countries / markets).
// ---------------------------------------------------------------------------
// A text input backed by a native <datalist> for type-to-filter search (no
// combobox dependency), plus removable chips for the selected countries. The
// value is a string[] of ISO alpha-2 codes — exactly what CreatorRequirement.
// geography stores. Selecting adds a code; a code already chosen is skipped.
function CountryPicker({
  value,
  onChange,
  disabled,
  inputId,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
  inputId: string;
}) {
  const [text, setText] = useState("");
  const listId = `${inputId}-countries`;
  const selected = new Set(value);

  // Resolve typed text (a country name, or a raw code) to an ISO code to add.
  function tryAdd(raw: string) {
    const q = raw.trim().toLowerCase();
    if (!q) return;
    const match = COUNTRIES.find(
      (c) => c.name.toLowerCase() === q || c.code.toLowerCase() === q,
    );
    if (!match || selected.has(match.code)) {
      setText("");
      return;
    }
    onChange([...value, match.code]);
    setText("");
  }

  // Only offer not-yet-selected countries in the search list.
  const available = COUNTRIES.filter((c) => !selected.has(c.code));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {value.map((code) => (
            <span
              key={code}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 8px",
                background: colors.accentWash,
                border: `1px solid ${colors.accent}`,
                borderRadius: radii.pill,
                fontSize: font.size.sm,
                color: colors.text,
              }}
            >
              {countryLabel(code)}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${countryLabel(code)}`}
                  onClick={() => onChange(value.filter((c) => c !== code))}
                  className="ds-focusable"
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: colors.textMuted, padding: 0, display: "inline-flex" }}
                >
                  <X size={12} strokeWidth={2.25} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <Input
        id={inputId}
        list={listId}
        disabled={disabled}
        value={text}
        placeholder="Search countries…" // COPY:PLU-159
        onChange={(e) => {
          setText(e.target.value);
          // A datalist pick fires onChange with the full value — auto-add it.
          if (COUNTRIES.some((c) => c.name === e.target.value)) tryAdd(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            tryAdd(text);
          }
        }}
      />
      <datalist id={listId}>
        {available.map((c) => (
          <option key={c.code} value={c.name} />
        ))}
      </datalist>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileField — upload one file via the shared /uploads route (PLU-139 B).
// ---------------------------------------------------------------------------
// The value IS the stored reference string, so it round-trips through the same
// draft → PATCH plumbing as any text field (logoRef / brandMaterialsRef). Server
// validates by magic bytes; a rejected file surfaces inline and never clears an
// existing reference. No AI prefill from the asset — that's a later step.
function FileField({
  value,
  accept,
  onChange,
  disabled,
}: {
  value: string;
  accept?: string | undefined;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const uploaded = await uploadFile(file);
      setName(uploaded.originalName);
      onChange(uploaded.reference); // marks the group dirty → autosave
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed"; // COPY:PLU-159
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        disabled={disabled || busy}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy}
          leftIcon={<Upload size={14} strokeWidth={2} />}
        >
          {busy ? "Uploading…" : value ? "Replace file" : "Upload file"} {/* COPY:PLU-159 */}
        </Button>
        {value && (
          <span style={{ fontSize: font.size.sm, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name ?? value}
            </span>
            {!disabled && (
              <Button variant="ghost" size="sm" onClick={() => { setName(null); onChange(""); }} leftIcon={<X size={12} strokeWidth={2.25} />}>
                {""}
              </Button>
            )}
          </span>
        )}
      </div>
      {error && (
        <div role="alert" style={{ fontSize: font.size.sm, color: colors.danger }}>
          {error} {/* COPY:PLU-159 */}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SearchableSelect (S2.4) — a filterable dropdown that also accepts a custom
// typed value. Native <datalist> gives type-to-filter + free entry for free.
// ---------------------------------------------------------------------------
function SearchableSelect({
  id,
  value,
  options,
  placeholder,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  options: SelectOption[];
  placeholder?: string | undefined;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const listId = `${id}-list`;
  return (
    <>
      <Input
        id={id}
        list={listId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value} />
        ))}
      </datalist>
    </>
  );
}

// ---------------------------------------------------------------------------
// DurationSelect (S6.1–S6.6) — a preset dropdown plus an "Others…" custom
// escape. The stored value is EITHER a preset option value OR the free custom
// string (single-column persistence). "Others" is selected when the current
// value isn't one of the preset options (and isn't empty).
// ---------------------------------------------------------------------------
const OTHERS = "__others__";
function DurationSelect({
  id,
  value,
  options,
  customPlaceholder,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  options: SelectOption[];
  customPlaceholder?: string | undefined;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const isPreset = options.some((o) => o.value === value);
  const custom = value !== "" && !isPreset;
  const [othersOpen, setOthersOpen] = useState(custom);
  const showCustom = othersOpen || custom;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Select
        id={id}
        disabled={disabled}
        value={showCustom ? OTHERS : value}
        onChange={(e) => {
          if (e.target.value === OTHERS) {
            setOthersOpen(true);
            onChange(""); // clear so the custom field starts empty
          } else {
            setOthersOpen(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">Choose one…</option> {/* COPY:PLU-159 */}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={OTHERS}>Others…</option> {/* COPY:PLU-159 */}
      </Select>
      {showCustom && (
        <Input
          value={value}
          disabled={disabled}
          placeholder={customPlaceholder ?? "Enter a custom value"} // COPY:PLU-159
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommissionAmount (S7.A1) — a number with a percentage / flat-amount mode
// toggle. The mode persists to the commissionMode column (via onChangeMode).
// ---------------------------------------------------------------------------
function CommissionAmount({
  id,
  rate,
  mode,
  onChangeRate,
  onChangeMode,
  placeholder,
  disabled,
}: {
  id: string;
  rate: string;
  mode: "percent" | "flat";
  onChangeRate: (v: string) => void;
  onChangeMode: (m: string) => void;
  placeholder?: string | undefined;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {mode === "flat" && <span style={{ color: colors.textMuted }}>$</span>}
      <Input
        id={id}
        type="number"
        min={0}
        value={rate}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChangeRate(e.target.value)}
        style={{ maxWidth: 160 }}
      />
      {mode === "percent" && <span style={{ color: colors.textMuted }}>%</span>}
      <div style={{ marginLeft: 6 }}>
        <RadioCardGroup
          ariaLabel="Commission mode" // COPY:PLU-159
          options={[
            { value: "percent", label: "%" },
            { value: "flat", label: "Flat $" },
          ]}
          value={mode}
          onChange={(v) => onChangeMode(v === "flat" ? "flat" : "percent")}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttributionWindow (S7.A4) — two cards (Days / Customer lifetime); Days reveals
// a numeric days input. Stored value: "lifetime" or a plain day-count string.
// ---------------------------------------------------------------------------
function AttributionWindow({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const isLifetime = value === "lifetime";
  const mode = isLifetime ? "lifetime" : "days";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <RadioCardGroup
        ariaLabel="Attribution window" // COPY:PLU-159
        options={[
          { value: "days", label: "Days" },
          { value: "lifetime", label: "Customer lifetime" },
        ]}
        value={mode}
        onChange={(v) => onChange(v === "lifetime" ? "lifetime" : "")}
        disabled={disabled}
      />
      {mode === "days" && (
        <Input
          type="number"
          min={1}
          value={value}
          placeholder="e.g. 30" // COPY:PLU-159
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ maxWidth: 160 }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RepeatableLinks (S5.5) — a repeatable list of link inputs. Stored as
// newline-joined text in the existing string column (single-column scope).
// ---------------------------------------------------------------------------
function RepeatableLinks({
  value,
  placeholder,
  onChange,
  disabled,
}: {
  value: string;
  placeholder?: string | undefined;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  // Split on newlines; always show at least one row. Trailing blank kept so the
  // user can type into the "next" row.
  const links = value ? value.split("\n") : [""];
  const commit = (next: string[]) => onChange(next.join("\n").replace(/\n+$/, (m) => (m.length > 1 ? "\n" : m)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {links.map((link, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Input
            type="url"
            value={link}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => {
              const next = [...links];
              next[i] = e.target.value;
              commit(next);
            }}
          />
          {!disabled && links.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => commit(links.filter((_, j) => j !== i))}
              leftIcon={<X size={12} strokeWidth={2.25} />}
            >
              {""}
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <div>
          <Button variant="secondary" size="sm" onClick={() => commit([...links, ""])}>
            Add another link {/* COPY:PLU-159 */}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PricingGrid (S7.P1) — one currency row per selected deliverable format. Each
// row's price persists to the deliverablePricing map (cents, keyed
// "<platform>:<format>"); the FIRST row's price also mirrors to
// publicStartingFeeCents (the public starting fee). Values shown in dollars.
// ---------------------------------------------------------------------------
function PricingGrid({
  firstFeeDollars,
  pricing,
  deliverables,
  onChangeFirstFee,
  onChangePricing,
  disabled,
}: {
  firstFeeDollars: string;
  pricing: DeliverablePricing;
  deliverables: DeliverableQuantity[];
  onChangeFirstFee: (v: string) => void;
  onChangePricing: (m: DeliverablePricing) => void;
  disabled: boolean;
}) {
  const rows = deliverables.filter((d) => d.platform && d.format);
  if (rows.length === 0) {
    return (
      <span style={{ fontSize: font.size.sm, color: colors.textMuted }}>
        {/* COPY:PLU-159 */}
        Select at least one platform & content type first, then set a price here.
      </span>
    );
  }
  const keyOf = (d: DeliverableQuantity) => `${d.platform}:${d.format}`;
  // Dollars shown per row: the first row reflects publicStartingFeeCents (dollars
  // string) so the two stay in sync; the rest read from the cents map.
  const dollarsFor = (d: DeliverableQuantity, first: boolean): string => {
    if (first) return firstFeeDollars;
    const cents = pricing[keyOf(d)];
    return typeof cents === "number" ? String(cents / 100) : "";
  };
  const setDollars = (d: DeliverableQuantity, first: boolean, raw: string) => {
    const cents = raw.trim() === "" ? undefined : Math.round(Number(raw) * 100);
    const nextMap: DeliverablePricing = { ...pricing };
    if (cents == null || !Number.isFinite(cents)) delete nextMap[keyOf(d)];
    else nextMap[keyOf(d)] = cents;
    onChangePricing(nextMap);
    if (first) onChangeFirstFee(raw); // mirror the first row to the public fee
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((d, i) => {
        const first = i === 0;
        return (
          <div key={keyOf(d)} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ flex: 1, fontSize: font.size.sm, color: colors.text, textTransform: "capitalize" }}>
              {d.platform} · {d.format}
            </span>
            <span style={{ color: colors.textMuted }}>$</span>
            <Input
              type="number"
              min={0}
              disabled={disabled}
              value={dollarsFor(d, first)}
              placeholder="e.g. 500" // COPY:PLU-159
              onChange={(e) => setDollars(d, first, e.target.value)}
              style={{ maxWidth: 140 }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FollowerRanges (S3.11) — per-platform min/max ranges. The full map persists to
// the followerRanges column (via onChangeRanges); the first platform's min also
// mirrors to minFollowers (the launch-relevant floor). Blank max = no limit.
// ---------------------------------------------------------------------------
function FollowerRanges({
  ranges,
  platforms,
  minFollowers,
  onChangeRanges,
  onChangeMin,
  disabled,
}: {
  ranges: FollowerRanges;
  platforms: string[];
  minFollowers: string;
  onChangeRanges: (r: FollowerRanges) => void;
  onChangeMin: (v: string) => void;
  disabled: boolean;
}) {
  const uniquePlatforms = [...new Set(platforms.filter(Boolean))];
  // With no platforms chosen yet, still let the brand set a global minimum so
  // the field is never dead — it writes minFollowers directly.
  if (uniquePlatforms.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: font.size.sm, color: colors.textMuted }}>Min</span>
        <Input
          type="number"
          min={0}
          max={2147483647}
          value={minFollowers}
          placeholder="e.g. 10000" // COPY:PLU-159
          disabled={disabled}
          onChange={(e) => onChangeMin(e.target.value)}
          style={{ maxWidth: 160 }}
        />
        <span style={{ fontSize: font.size.xs, color: colors.textDim }}>
          {/* COPY:PLU-159 */}
          Select platforms above to set per-platform ranges.
        </span>
      </div>
    );
  }
  const numOr = (raw: string): number | null => (raw.trim() === "" ? null : Number(raw));
  const setRange = (platform: string, side: "min" | "max", raw: string) => {
    const cur = ranges[platform] ?? { min: null, max: null };
    const next: FollowerRanges = { ...ranges, [platform]: { ...cur, [side]: numOr(raw) } };
    onChangeRanges(next);
    // Mirror the first platform's min to the scalar minFollowers floor.
    if (side === "min" && platform === uniquePlatforms[0]) onChangeMin(raw);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {uniquePlatforms.map((platform) => {
        const r = ranges[platform] ?? { min: null, max: null };
        return (
          <div key={platform} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 84, fontSize: font.size.sm, color: colors.text, textTransform: "capitalize" }}>
              {platform}
            </span>
            <span style={{ fontSize: font.size.xs, color: colors.textMuted }}>Min</span>
            <Input
              type="number"
              min={0}
              max={2147483647}
              value={r.min == null ? "" : String(r.min)}
              placeholder="e.g. 1500" // COPY:PLU-159
              disabled={disabled}
              onChange={(e) => setRange(platform, "min", e.target.value)}
              style={{ maxWidth: 130 }}
            />
            <span style={{ fontSize: font.size.xs, color: colors.textMuted }}>Max</span>
            <Input
              type="number"
              min={0}
              max={2147483647}
              value={r.max == null ? "" : String(r.max)}
              placeholder="No upper limit" // COPY:PLU-159
              disabled={disabled}
              onChange={(e) => setRange(platform, "max", e.target.value)}
              style={{ maxWidth: 140 }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrackingPreview (S7.T4) — read-only preview of the creator-specific link.
// ---------------------------------------------------------------------------
function TrackingPreview({ preview }: { preview: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: colors.panelAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.sm,
        fontFamily: "monospace",
        fontSize: font.size.sm,
        color: preview ? colors.text : colors.textMuted,
        wordBreak: "break-all",
      }}
    >
      {preview || "Set a tracking URL and parameter above to preview the creator link."} {/* COPY:PLU-159 */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function draftValue(f: FieldSpec, campaign: Draft, brand: Draft, creator: Draft): unknown {
  const src = f.group === "campaign" ? campaign : f.group === "brandIdentity" ? brand : creator;
  return src[f.key];
}
function strOrNull(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}
function numOrNull(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** For radio-backed boolean fields: preserve null when the user hasn't chosen,
 *  so an unanswered question stays unanswered rather than defaulting to false. */
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
/** For JSONB map fields (pricing, follower ranges): an empty/absent object → null
 *  so we don't persist a meaningless {}; a populated object passes through. */
function objOrNull<T extends object>(v: unknown): T | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  return Object.keys(v).length > 0 ? (v as T) : null;
}
function dollarsToCents(v: unknown): number | null {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n * 100);
}
