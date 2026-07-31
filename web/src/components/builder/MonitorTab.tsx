import { useState } from "react";
import { RadioTower, Users, Activity, CheckCircle2, AlertTriangle } from "lucide-react";
import { useWorkflowExecution } from "../../api/builderClient";
import { POLL_INTERVAL_MS } from "../../api/client";
import { colors, radii, font, stateColor, stateLabel, formatTimestamp } from "../../theme";
import { StatTile, EmptyState, SectionHeader, Donut, type DonutSlice } from "../ds";
import { InstanceInspector } from "../InstanceInspector";
import type { WorkflowDetail } from "../../api/builderTypes";
import type { InstanceState } from "../../api/types";

interface Props {
  workflow: WorkflowDetail;
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

// Serif page-title style for the Monitor header.
function text_title(): React.CSSProperties {
  return {
    fontFamily: font.family.serif,
    fontSize: font.size.xl + 4,
    fontWeight: font.weight.bold,
    letterSpacing: -0.4,
    color: colors.text,
    lineHeight: 1.1,
  };
}

// Build a short rising series ending near `value` so a tile's sparkline reflects
// its current magnitude. Purely presentational — the API exposes no history, so
// this is a visual accent, not a real trend claim.
function sparkFrom(value: number, points: number): number[] {
  if (value <= 0) return [0, 0, 0, 0, 0, 0].slice(0, points);
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    // Ease from ~40% of the value up to the value, with a gentle wobble by index.
    const base = value * (0.4 + 0.6 * t);
    const wobble = (i % 2 === 0 ? 1 : -1) * value * 0.05 * (1 - t);
    out.push(Math.max(0, base + wobble));
  }
  return out;
}

const TERMINAL = new Set<InstanceState>([
  // ACCEPTED, REWARD_CONFIRMED and PAYMENT_RECEIVED auto-advance (Reward Setup /
  // Payment Info / Content Brief), so they're no longer terminal;
  // CONTENT_BRIEF_SENT is the success terminal.
  "CONTENT_BRIEF_SENT",
  // PLU-70: NEEDS_DEAL_FINALIZATION is NOT terminal — it is parked on an
  // operator. HANDOFF_COMPLETE is that branch's success terminal.
  "HANDOFF_COMPLETE",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
]);

export function MonitorTab({ workflow }: Props) {
  const execution = useWorkflowExecution(workflow.id);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const data = execution.data;
  const hasVersion = !!workflow.latestVersion;

  if (!hasVersion) {
    return <EmptyState icon={<RadioTower size={24} strokeWidth={1.75} color={colors.textMuted} />} title="Nothing to monitor yet" description="Publish and launch the workflow to start monitoring." />;
  }
  if (!data || data.totalInstances === 0) {
    return (
      <EmptyState
        icon={<RadioTower size={24} strokeWidth={1.75} color={colors.textMuted} />}
        title="No creators enrolled yet"
        description={`Enroll and launch to begin monitoring. Auto-refreshes every ${POLL_INTERVAL_MS / 1000}s.`}
      />
    );
  }

  const total = data.totalInstances;
  const active = Object.entries(data.stateCounts)
    .filter(([s]) => !TERMINAL.has(s as InstanceState))
    .reduce((a, [, v]) => a + v, 0);
  const terminal = total - active;

  const needsReview = data.stateCounts["MANUAL_REVIEW"] ?? 0;

  // Distribution slices for the donut: coarse buckets (Active / Completed /
  // Needs Review) so the ring stays readable rather than 18 hair-thin wedges.
  const distribution: DonutSlice[] = [
    { label: "Active", value: active, color: colors.accent },
    { label: "Completed", value: terminal - needsReview, color: colors.success },
    { label: "Needs Review", value: needsReview, color: colors.warning },
  ];

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div className="ds-fade-in" style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            padding: "24px 28px 40px",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ ...text_title() }}>Monitor</span>
          <span
            className={execution.isFetching ? undefined : "ds-pulse"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: execution.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 8px ${execution.isFetching ? colors.warning : colors.success}66`,
              flexShrink: 0,
              marginLeft: 4,
            }}
          />
          <span style={{ fontSize: font.size.sm, color: colors.textMuted }}>
            v{workflow.latestVersion?.version} · refreshes every {POLL_INTERVAL_MS / 1000}s
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: "auto" }}>
            Updated {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        {/* Totals — icon + sparkline stat tiles */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <StatTile
            label="Total Creators"
            value={total}
            icon={<Users size={14} strokeWidth={2.25} />}
            trend={sparkFrom(total, 6)}
          />
          <StatTile
            label="Active"
            value={active}
            color={colors.accent}
            icon={<Activity size={14} strokeWidth={2.25} />}
            trend={sparkFrom(active, 6)}
          />
          <StatTile
            label="Completed"
            value={terminal}
            color={colors.success}
            icon={<CheckCircle2 size={14} strokeWidth={2.25} />}
            trend={sparkFrom(terminal, 6)}
          />
          <StatTile
            label="Needs Review"
            value={needsReview}
            color={needsReview > 0 ? colors.warning : colors.textMuted}
            icon={<AlertTriangle size={14} strokeWidth={2.25} />}
          />
        </div>

        {/* Two-column: pipeline progress (left) · distribution + activity (right) */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 1fr)",
            gap: 22,
            alignItems: "start",
          }}
        >
          {/* Pipeline progress */}
          <div>
            <SectionHeader>Pipeline Progress</SectionHeader>
            <div
              style={{
                background: colors.panel,
                border: `2px solid ${colors.cardBorder}`,
                borderRadius: radii.md,
                boxShadow: "4px 4px 0 var(--shadowInk)",
                padding: "16px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 11,
              }}
            >
              {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0 || !TERMINAL.has(s)).map((s) => {
                const count = data.stateCounts[s] ?? 0;
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: count > 0 ? stateColor[s] : colors.borderStrong, flexShrink: 0 }} />
                    <span style={{ width: 136, fontSize: font.size.sm, fontWeight: font.weight.semibold, color: count > 0 ? colors.text : colors.textDim, flexShrink: 0 }}>
                      {stateLabel[s]}
                    </span>
                    <div style={{ flex: 1, height: 8, background: colors.panelAlt, border: `1.5px solid ${colors.cardBorder}`, borderRadius: radii.pill, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: stateColor[s], transition: "width 0.6s cubic-bezier(0.25, 1, 0.5, 1)" }} />
                    </div>
                    <span
                      className="nums serif"
                      style={{ width: 34, textAlign: "right", fontSize: font.size.lg, fontWeight: font.weight.bold, color: count > 0 ? colors.text : colors.textDim, flexShrink: 0 }}
                    >
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right column: distribution donut + recent activity */}
          <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
            <div>
              <SectionHeader>Pipeline Distribution</SectionHeader>
              <div
                style={{
                  background: colors.panel,
                  border: `2px solid ${colors.cardBorder}`,
                  borderRadius: radii.md,
                  boxShadow: "4px 4px 0 var(--shadowInk)",
                  padding: "18px",
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                }}
              >
                <Donut data={distribution} total={total} totalLabel="Total" size={140} />
                <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                  {distribution.map((d) => (
                    <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, border: `1.5px solid ${colors.cardBorder}`, flexShrink: 0 }} />
                      <span style={{ fontSize: font.size.sm, color: colors.textMuted, flex: 1 }}>{d.label}</span>
                      <span className="nums" style={{ fontSize: font.size.sm, fontWeight: font.weight.bold, color: colors.text }}>{d.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {data.recentEvents.length > 0 && (
              <div>
                <SectionHeader>Recent Activity</SectionHeader>
                <div
                  style={{
                    background: colors.panel,
                    border: `2px solid ${colors.cardBorder}`,
                    borderRadius: radii.md,
                    boxShadow: "4px 4px 0 var(--shadowInk)",
                    overflow: "hidden",
                  }}
                >
                  {data.recentEvents.slice(0, 8).map((e, i) => {
                    const payload = e.payload as Record<string, string> | null;
                    const from = payload?.["from"] ?? "?";
                    const to = payload?.["to"] ?? "?";
                    const fromLabel = stateLabel[from as InstanceState] ?? from;
                    const toLabel = stateLabel[to as InstanceState] ?? to;
                    return (
                      <button
                        key={e.id}
                        onClick={() => setSelectedInstanceId(e.instanceId)}
                        className="ds-focusable ds-row"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                          padding: "10px 14px",
                          cursor: "pointer",
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          borderTop: i > 0 ? `1.5px solid ${colors.hairline}` : "none",
                        }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                          <span style={{ fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.creatorName}</span>
                          <span style={{ fontSize: font.size.xs, color: colors.textDim, marginLeft: "auto", flexShrink: 0 }}>{formatTimestamp(e.occurredAt)}</span>
                        </span>
                        <span style={{ fontSize: font.size.sm, color: colors.textMuted, whiteSpace: "nowrap" }}>
                          <span style={{ color: stateColor[from as InstanceState] ?? colors.textMuted }}>{fromLabel}</span>
                          <span aria-hidden style={{ color: colors.textDim, margin: "0 6px" }}>→</span>
                          <span style={{ color: stateColor[to as InstanceState] ?? colors.textMuted }}>{toLabel}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div
          className="ds-slide-in-right"
          style={{
            width: 400,
            flexShrink: 0,
            borderLeft: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
          <InstanceInspector instanceId={selectedInstanceId} onClose={() => setSelectedInstanceId(null)} />
        </div>
      )}
    </div>
  );
}
