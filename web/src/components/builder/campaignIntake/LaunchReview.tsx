// ---------------------------------------------------------------------------
// PLU-140 (2b) — Review & Activate (worksheet Page 9 + Final activation checkpoint)
// ---------------------------------------------------------------------------
// The terminal step of the Stage-1 intake. Two clearly-separated panels:
//   • PUBLIC (S9.1)  — "What creators will see": renders ONLY CampaignDetails
//     public fields. Never renders a NegotiationPolicy field (privacy boundary).
//   • PRIVATE (S9.3) — "What Pluvus may negotiate privately": lock-labeled,
//     "Creators will never see this". Renders the policy fields.
// Below them: the lifecycle/lock explanation, the readiness blockers (each
// linking back to its section), the two approval checkboxes (S9.5 public +
// S9.6 private) that gate Activate, and the authoritative Activate action
// (POST /launch, the ONE DRAFT→ACTIVE service). Post-launch (readOnly) it shows
// a frozen locked state with Duplicate-as-new-campaign and no Activate.
//
// COPY: user-facing strings are placeholder pending PLU-159 (marked
// // COPY:PLU-159); the worksheet Page-9 copy is used verbatim where it exists.

import { useMemo, useState } from "react";
import { Lock, Check, Copy } from "lucide-react";
import { colors, radii, font, text } from "../../../theme";
import { Button, Card, Badge, useToast } from "../../ds";
import {
  useNegotiationPolicy,
  useReadiness,
  launchCampaign,
  LaunchError,
} from "../../../api/builderClient";
import type { CampaignDetail, LaunchResult } from "../../../api/builderTypes";
import {
  getSection,
  visibleFields,
  blockerSection,
  type CompensationShape,
  type SectionKey,
} from "./sections";

interface Props {
  campaignId: string;
  campaign: CampaignDetail;
  readOnly: boolean;
  /** Jump back to a section to edit it (S9.2 / S9.4 edit links). */
  onEditSection: (key: SectionKey) => void;
  /** Persist the single compensationReviewStatus flag — CONFIRMED only when BOTH
   *  approval boxes are checked (§S4 one-flag reconciliation), else NEEDS_REVIEW. */
  onConfirmReview: (confirmed: boolean) => void;
  /** Launch succeeded — the shell re-reads the campaign so it flips readOnly. */
  onLaunched: (result: LaunchResult) => void;
  /** Duplicate-as-new-campaign (post-launch material change). */
  onDuplicate: () => void;
  duplicating: boolean;
}

const SECTION_LABEL: Record<SectionKey, string> = {
  startSources: "Start & sources",
  campaignProduct: "Campaign & product",
  platformsDeliverables: "Platforms & deliverables",
  contentGuidelines: "Content guidelines",
  timelineRights: "Timeline & rights",
  rewardStructure: "Reward structure",
  negotiationSettings: "Private negotiation settings",
  reviewActivate: "Review & activate",
}; // COPY:PLU-159

// The public creator-facing fields shown in the S9.1 preview, grouped by their
// origin section (drives the per-section Edit link). ONLY CampaignDetails public
// columns — never a policy field. `fmt` renders the raw value for display.
interface PublicRow {
  label: string; // COPY:PLU-159
  value: string;
  section: SectionKey;
}

function dollars(cents: number | null | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toLocaleString()}` : "—";
}
function show(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export function LaunchReview({
  campaignId,
  campaign,
  readOnly,
  onEditSection,
  onConfirmReview,
  onLaunched,
  onDuplicate,
  duplicating,
}: Props) {
  const toast = useToast();
  const readinessQ = useReadiness(campaignId);
  const policyQ = useNegotiationPolicy(campaignId);
  const policy = policyQ.data ?? {};

  // Two approvals (S9.5 public, S9.6 private). Only ONE persisted flag exists;
  // both boxes must be checked to enable Activate, and CONFIRMED is written only
  // when both are — the single flag means "both approved" (§S4 reconciliation).
  // Seed from the persisted flag so a re-open of an already-CONFIRMED campaign
  // shows both checked.
  const alreadyConfirmed = campaign.compensationReviewStatus === "CONFIRMED";
  const [approvePublic, setApprovePublic] = useState(alreadyConfirmed);
  const [approvePrivate, setApprovePrivate] = useState(alreadyConfirmed);

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<LaunchResult | null>(null);

  const comp: CompensationShape = useMemo(
    () => ({
      campaignType: campaign.campaignType ?? "PAID",
      includesGifting: Boolean(campaign.includesGifting),
      priceStrategy: campaign.priceStrategy ?? "REQUEST_RATE_CARD",
      giftDeliveryMethod: campaign.giftDeliveryMethod ?? "",
      selectedPlatforms: Array.isArray(campaign.deliverableQuantities)
        ? [...new Set(campaign.deliverableQuantities.map((r) => r.platform).filter(Boolean))]
        : [],
      shipsPhysicalProduct: Boolean(campaign.shipsPhysicalProduct),
    }),
    [campaign],
  );

  // Public preview rows — a curated projection of CampaignDetails public fields.
  const publicRows: PublicRow[] = useMemo(() => {
    const rows: PublicRow[] = [
      { label: "Objective", value: show(campaign.objective), section: "campaignProduct" },
      { label: "Product / offer", value: show(campaign.productName || campaign.rewardDescription), section: "campaignProduct" },
      { label: "Deliverables", value: show(campaign.deliverables), section: "platformsDeliverables" },
      { label: "Timeline", value: show(campaign.timeline), section: "timelineRights" },
      { label: "Usage rights", value: show(campaign.usageRights), section: "timelineRights" },
      { label: "Exclusivity", value: show(campaign.exclusivity), section: "timelineRights" },
      { label: "Compensation structure", value: show(campaign.campaignType), section: "rewardStructure" },
    ];
    if (campaign.publicStartingFeeCents != null) {
      rows.push({ label: "Public starting fee", value: dollars(campaign.publicStartingFeeCents), section: "rewardStructure" });
    }
    if (campaign.publicCommissionRate != null) {
      rows.push({ label: "Public commission", value: `${campaign.publicCommissionRate}%`, section: "rewardStructure" });
    }
    return rows;
  }, [campaign]);

  // Private policy rows — visible policy fields for this structure, read from the
  // policy row. Lock-labeled; never creator-facing.
  const privateRows = useMemo(() => {
    const section = getSection("negotiationSettings");
    const centsKeys = new Set([
      "ceilingCents",
      "preferredFeeCents",
      "floorCents",
      "giftValueFlexibilityCents",
    ]);
    return visibleFields(section, comp)
      // PLU-140: uiOnly (disabled, unwired) fields aren't real settings — they
      // never persist, so they must not appear in the private review summary.
      .filter((f) => !f.uiOnly)
      .map((f) => {
        const raw = (policy as Record<string, unknown>)[f.key];
        let value: string;
        if (centsKeys.has(f.key)) value = dollars(raw as number | null);
        else if (Array.isArray(raw)) value = raw.length ? raw.join(", ") : "—";
        else value = show(raw);
        return { label: f.label, value };
      });
  }, [comp, policy]);

  const bothApproved = approvePublic && approvePrivate;
  const ready = readinessQ.data?.ready === true;

  // Keep the persisted flag in step with the checkboxes: CONFIRMED only when both
  // are checked, else NEEDS_REVIEW. Called on each toggle.
  const syncReview = (nextPublic: boolean, nextPrivate: boolean) => {
    onConfirmReview(nextPublic && nextPrivate);
  };

  const doLaunch = async () => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await launchCampaign(campaignId);
      setLaunched(result);
      toast.success("Campaign activated."); // COPY:PLU-159
      onLaunched(result);
    } catch (err) {
      // 409 (needs confirm) / 422 (incomplete, carries `missing`) / other. The
      // draft is untouched — nothing entered is lost, and no partial ACTIVE
      // (the backend launch is atomic).
      const msg =
        err instanceof LaunchError
          ? err.missing && err.missing.length > 0
            ? `${err.message} — missing: ${err.missing.join(", ")}`
            : err.message
          : err instanceof Error
            ? err.message
            : "Activation failed";
      setLaunchError(msg);
      toast.error(`Couldn't activate: ${msg}`); // COPY:PLU-159
    } finally {
      setLaunching(false);
    }
  };

  // Post-launch (readOnly) OR a just-succeeded launch → frozen success state.
  const isLive = readOnly || launched != null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {isLive ? (
        <SuccessPanel
          launched={launched}
          campaign={campaign}
          onDuplicate={onDuplicate}
          duplicating={duplicating}
        />
      ) : (
        <>
          {/* Public panel — S9.1 / S9.2 */}
          <Panel
            title="What creators will see" // COPY:PLU-159 (S9.1)
            subtitle="This is the public Campaign Brief. Creators may see these terms." // COPY:PLU-159
          >
            {publicRows.map((r) => (
              <ReviewRow key={r.label} label={r.label} value={r.value}>
                <EditLink onClick={() => onEditSection(r.section)} />
              </ReviewRow>
            ))}
          </Panel>

          {/* Private panel — S9.3 / S9.4. Lock-labeled; explicitly internal. */}
          <Panel
            title="What Pluvus may negotiate privately" // COPY:PLU-159 (S9.3)
            subtitle="Creators will never see this." // COPY:PLU-159 (S9.3 verbatim)
            locked
          >
            {privateRows.map((r) => (
              <ReviewRow key={r.label} label={r.label} value={r.value}>
                {null}
              </ReviewRow>
            ))}
            <div style={{ marginTop: 8 }}>
              <EditLink label="Edit private negotiation settings" onClick={() => onEditSection("negotiationSettings")} />
            </div>
          </Panel>

          {/* Lifecycle / lock explanation. */}
          <div
            style={{
              padding: "12px 14px",
              background: colors.panelAlt,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              ...text.caption,
              color: colors.textMuted,
            }}
          >
            {/* COPY:PLU-159 */}
            Activating moves this campaign from Draft to Active. It creates one immutable public
            snapshot (CampaignTermsSnapshot) and one private snapshot (NegotiationPolicySnapshot).
            After activation these material terms can’t change — a material change means duplicating
            this campaign into a new Draft.
          </div>

          {/* Readiness blockers — S9 missing-field warnings, each linking to its section. */}
          {readinessQ.isLoading ? (
            <p style={{ ...text.caption }}>Checking readiness…{/* COPY:PLU-159 */}</p>
          ) : readinessQ.data && readinessQ.data.blockers.length > 0 ? (
            <div
              role="alert"
              style={{
                padding: "12px 14px",
                background: `${colors.danger}12`,
                border: `1px solid ${colors.danger}55`,
                borderRadius: radii.sm,
              }}
            >
              <div style={{ ...text.label, color: colors.danger, marginBottom: 8 }}>
                {readinessQ.data.blockers.length === 1
                  ? "1 thing to fix before you can activate" // COPY:PLU-159
                  : `${readinessQ.data.blockers.length} things to fix before you can activate`}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                {readinessQ.data.blockers.map((b) => {
                  const sec = blockerSection(b);
                  return (
                    <li key={b} style={{ fontSize: font.size.sm, color: colors.text }}>
                      {b}{" "}
                      <button
                        onClick={() => onEditSection(sec)}
                        className="ds-focusable"
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: colors.accent,
                          cursor: "pointer",
                          fontSize: font.size.sm,
                          textDecoration: "underline",
                        }}
                      >
                        Fix in {SECTION_LABEL[sec]} {/* COPY:PLU-159 */}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div style={{ ...text.caption, color: colors.success, display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={14} strokeWidth={2.5} aria-hidden /> Everything required is in place.{/* COPY:PLU-159 */}
            </div>
          )}

          {/* Approvals (S9.5 public + S9.6 private) — both gate Activate. */}
          <Card variant="flat" padding={18} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <ApproveCheckbox
              checked={approvePublic}
              label="Approve public Campaign Brief" // COPY:PLU-159 (S9.5)
              hint="Confirms the public terms creators may see." // COPY:PLU-159
              onChange={(v) => {
                setApprovePublic(v);
                syncReview(v, approvePrivate);
              }}
            />
            <ApproveCheckbox
              checked={approvePrivate}
              label="Approve private negotiation settings" // COPY:PLU-159 (S9.6)
              hint="Confirms the private authority Pluvus may use. Never merged into the public brief." // COPY:PLU-159
              onChange={(v) => {
                setApprovePrivate(v);
                syncReview(approvePublic, v);
              }}
            />
          </Card>

          {launchError && (
            <div
              role="alert"
              style={{
                padding: "10px 14px",
                background: `${colors.danger}12`,
                border: `1px solid ${colors.danger}55`,
                borderRadius: radii.sm,
                color: colors.danger,
                fontSize: font.size.sm,
              }}
            >
              {launchError} {/* COPY:PLU-159 — data is preserved; fix and retry. */}
            </div>
          )}

          {/* Activate — the authoritative POST /launch. Disabled until ready AND
              both approved; an accessible reason names what's missing. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Button
              variant="primary"
              onClick={() => void doLaunch()}
              disabled={!ready || !bothApproved || launching}
              aria-disabled={!ready || !bothApproved || launching}
            >
              {launching ? "Activating…" : "Activate campaign"} {/* COPY:PLU-159 */}
            </Button>
            {(!ready || !bothApproved) && (
              <span style={{ ...text.caption }}>
                {/* COPY:PLU-159 — accessible reason for the disabled action. */}
                {!ready
                  ? "Resolve the items above first."
                  : "Check both approvals to activate."}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Panel({
  title,
  subtitle,
  locked,
  children,
}: {
  title: string;
  subtitle: string;
  locked?: boolean;
  children: React.ReactNode;
}) {
  const headingId = `launch-panel-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <Card
      variant={locked ? "inset" : "flat"}
      padding={18}
      aria-labelledby={headingId}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        {locked && <Lock size={15} strokeWidth={2.5} aria-hidden style={{ color: colors.textMuted }} />}
        <h3 id={headingId} style={{ ...text.title, fontSize: font.size.lg, margin: 0 }}>
          {title}
        </h3>
        {locked && (
          <Badge color={colors.textMuted} small>
            Private {/* COPY:PLU-159 */}
          </Badge>
        )}
      </div>
      <p style={{ ...text.caption, margin: "0 0 12px" }}>{subtitle}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </Card>
  );
}

function ReviewRow({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
      <div style={{ ...text.label, width: 190, flexShrink: 0, color: colors.textMuted }}>{label}</div>
      <div style={{ flex: 1, fontSize: font.size.md, color: colors.text, wordBreak: "break-word" }}>{value}</div>
      {children}
    </div>
  );
}

function EditLink({ onClick, label = "Edit" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="ds-focusable"
      style={{
        background: "none",
        border: "none",
        padding: 0,
        color: colors.accent,
        cursor: "pointer",
        fontSize: font.size.sm,
        flexShrink: 0,
      }}
    >
      {label} {/* COPY:PLU-159 */}
    </button>
  );
}

function ApproveCheckbox({
  checked,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <span>
        <span style={{ fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.text }}>{label}</span>
        <span style={{ display: "block", ...text.caption }}>{hint}</span>
      </span>
    </label>
  );
}

function SuccessPanel({
  launched,
  campaign,
  onDuplicate,
  duplicating,
}: {
  launched: LaunchResult | null;
  campaign: CampaignDetail;
  onDuplicate: () => void;
  duplicating: boolean;
}) {
  return (
    <Card variant="flat" padding={22} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Badge color={colors.success} dot>
          Active {/* COPY:PLU-159 */}
        </Badge>
        <span style={{ ...text.title, fontSize: font.size.lg }}>Campaign activated{/* COPY:PLU-159 */}</span>
      </div>
      <p style={{ ...text.body, margin: 0 }}>
        {/* COPY:PLU-159 */}
        This campaign is live. Its public and private terms are frozen into immutable snapshots and
        can no longer be edited. To change material terms, duplicate it into a new Draft.
      </p>
      {launched && (
        <div style={{ ...text.caption, display: "flex", flexDirection: "column", gap: 4 }}>
          <span>Launched at: {new Date(launched.launchedAt).toLocaleString()}</span>
          <span>Snapshot id: <code>{launched.campaignTermsSnapshotId}</code></span>
        </div>
      )}
      {!launched && campaign.status === "ACTIVE" && (
        <div style={{ ...text.caption, display: "flex", alignItems: "center", gap: 6, color: colors.textMuted }}>
          <Lock size={13} strokeWidth={2} aria-hidden /> Locked — activated in an earlier session.{/* COPY:PLU-159 */}
        </div>
      )}
      <div>
        <Button
          variant="secondary"
          onClick={onDuplicate}
          disabled={duplicating}
          leftIcon={<Copy size={14} strokeWidth={2} />}
        >
          {duplicating ? "Duplicating…" : "Duplicate as new campaign"} {/* COPY:PLU-159 */}
        </Button>
      </div>
    </Card>
  );
}
