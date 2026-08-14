import { useState } from "react";
import { Trash2, ChevronDown, FolderOpen, AlertTriangle, Pencil, Copy } from "lucide-react";
import { useCampaigns, useCampaign, deleteCampaign, duplicateCampaign } from "../../api/builderClient";
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
import { StartCampaignModal } from "./campaignIntake/StartCampaignModal";
import type { CampaignListItem } from "../../api/builderTypes";

interface Props {
  onSelectWorkflow: (workflowId: string) => void;
  /** PLU-139 (2a): open a campaign's sectioned brief intake. */
  onOpenIntake: (campaignId: string) => void;
}

export function CampaignList({ onSelectWorkflow, onOpenIntake }: Props) {
  const { data: campaigns, isLoading, isError, refetch } = useCampaigns();
  const [showWizard, setShowWizard] = useState(false);

  // New campaign → mint a DRAFT + workflow, then open its brief intake.
  function handleCreated(campaignId: string) {
    setShowWizard(false);
    void refetch();
    onOpenIntake(campaignId);
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
                onOpenIntake={onOpenIntake}
                onChanged={() => void refetch()}
                onDeleted={() => void refetch()}
              />
            ))}
          </div>
        )}
        </div>
      </div>

      {showWizard && (
        <StartCampaignModal onCreated={handleCreated} onClose={() => setShowWizard(false)} />
      )}
    </div>
  );
}

function CampaignCard({
  campaign,
  onSelectWorkflow,
  onOpenIntake,
  onChanged,
  onDeleted,
}: {
  campaign: CampaignListItem;
  onSelectWorkflow: (id: string) => void;
  onOpenIntake: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();

  // Lazy-load detail via the existing hook (cached by React Query) once expanded.
  const detail = useCampaign(expanded ? campaign.id : null);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteCampaign(campaign.id);
      toast.success(`Deleted “${campaign.name}”.`);
      onDeleted();
    } catch {
      toast.error("Failed to delete campaign.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // PLU-139: "Duplicate as new campaign" → clone on the server, open the new
  // draft's brief. Available for any campaign (the material-change path for a
  // launched one, per PLU-136 1b).
  async function handleDuplicate() {
    setDuplicating(true);
    try {
      const dup = await duplicateCampaign(campaign.id);
      toast.success(`Duplicated as “${dup.name}”.`);
      onChanged();
      onOpenIntake(dup.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate campaign.");
      setDuplicating(false);
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
              <Badge
                color={campaign.status === "DRAFT" ? colors.warning : colors.success}
                dot
                small
              >
                {campaign.status === "DRAFT" ? "Draft" : "Active"}
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
          <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <IconButton
              label={campaign.status === "DRAFT" ? "Edit brief" : "View brief"}
              icon={<Pencil size={15} strokeWidth={1.75} />}
              onClick={() => onOpenIntake(campaign.id)}
              style={{ color: colors.textDim, opacity: 0.75 }}
            />
            <IconButton
              label="Duplicate as new campaign"
              icon={<Copy size={15} strokeWidth={1.75} />}
              onClick={() => void handleDuplicate()}
              disabled={duplicating}
              style={{ color: colors.textDim, opacity: 0.75 }}
            />
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
    </Card>
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
