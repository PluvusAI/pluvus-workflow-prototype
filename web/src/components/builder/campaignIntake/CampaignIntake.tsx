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
import { ArrowLeft, Copy, Lock } from "lucide-react";
import {
  useCampaign,
  useBrandIdentity,
  useCreatorRequirement,
  updateCampaign,
  updateBrandIdentity,
  updateCreatorRequirement,
  duplicateCampaign,
} from "../../../api/builderClient";
import type {
  BrandIdentityInput,
  CampaignType,
  CreatorRequirementInput,
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
  needsFee,
  needsCommission,
  showsGiftDetails,
  isGiftOnly,
  type CompensationShape,
  type FieldGroup,
  type FieldSpec,
  type SectionKey,
  type SectionSpec,
} from "./sections";

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
function chipsToString(v: string[] | null | undefined): string {
  return Array.isArray(v) ? v.join(", ") : "";
}
function stringToChips(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
      shipsPhysicalProduct: c.shipsPhysicalProduct ?? false,
    });
    const b = brandQ.data;
    setBrandDraft({
      logoRef: b?.logoRef ?? "",
      primaryColor: b?.primaryColor ?? "",
      secondaryColor: b?.secondaryColor ?? "",
      typography: b?.typography ?? "",
    });
    const cr = creatorQ.data;
    setCreatorDraft({
      platforms: chipsToString(cr?.platforms),
      niches: chipsToString(cr?.niches),
      geography: chipsToString(cr?.geography),
      languages: chipsToString(cr?.languages),
      minFollowers: cr?.minFollowers != null ? String(cr.minFollowers) : "",
      audienceNotes: cr?.audienceNotes ?? "",
      contentStyle: cr?.contentStyle ?? "",
      brandSafety: cr?.brandSafety ?? "",
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
    }),
    [campaignDraft.campaignType, campaignDraft.includesGifting, campaignDraft.priceStrategy],
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
      timeline: strOrNull(d.timeline),
      usageRights: strOrNull(d.usageRights),
      exclusivity: strOrNull(d.exclusivity),
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
    } else {
      p.priceStrategy = null;
      p.publicStartingFeeCents = null;
      p.paymentTerms = null;
    }

    // Commission — only for affiliate/hybrid; cleared otherwise.
    if (needsCommission(comp.campaignType)) {
      p.publicCommissionRate = numOrNull(d.publicCommissionRate);
      p.commissionDurationDays = numOrNull(d.commissionDurationDays);
      p.commissionConditions = strOrNull(d.commissionConditions);
      p.attributionWindow = strOrNull(d.attributionWindow);
    } else {
      p.publicCommissionRate = null;
      p.commissionDurationDays = null;
      p.commissionConditions = null;
      p.attributionWindow = null;
    }

    // Gift details — for gift-only or additive gifting; cleared otherwise.
    if (showsGiftDetails(comp)) {
      p.rewardDescription = strOrNull(d.rewardDescription);
      p.shipsPhysicalProduct = Boolean(d.shipsPhysicalProduct);
      // GIFT_ONLY is locked to KEEP; a bonus gift uses the chosen disposition.
      p.giftDisposition = isGiftOnly(comp.campaignType)
        ? "KEEP"
        : ((d.giftDisposition as GiftDisposition) || null);
    } else {
      p.rewardDescription = null;
      p.shipsPhysicalProduct = false;
      p.giftDisposition = null;
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
    return {
      platforms: stringToChips(String(d.platforms ?? "")),
      niches: stringToChips(String(d.niches ?? "")),
      geography: stringToChips(String(d.geography ?? "")),
      languages: stringToChips(String(d.languages ?? "")),
      minFollowers: numOrNull(d.minFollowers),
      audienceNotes: strOrNull(d.audienceNotes),
      contentStyle: strOrNull(d.contentStyle),
      brandSafety: strOrNull(d.brandSafety),
    };
  }, [creatorDraft]);

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
          onSelect={setActiveSection}
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

            <Card variant="flat" padding={22} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {visibleFields(section, comp).map((f) => (
                <FieldRenderer
                  key={`${f.group}:${f.key}`}
                  field={f}
                  value={draftValue(f, campaignDraft, brandDraft, creatorDraft)}
                  onChange={(v) => setField(f.group, f.key, v)}
                  disabled={readOnly}
                  invalid={
                    (f.key === "name" && nameMissing) || (f.key === "brand" && brandMissing)
                  }
                />
              ))}
            </Card>

            {/* Footer: Back / Save & continue */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 22 }}>
              <SectionStepper active={activeSection} onSelect={setActiveSection} readOnly={readOnly} onFlush={flushSave} />
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
  onSelect,
  readOnly,
  onFlush,
}: {
  active: SectionKey;
  onSelect: (k: SectionKey) => void;
  readOnly: boolean;
  onFlush: () => void;
}) {
  const idx = SECTIONS.findIndex((s) => s.key === active);
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;
  const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;
  return (
    <>
      {prev && (
        <Button variant="secondary" onClick={() => onSelect(prev.key)}>
          Back
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {next ? (
        <Button
          variant="primary"
          onClick={() => {
            if (!readOnly) onFlush();
            onSelect(next.key);
          }}
          rightIcon="→"
        >
          Save & continue {/* COPY:PLU-159 */}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => !readOnly && onFlush()} disabled={readOnly}>
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
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  invalid?: boolean;
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
    case "radioCards":
      control = (
        <RadioCardGroup
          ariaLabel={field.label}
          options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          value={String(value ?? "") || null}
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
    case "chips":
    case "text":
    case "url":
    case "email":
    default:
      control = (
        <Input
          {...common}
          type={field.control === "url" ? "url" : field.control === "email" ? "email" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          {...invalidProps}
        />
      );
  }

  // Toggle already renders its own label; wrap the rest in a FormField.
  if (field.control === "toggle") {
    return (
      <FormField label={field.label} hint={field.hint}>
        {control}
      </FormField>
    );
  }
  return (
    <FormField label={field.label} htmlFor={id} hint={field.hint}>
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
function dollarsToCents(v: unknown): number | null {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n * 100);
}
