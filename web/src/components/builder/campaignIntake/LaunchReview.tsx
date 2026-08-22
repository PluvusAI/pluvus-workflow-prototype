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
  fixableBlockers,
  buildPublicReviewRows,
  commissionDisplay,
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
  // PLU-182 (2f.1): the shell's SHARED save state (across all groups, not
  // approval-scoped — Issue 2), surfaced next to the Approve CTA so a failed or
  // pending save is visible ON Page 9 (not just in the far-off header). The
  // status copy stays group-agnostic to avoid misattributing an unrelated
  // group's failure to the approval. `onRetry` re-runs doSave, re-sending
  // whatever failed — the natural retry surface for AC6.
  saving: boolean;
  saveError: string | null;
  onRetry: () => void;
  /** PLU-182: a material edit locally reset review to NEEDS_REVIEW, but that
   *  write hasn't landed yet (in flight, or its PATCH failed). While true the
   *  approval is NOT current no matter what the fetched campaign row says — the
   *  server row still reads CONFIRMED until the reset persists. Prevents a failed
   *  review-reset write from being masked by a stale "Approved — current." */
  reviewReopenedUnsaved: boolean;
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
  saving,
  saveError,
  onRetry,
  reviewReopenedUnsaved,
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

  // Public preview rows — the pure, complete projection of CampaignDetails
  // public fields (PLU-182). Structural-gated on `comp` so inactive conditional
  // values never surface; each row keeps its section for the Edit link. Never a
  // policy/private field (buildPublicReviewRows enforces that).
  const publicRows = useMemo(() => buildPublicReviewRows(campaign, comp), [campaign, comp]);

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

  // PLU-182 (Change 6): the public term shown beside its private boundary — only
  // when BOTH the public value and the matching private band are present, so it
  // reads as a comparison, not a stray public value in the private panel.
  const publicBesidePrivate = useMemo(() => {
    const p = policy as Record<string, unknown>;
    const pairs: { label: string; value: string }[] = [];
    // Public starting fee ↔ fee floor/ceiling band.
    if (
      campaign.publicStartingFeeCents != null &&
      (p.floorCents != null || p.ceilingCents != null)
    ) {
      pairs.push({ label: "Public starting fee (creators see)", value: dollars(campaign.publicStartingFeeCents) });
    }
    // Public commission ↔ commission floor/ceiling band.
    if (
      campaign.publicCommissionRate != null &&
      (p.commissionFloorRate != null || p.commissionCeilingRate != null)
    ) {
      // Flat commission is persisted in dollars (not cents), so reuse the shared
      // formatter — dollars() would wrongly divide by 100 here (Issue 1).
      const unit = commissionDisplay(campaign.publicCommissionRate, campaign.commissionMode);
      pairs.push({ label: "Public commission (creators see)", value: unit });
    }
    return pairs;
  }, [campaign, policy]);

  const bothApproved = approvePublic && approvePrivate;
  // PLU-182 (Bug D): gate on readiness MINUS the review-confirmed blocker, never
  // on `ready`. Server `ready` counts "Compensation review is not confirmed" as
  // a blocker — but that only clears BY approving, so gating the approve CTA on
  // `ready` is a deadlock. `fixable` = the blockers a brand must actually fix in
  // an editing section first; the CTA is enabled when those are clear + both
  // boxes checked. The same `fixable` list is what we render below, so we never
  // show "review not confirmed" as a red thing-to-fix on the page whose job is
  // to confirm it.
  const blockers = readinessQ.data?.blockers ?? [];
  const fixable = fixableBlockers(blockers);
  const canApprove = fixable.length === 0 && bothApproved;

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
    // PLU-182 (reviewer B1): a REAL, idempotent commit — NOT a toast-only. If the
    // last checkbox toggle's PATCH failed, both boxes still look checked
    // (`canApprove` true) but the server flag is still NEEDS_REVIEW; a toast-only
    // CTA would claim success with nothing persisted. Re-issuing onConfirmReview(true)
    // makes this the authoritative write AND the natural retry surface (AC6). It
    // is idempotent (CONFIRMED→CONFIRMED) and never launches: no POST /launch —
    // Stage-1 approval and activation are different actions on different timelines.
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
            {/* PLU-182 (Change 6, R7): show the PUBLIC term beside its private
                boundary "where useful" — so the brand can sanity-check the band
                against what creators see (e.g. a floor below the public fee).
                Read-only caption; no data change. */}
            {publicBesidePrivate.length > 0 && (
              <div
                style={{
                  marginTop: 4,
                  paddingTop: 10,
                  borderTop: `1px dashed ${colors.border}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {publicBesidePrivate.map((c) => (
                  <div key={c.label} style={{ ...text.caption, color: colors.textMuted }}>
                    {c.label}: <span style={{ color: colors.text }}>{c.value}</span> {/* COPY:PLU-159 */}
                  </div>
                ))}
              </div>
            )}
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

          {/* Readiness blockers — S9 missing-field warnings, each linking to its
              section. PLU-182 (Bug D): render `fixable`, not the raw blockers —
              "Compensation review is not confirmed" clears BY approving here, so
              showing it as a red thing-to-fix on the approval page is nonsensical. */}
          {readinessQ.isLoading ? (
            <p style={{ ...text.caption }}>Checking readiness…{/* COPY:PLU-159 */}</p>
          ) : fixable.length > 0 ? (
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
                {fixable.length === 1
                  ? "1 thing to fix before you can approve" // COPY:PLU-159
                  : `${fixable.length} things to fix before you can approve`}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                {fixable.map((b) => {
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
              POST /launch). Disabled until fixable blockers are clear AND both
              approved; an accessible reason names what's missing. Re-clickable
              any time (e.g. after a material edit re-opened this checkpoint).
              It's also the retry surface for a failed approval PATCH (B1/AC6). */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Button
              variant="primary"
              onClick={handleApprove}
              disabled={!canApprove}
              aria-disabled={!canApprove}
            >
              Approve Stage 1 {/* COPY:PLU-159 */}
            </Button>
            <ApprovalStatus
              canApprove={canApprove}
              bothApproved={bothApproved}
              fixableCount={fixable.length}
              confirmedCurrent={
                campaign.compensationReviewStatus === "CONFIRMED" &&
                bothApproved &&
                // PLU-182: not current if a material edit locally reopened review
                // and that reset hasn't persisted — the fetched row still reads
                // CONFIRMED, so without this a failed reset PATCH would render
                // "Approved — current" and misblame the failure on "other changes."
                !reviewReopenedUnsaved
              }
              saving={saving}
              saveError={saveError}
              onRetry={onRetry}
            />
          </div>
        </>
      )}
    </div>
  );
}

// PLU-182 (2f.1, Change 4) — the approval-persistence status line next to the
// CTA: whether the approval is persisted-current (from the refetched campaign
// row), plus the shell's shared save state (saving / failed-Retry) and the
// disabled reason, so the brand knows the real approval state ON Page 9. Approved-
// current is shown even when an unrelated group's save failed the same cycle (the
// failure is surfaced as a secondary retryable note, never masking the approval).
function ApprovalStatus({
  canApprove,
  bothApproved,
  fixableCount,
  confirmedCurrent,
  saving,
  saveError,
  onRetry,
}: {
  canApprove: boolean;
  bothApproved: boolean;
  fixableCount: number;
  confirmedCurrent: boolean;
  saving: boolean;
  saveError: string | null;
  onRetry: () => void;
}) {
  // NB: saveError/saving are the shell's SHARED state across ALL save groups, not
  // approval-scoped. Two consequences handled below:
  //  • The copy stays group-agnostic ("your changes", matching the header's
  //    generic SaveStatus) — it never claims "your approval" for an unrelated
  //    group's failure. Retry re-runs doSave, re-sending whatever failed.
  //  • Approved-current takes PRECEDENCE over a bare saveError. The campaign
  //    (approval) PATCH runs FIRST in doSave and, on success, refetches the
  //    campaign query — so `confirmedCurrent` (read from that fresh row) means the
  //    approval genuinely IS persisted, even if a LATER independent group failed
  //    in the same cycle. Letting saveError render first would hide a true
  //    Approved-current behind an unrelated failure. We show the confirmation and
  //    surface the failure as a secondary Retry note.
  const retryButton = (
    <button
      onClick={onRetry}
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
      Retry {/* COPY:PLU-159 */}
    </button>
  );

  if (confirmedCurrent) {
    // Approved-current — plus, if some OTHER group's save failed this cycle, a
    // secondary note so the failure isn't swallowed (still retryable).
    return (
      <span style={{ ...text.caption, color: colors.success, display: "flex", alignItems: "center", gap: 6 }}>
        <Check size={14} strokeWidth={2.5} aria-hidden /> Approved — current.{/* COPY:PLU-159 */}
        {saveError && (
          <span style={{ color: colors.danger, display: "inline-flex", alignItems: "center", gap: 6 }}>
            · Some other changes didn't save. {/* COPY:PLU-159 */}
            {retryButton}
          </span>
        )}
      </span>
    );
  }
  // Not confirmed-current: a failure here may BE the approval, so surface it first.
  if (saveError) {
    return (
      <span style={{ ...text.caption, color: colors.danger, display: "flex", alignItems: "center", gap: 6 }}>
        Couldn't save your changes.{/* COPY:PLU-159 */}
        {retryButton}
      </span>
    );
  }
  if (saving) {
    return <span style={{ ...text.caption }}>Saving…{/* COPY:PLU-159 */}</span>;
  }
  if (!canApprove) {
    return (
      <span style={{ ...text.caption }}>
        {/* COPY:PLU-159 — accessible reason for the disabled action. */}
        {fixableCount > 0
          ? "Resolve the items above first."
          : !bothApproved
            ? "Check both approvals to continue."
            : ""}
      </span>
    );
  }
  return null;
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
