import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, ChevronDown, FolderOpen, AlertTriangle } from "lucide-react";
import {
  useCampaigns,
  useCampaign,
  deleteCampaign,
  closeCampaign,
} from "../../api/builderClient";
import { colors, radii, font, text, formatTimestamp } from "../../theme";
import {
  Button,
  Card,
  StatusBadge,
  Badge,
  EmptyState,
  SkeletonRows,
  ConfirmDialog,
  IconButton,
  useToast,
} from "../ds";
import { CampaignWizard } from "./CampaignWizard";
import type { CampaignListItem, CampaignStatus } from "../../api/builderTypes";

// PLU-153: campaign lifecycle badge colors. Do NOT route through StatusBadge —
// it only maps workflow statuses (draft/published/archived/invalid).
const STATUS_COLOR: Record<CampaignStatus, string> = {
  DRAFT: colors.textMuted,
  ACTIVE: colors.success,
  CLOSING: colors.warning,
  ARCHIVED: colors.textMuted,
};

interface Props {
  onSelectWorkflow: (workflowId: string) => void;
}

export function CampaignList({ onSelectWorkflow }: Props) {
  const { data: campaigns, isLoading, isError, refetch } = useCampaigns();
  const [showWizard, setShowWizard] = useState(false);

  function handleCreated(workflowId: string) {
    setShowWizard(false);
    void refetch();
    onSelectWorkflow(workflowId);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      {/* Header */}
      <div style={{ flexShrink: 0, padding: "28px 32px 4px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            maxWidth: 1240,
            margin: "0 auto",
            width: "100%",
          }}
        >
          <div>
            <h1 style={{ ...text.title, margin: 0 }}>Campaigns</h1>
            <div style={{ ...text.body, marginTop: 4 }}>
              Create and manage creator outreach campaigns
            </div>
          </div>
          <Button variant="primary" onClick={() => setShowWizard(true)} leftIcon="+">
            New Campaign
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="ds-fade-in" style={{ flex: 1, overflow: "auto", padding: "20px 32px 40px" }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", width: "100%" }}>
        {isLoading && <SkeletonRows count={4} height={76} />}
        {isError && (
          <EmptyState
            icon={<AlertTriangle size={24} strokeWidth={1.75} color={colors.warning} />}
            title="Couldn't load campaigns"
            description="The server may be unreachable. Check that it's running, then retry."
            action={
              <Button variant="secondary" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {!isLoading && !isError && (!campaigns || campaigns.length === 0) && (
          <EmptyState
            icon={<FolderOpen size={24} strokeWidth={1.75} color={colors.textMuted} />}
            title="No campaigns yet"
            description="Create your first campaign to start building outreach workflows for creators."
            action={
              <Button variant="primary" onClick={() => setShowWizard(true)}>
                Create campaign
              </Button>
            }
          />
        )}
        {campaigns && campaigns.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
              gap: 20,
              alignItems: "start",
            }}
          >
            {campaigns.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                onSelectWorkflow={onSelectWorkflow}
                onDeleted={() => void refetch()}
              />
            ))}
          </div>
        )}
        </div>
      </div>

      {showWizard && (
        <CampaignWizard onCreated={handleCreated} onClose={() => setShowWizard(false)} />
      )}
    </div>
  );
}

function CampaignCard({
  campaign,
  onSelectWorkflow,
  onDeleted,
}: {
  campaign: CampaignListItem;
  onSelectWorkflow: (id: string) => void;
  onDeleted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // PLU-153: who is ending it + why — recorded on the audit event so the
  // ClosingSummary attribution is real, not a hardcoded "operator".
  const [closedBy, setClosedBy] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const toast = useToast();
  const queryClient = useQueryClient();

  // Lazy-load detail via the existing hook (cached by React Query) once expanded
  // OR when the card is Closing (so the winding-down summary + counts show
  // without the operator having to expand workflows).
  const detail = useCampaign(expanded || campaign.status === "CLOSING" ? campaign.id : null);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteCampaign(campaign.id);
      toast.success(`Deleted “${campaign.name}”.`);
      onDeleted();
    } catch (e) {
      // N3: surface the server message (e.g. the 409 telling the operator to
      // End the campaign instead of deleting a launched one).
      toast.error(e instanceof Error ? e.message : "Failed to delete campaign.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function handleClose() {
    if (!closedBy.trim()) {
      toast.error("Enter your name before ending the campaign.");
      return;
    }
    setClosing(true);
    try {
      await closeCampaign(campaign.id, closedBy.trim(), closeReason.trim() || undefined);
      toast.success(`“${campaign.name}” is now winding down.`);
      setConfirmClose(false);
      setClosedBy("");
      setCloseReason("");
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign", campaign.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to end campaign.");
    } finally {
      setClosing(false);
    }
  }

  const publishedCount =
    detail.data?.workflows.filter((w) => w.status === "PUBLISHED").length ?? null;

  return (
    <Card style={{ overflow: "hidden", opacity: deleting ? 0.5 : 1 }}>
      {/* Card head */}
      <div style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...text.heading }}>{campaign.name}</span>
              <Badge color={colors.textMuted} small>
                {campaign.brand}
              </Badge>
              {/* PLU-153: lifecycle badge. */}
              <Badge color={STATUS_COLOR[campaign.status]} small>
                {campaign.status}
              </Badge>
            </div>
            <div
              style={{
                fontSize: font.size.md,
                color: colors.textMuted,
                marginTop: 6,
                lineHeight: 1.45,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {campaign.objective || "No objective set"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {/* PLU-153: End campaign = ACTIVE → CLOSING. Only when Active. */}
            {campaign.status === "ACTIVE" && (
              <Button
                variant="secondary"
                onClick={() => setConfirmClose(true)}
                disabled={closing}
              >
                End campaign
              </Button>
            )}
            <IconButton
              label="Delete campaign"
              icon={<Trash2 size={15} strokeWidth={1.75} />}
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="ds-danger-hover"
              style={{ color: colors.textDim, opacity: 0.75 }}
            />
          </div>
        </div>

        {/* PLU-153: winding-down summary when Closing. */}
        {campaign.status === "CLOSING" && (
          <ClosingSummary detail={detail.data} />
        )}

        {/* Stat row (derived from data we already have) */}
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 16 }}>
          <MiniMetric label="Workflows" value={campaign.workflowCount} accent={colors.text} />
          <MiniMetric
            label="Published"
            value={publishedCount ?? "—"}
            accent={publishedCount && publishedCount > 0 ? colors.success : colors.textMuted}
          />
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: font.weight.medium,
                color: colors.textDim,
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              Created
            </div>
            <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 2 }}>
              {formatTimestamp(campaign.createdAt)}
            </div>
          </div>
        </div>
      </div>

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="ds-focusable ds-row"
        style={{
          width: "100%",
          padding: "8px 18px",
          background: "transparent",
          border: "none",
          borderTop: `1px solid ${colors.border}`,
          color: colors.textMuted,
          fontSize: font.size.sm,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>{expanded ? "Hide workflows" : "View workflows"}</span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          aria-hidden
          style={{ transition: "transform 0.15s", transform: expanded ? "rotate(180deg)" : "none" }}
        />
      </button>

      {/* Expanded workflow list */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${colors.border}`, padding: "12px 18px", background: colors.bg }}>
          {detail.isLoading ? (
            <div style={{ fontSize: font.size.md, color: colors.textMuted }}>Loading workflows…</div>
          ) : detail.isError ? (
            <div style={{ fontSize: font.size.md, color: colors.danger }}>Failed to load workflows.</div>
          ) : !detail.data || detail.data.workflows.length === 0 ? (
            <div style={{ fontSize: font.size.md, color: colors.textMuted }}>No workflows yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {detail.data.workflows.map((wf) => (
                <button
                  key={wf.id}
                  onClick={() => onSelectWorkflow(wf.id)}
                  className="ds-focusable ds-card-interactive"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    background: colors.panel,
                    border: `1px solid ${colors.border}`,
                    borderRadius: radii.sm,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: font.size.md, color: colors.text }}>
                    {wf.name}
                  </span>
                  <StatusBadge status={wf.status} small />
                  <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
                    {wf.versionCount} version{wf.versionCount !== 1 ? "s" : ""}
                  </span>
                  <span style={{ fontSize: font.size.md, color: colors.accent, fontWeight: font.weight.semibold }}>
                    Open →
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete campaign?"
          message={
            <>
              Delete <strong>{campaign.name}</strong> and all of its workflows? This cannot be undone.
            </>
          }
          confirmLabel="Delete campaign"
          destructive
          busy={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void handleDelete()}
        />
      )}

      {/* PLU-153: End-campaign confirmation lists the consequences verbatim, and
          captures who is ending it (+ optional reason) so the audit trail records
          the real operator — same name-required pattern as PLU-154's resolve panel. */}
      {confirmClose && (
        <ConfirmDialog
          title="End this campaign?"
          message={
            <>
              End <strong>{campaign.name}</strong> and move it to <strong>Closing</strong>?
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                <li>No new creators will be enrolled.</li>
                <li>No new initial outreach will be sent (queued outreach that hasn’t begun is dropped).</li>
                <li>Creators already in progress continue uninterrupted.</li>
                <li>The campaign auto-archives only later, after those journeys conclude.</li>
              </ul>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
                <input
                  style={closeInputStyle}
                  placeholder="Your name (required)"
                  value={closedBy}
                  onChange={(e) => setClosedBy(e.target.value)}
                  autoFocus
                />
                <input
                  style={closeInputStyle}
                  placeholder="Reason (optional)"
                  value={closeReason}
                  onChange={(e) => setCloseReason(e.target.value)}
                />
              </div>
            </>
          }
          confirmLabel="End campaign"
          busy={closing}
          onCancel={() => {
            setConfirmClose(false);
            setClosedBy("");
            setCloseReason("");
          }}
          onConfirm={() => void handleClose()}
        />
      )}
    </Card>
  );
}

// PLU-153: shared input style for the End-campaign confirm form.
const closeInputStyle = {
  fontSize: font.size.sm,
  color: colors.text,
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm,
  padding: "6px 9px",
  width: "100%",
} as const;

// PLU-153: the winding-down dashboard panel shown while a campaign is Closing.
function ClosingSummary({
  detail,
}: {
  detail: import("../../api/builderTypes").CampaignDetail | undefined;
}) {
  const initiated = detail?.closingInitiatedAt
    ? `initiated ${formatTimestamp(detail.closingInitiatedAt)}` +
      (detail.closingInitiatedBy ? ` by ${detail.closingInitiatedBy}` : "")
    : "winding down";
  const inProgress = detail?.inProgressCreatorCount ?? null;
  const manualReview = detail?.manualReviewCount ?? null;
  return (
    <div
      style={{
        marginTop: 14,
        padding: "10px 12px",
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.sm,
        fontSize: font.size.sm,
        color: colors.textMuted,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: colors.warning }}>Winding down</strong> — {initiated}.{" "}
      {inProgress ?? "…"} creator journey{inProgress === 1 ? "" : "s"} in progress
      {manualReview != null && manualReview > 0
        ? `, ${manualReview} in Manual Review`
        : ""}
      . No new creators will enter; existing creators continue.
      {detail?.closingReason ? <> Reason: {detail.closingReason}.</> : null}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div>
      <div
        className="nums"
        style={{
          fontSize: font.size.xl,
          fontWeight: font.weight.semibold,
          color: accent,
          lineHeight: 1,
          letterSpacing: -0.3,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: font.weight.medium,
          color: colors.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginTop: 4,
        }}
      >
        {label}
      </div>
    </div>
  );
}
