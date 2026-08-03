import { useState } from "react";
import { Lock, Users } from "lucide-react";
import { launchWorkflow, useWorkflowExecution } from "../../api/builderClient";
import { colors, radii, font, stateColor, stateLabel } from "../../theme";
import { Button, StatTile, EmptyState, ConfirmDialog, SectionHeader, useToast } from "../ds";
import type { WorkflowDetail, LaunchResponse } from "../../api/builderTypes";
import type { InstanceState } from "../../api/types";

interface Props {
  workflow: WorkflowDetail;
  onLaunched: () => void;
}

const ALL_STATES: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_QUEUED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_PENDING",
  "REWARD_CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "CONTENT_BRIEF_SENT",
  "NEEDS_DEAL_FINALIZATION",
  "HANDOFF_COMPLETE",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

export function LaunchTab({ workflow, onLaunched }: Props) {
  const execution = useWorkflowExecution(workflow.id);
  const [showConfirm, setShowConfirm] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchResponse | null>(null);
  const toast = useToast();

  const hasVersion = !!workflow.latestVersion;
  const data = execution.data;
  const enrolledCount = data?.stateCounts["ENROLLED"] ?? 0;
  const totalInstances = data?.totalInstances ?? 0;
  const hasLaunched =
    totalInstances > 0 &&
    ((data?.stateCounts["OUTREACH_QUEUED"] ?? 0) > 0 ||
      (data?.stateCounts["OUTREACH_SENT"] ?? 0) > 0);

  async function handleLaunch() {
    setLaunching(true);
    try {
      const r = await launchWorkflow(workflow.id);
      setResult(r);
      setShowConfirm(false);
      toast.success(`Launched ${r.launched} creator${r.launched !== 1 ? "s" : ""}.`);
      onLaunched();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Launch failed");
      setShowConfirm(false);
    } finally {
      setLaunching(false);
    }
  }

  if (!hasVersion) {
    return <EmptyState icon={<Lock size={24} strokeWidth={1.75} color={colors.textMuted} />} title="Workflow not published" description="Publish the workflow before launching." />;
  }
  if (totalInstances === 0) {
    return <EmptyState icon={<Users size={24} strokeWidth={1.75} color={colors.textMuted} />} title="No creators enrolled" description="Enroll creators on the Enroll tab before launching." />;
  }

  const checklist = [
    {
      label: "Workflow published",
      detail: `Version v${workflow.latestVersion?.version} is live`,
      done: hasVersion,
    },
    {
      label: "Creators enrolled",
      detail: `${totalInstances} creator${totalInstances !== 1 ? "s" : ""} in this campaign`,
      done: totalInstances > 0,
    },
    {
      label: "Ready to launch",
      detail:
        enrolledCount > 0
          ? `${enrolledCount} creator${enrolledCount !== 1 ? "s" : ""} waiting for outreach`
          : "No creators are waiting to launch",
      done: enrolledCount > 0,
    },
  ];

  return (
    <div className="ds-fade-in" style={{ height: "100%", overflow: "auto", width: "100%" }}>
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "32px 24px 48px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Headline tiles */}
        <div style={{ display: "flex", gap: 14 }}>
          <StatTile label="Version" value={`v${workflow.latestVersion?.version}`} />
          <StatTile label="Enrolled" value={totalInstances} />
          <StatTile
            label="Ready to Launch"
            value={enrolledCount}
            color={enrolledCount > 0 ? colors.success : colors.textMuted}
          />
        </div>

        {result && (
          <div
            className="ds-fade-in"
            style={{
              padding: "14px 18px",
              background: `${colors.success}12`,
              border: `1px solid ${colors.success}40`,
              borderRadius: radii.md,
              fontSize: font.size.md,
              color: colors.success,
              lineHeight: 1.55,
            }}
          >
            <div style={{ fontWeight: font.weight.semibold, marginBottom: 4 }}>
              ✓ Launched {result.launched} creator{result.launched !== 1 ? "s" : ""}
            </div>
            <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>
              Real outreach emails will be sent as the workers process the queue. Switch to the Monitor
              tab to watch progress.
            </div>
          </div>
        )}

        {/* Pre-flight checklist */}
        <div>
          <SectionHeader>Pre-flight checklist</SectionHeader>
          <div
            style={{
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              overflow: "hidden",
            }}
          >
            {checklist.map((item, i) => (
              <div
                key={item.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 18px",
                  borderTop: i > 0 ? `1px solid ${colors.border}` : "none",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: item.done ? `${colors.success}1c` : colors.panelAlt,
                    border: `1px solid ${item.done ? `${colors.success}50` : colors.borderStrong}`,
                    color: item.done ? colors.success : colors.textDim,
                    fontSize: 11,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {item.done ? "✓" : i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: font.size.md,
                      fontWeight: font.weight.medium,
                      color: colors.text,
                    }}
                  >
                    {item.label}
                  </div>
                  <div style={{ fontSize: font.size.sm, color: colors.textDim, marginTop: 2 }}>
                    {item.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* State breakdown */}
        {data && Object.keys(data.stateCounts).length > 0 && (
          <div>
            <SectionHeader>Current State Breakdown</SectionHeader>
            <div
              style={{
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                padding: "14px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0).map((s) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor[s], flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: font.size.md, color: colors.text }}>{stateLabel[s]}</span>
                  <span
                    className="nums"
                    style={{
                      fontSize: font.size.md,
                      fontWeight: font.weight.semibold,
                      color: stateColor[s],
                      minWidth: 30,
                      textAlign: "right",
                    }}
                  >
                    {data.stateCounts[s]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Launch action */}
        {enrolledCount > 0 && (
          <div
            style={{
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.lg,
              padding: "22px 24px",
              display: "flex",
              alignItems: "center",
              gap: 20,
              boxShadow: "0 2px 6px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.28)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: font.size.lg,
                  fontWeight: font.weight.semibold,
                  color: colors.text,
                  letterSpacing: -0.2,
                }}
              >
                Ready when you are
              </div>
              <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                Outreach starts immediately for every creator in the Enrolled state.
              </div>
            </div>
            <Button
              variant="primary"
              onClick={() => setShowConfirm(true)}
              style={{ height: 42, fontSize: font.size.md, padding: "0 22px", flexShrink: 0 }}
              rightIcon="→"
            >
              Launch {enrolledCount} creator{enrolledCount !== 1 ? "s" : ""}
            </Button>
          </div>
        )}

        {hasLaunched && enrolledCount === 0 && (
          <div
            style={{
              padding: "14px 18px",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              fontSize: font.size.md,
              color: colors.textMuted,
              lineHeight: 1.55,
            }}
          >
            All enrolled creators have been launched. Enroll more creators to send additional outreach.
          </div>
        )}
      </div>

      {showConfirm && (
        <ConfirmDialog
          title="Confirm launch"
          confirmLabel="Launch"
          busy={launching}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => void handleLaunch()}
          message={
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  padding: "12px 14px",
                  background: `${colors.warning}12`,
                  border: `1px solid ${colors.warning}40`,
                  borderRadius: radii.sm + 1,
                  fontSize: font.size.sm,
                  color: colors.warning,
                  lineHeight: 1.55,
                }}
              >
                ⚠ This will enqueue real outreach jobs for {enrolledCount} creator
                {enrolledCount !== 1 ? "s" : ""}. If the server is configured with a live email
                provider, real emails will be sent.
              </div>
              <div>
                Launch execution for <strong style={{ color: colors.text }}>{workflow.name}</strong>?
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}
