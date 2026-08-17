// ---------------------------------------------------------------------------
// PLU-140 (2b) — Review & Approve (worksheet Page 9 + Stage-1 approval checkpoint)
// ---------------------------------------------------------------------------
// The terminal step of the Stage-1 intake — an APPROVAL checkpoint, not the
// point the campaign launches. Two clearly-separated panels:
//   • PUBLIC (S9.1)  — "What creators will see": renders ONLY CampaignDetails
//     public fields. Never renders a NegotiationPolicy field (privacy boundary).
//   • PRIVATE (S9.3) — "What Pluvus may negotiate privately": lock-labeled,
//     "Creators will never see this". Renders the policy fields.
// Below them: the lifecycle explanation, the readiness blockers (each linking
// back to its section), and the two approval checkboxes (S9.5 public + S9.6
// private) that persist the single compensationReviewStatus flag. Approving
// does NOT call POST /launch — the campaign stays DRAFT, stays fully editable,
// and stays unsnapshotted. A material edit to any approved term (campaign or
// policy field) automatically resets the flag to NEEDS_REVIEW and re-opens this
// checkpoint (CampaignIntake.tsx's setField), so re-approval is required before
// the terms can be considered current again. The brand can now move on to
// Workflow Building (already reachable independently from the campaign list)
// without losing the ability to come back and adjust deliverables, dates,
// compensation, etc.
//
// The actual DRAFT→ACTIVE transition (POST /launch, freezing the immutable
// CampaignTermsSnapshot/NegotiationPolicySnapshot pair) is intentionally NOT
// triggered from here. It remains a real, working backend service
// (db/campaigns.ts launchCampaign(), routes/campaigns.ts POST /:id/launch,
// web/src/api/builderClient.ts launchCampaign()) — this page just stops being
// the thing that calls it. Wiring an actual "ready to run" trigger (after
// Workflow Building / Creator Sourcing) is separate, later work; readOnly here
// still renders the correct frozen state for a campaign that IS already ACTIVE
// (e.g. launched through an earlier flow or an ops tool), it's just no longer
// reachable by clicking anything on this page.
//
// COPY: user-facing strings are placeholder pending PLU-159 (marked
// // COPY:PLU-159); the worksheet Page-9 copy is used verbatim where it exists.

import { useMemo, useState } from "react";
import { Lock, Check, Copy } from "lucide-react";
import { colors, radii, font, text } from "../../../theme";
import { Button, Card, Badge, useToast } from "../../ds";
import { useNegotiationPolicy, useReadiness } from "../../../api/builderClient";
import type { CampaignDetail } from "../../../api/builderTypes";
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
   *  approval boxes are checked (§S4 one-flag reconciliation), else NEEDS_REVIEW.
   *  This is the ONLY thing approving does — it never launches the campaign. */
  onConfirmReview: (confirmed: boolean) => void;
  /** Duplicate-as-new-campaign (material change after the campaign went ACTIVE
   *  through some other path). */
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
  reviewActivate: "Review & approve",
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
  onDuplicate,
  duplicating,
}: Props) {
  const toast = useToast();
  const readinessQ = useReadiness(campaignId);
  const policyQ = useNegotiationPolicy(campaignId);
  const policy = policyQ.data ?? {};

  // Two approvals (S9.5 public, S9.6 private). Only ONE persisted flag exists;
  // both boxes must be checked for Stage 1 to count as approved, and CONFIRMED
  // is written only when both are — the single flag means "both approved"
  // (§S4 reconciliation). Seed from the persisted flag so a re-open of an
  // already-CONFIRMED campaign shows both checked.
  const alreadyConfirmed = campaign.compensationReviewStatus === "CONFIRMED";
  const [approvePublic, setApprovePublic] = useState(alreadyConfirmed);
  const [approvePrivate, setApprovePrivate] = useState(alreadyConfirmed);

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
  // "ready" reuses computeReadiness — the same compensation-completeness check
  // launchCampaign() enforces. Reused here as a Stage-1 sanity gate (you
  // shouldn't be able to approve compensation terms that are internally
  // inconsistent/incomplete), not because approving triggers that launch.
  const ready = readinessQ.data?.ready === true;

  // Keep the persisted flag in step with the checkboxes: CONFIRMED only when both
  // are checked, else NEEDS_REVIEW. Called on each toggle — approving is just
  // this flag write, nothing else. The campaign stays DRAFT and fully editable;
  // a later material edit to any approved term flips it back to NEEDS_REVIEW
  // automatically (CampaignIntake.tsx's setField), so re-approval is required
  // before the terms are current again.
  const syncReview = (nextPublic: boolean, nextPrivate: boolean) => {
    onConfirmReview(nextPublic && nextPrivate);
  };

  const handleApprove = () => {
    // The checkboxes above already persisted CONFIRMED the moment both were
    // checked (syncReview) — this is a deliberate, visible confirmation of
    // that state for the brand, not a separate write. No POST /launch: Stage 1
    // approval and campaign activation are different actions on different
    // timelines (activation happens once the campaign is actually ready to
    // run, after Workflow Building).
    onConfirmReview(true);
    toast.success("Stage 1 approved. You can keep editing — a material change will re-open this checkpoint."); // COPY:PLU-159
  };

  // Only a genuinely ACTIVE campaign (launched through some other path) shows
  // the frozen state — approving here never causes that by itself.
  const isLive = readOnly;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {isLive ? (
        <SuccessPanel onDuplicate={onDuplicate} duplicating={duplicating} />
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
            Approving confirms these terms for now — the campaign stays a Draft and everything above
            stays editable. Next up: build the outreach workflow. If you come back and change a
            deliverable, date, compensation term, or anything else here, this checkpoint re-opens and
            needs approving again. Nothing is locked or snapshotted until the campaign is actually
            ready to launch and run.
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
                  ? "1 thing to fix before you can approve" // COPY:PLU-159
                  : `${readinessQ.data.blockers.length} things to fix before you can approve`}
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

          {/* Approvals (S9.5 public + S9.6 private) — both gate Stage-1 approval. */}
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

          {/* Approve Stage 1 — persists compensationReviewStatus only (no
              POST /launch). Disabled until ready AND both approved; an
              accessible reason names what's missing. Re-clickable any time
              (e.g. after a material edit re-opened this checkpoint). */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Button
              variant="primary"
              onClick={handleApprove}
              disabled={!ready || !bothApproved}
              aria-disabled={!ready || !bothApproved}
            >
              Approve Stage 1 {/* COPY:PLU-159 */}
            </Button>
            {(!ready || !bothApproved) && (
              <span style={{ ...text.caption }}>
                {/* COPY:PLU-159 — accessible reason for the disabled action. */}
                {!ready
                  ? "Resolve the items above first."
                  : "Check both approvals to continue."}
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
  onDuplicate,
  duplicating,
}: {
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
      <div style={{ ...text.caption, display: "flex", alignItems: "center", gap: 6, color: colors.textMuted }}>
        <Lock size={13} strokeWidth={2} aria-hidden /> Locked. {/* COPY:PLU-159 */}
      </div>
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
