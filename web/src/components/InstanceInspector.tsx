// ---------------------------------------------------------------------------
// InstanceInspector — the primary debugging surface (Parts 4–7, 10).
// ---------------------------------------------------------------------------
// Right-side panel. Header = execution-instance info; tabbed body switches
// between the event timeline, message thread, agent decisions, and the
// transition trace (logs). Everything is read from the observability API and
// polls live.

import { useState } from "react";
import { useInstanceDetail, useTimeline, useLogs } from "../api/client";
import { colors, font, formatTimestamp, relativeTime, formatDuration } from "../theme";
import { StateBadge, SourceBadge, Field, SectionTitle, Empty, Spinner } from "./ui";
import { IconButton } from "./ds";
import { Timeline } from "./Timeline";
import { MessageThread } from "./MessageThread";
import { AgentDecisions } from "./AgentDecisions";
import { LogsTrace } from "./LogsTrace";
import { InstanceLlmUsage } from "./LlmUsagePanel";
import { ObligationsPanel } from "./ObligationsPanel";
import { KnowledgePanel } from "./KnowledgePanel";
import { ContextPanel } from "./ContextPanel";

type Tab = "timeline" | "messages" | "decisions" | "obligations" | "knowledge" | "context" | "usage" | "logs";

interface Props {
  instanceId: string;
  onClose: () => void;
}

export function InstanceInspector({ instanceId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("timeline");
  const detail = useInstanceDetail(instanceId);
  const timeline = useTimeline(instanceId);
  const logs = useLogs(instanceId);

  const d = detail.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: colors.text }}>
              {d?.creator.name ?? "Loading…"}
            </h2>
            <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>
              {d?.creator.handle ?? d?.creator.email ?? ""}
              {d?.creator.platform ? ` · ${d.creator.platform}` : ""}
              {d?.creator.niche ? ` · ${d.creator.niche}` : ""}
            </div>
          </div>
          <IconButton
            label="Close inspector"
            icon="✕"
            onClick={onClose}
            style={{ border: `1px solid ${colors.border}` }}
          />
        </div>

        {d && (
          <>
            <div style={{ marginTop: 10 }}>
              <StateBadge state={d.instance.state} />
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "10px 14px",
                marginTop: 12,
              }}
            >
              <Field label="Instance ID" value={d.instance.instanceId} mono />
              <Field label="Creator ID" value={d.creator.id} mono />
              <Field
                label="Workflow"
                value={`${d.instance.workflowName ?? "—"} · v${d.instance.workflowVersion ?? "?"}`}
              />
              <Field label="Current Node" value={d.instance.currentNodeId ?? "—"} mono />
              <Field label="Negotiation Round" value={d.instance.negotiationRound} />
              <Field label="Follow-ups" value={d.instance.followUpCount} />
              <Field label="Due At" value={formatTimestamp(d.instance.dueAt)} />
              <Field label="Enrolled" value={relativeTime(d.instance.enrolledAt)} />
              <Field label="Last Updated" value={relativeTime(d.instance.updatedAt)} />
              <Field
                label="Last Transition By"
                value={<SourceBadge source={d.instance.lastTransitionSource} />}
              />
            </div>
            {d.instance.completedAt && (
              <div style={{ marginTop: 8, fontSize: 11, color: colors.success }}>
                Completed {formatTimestamp(d.instance.completedAt)}
              </div>
            )}
          </>
        )}
        {detail.isLoading && <Spinner />}
        {detail.isError && <Empty>Failed to load instance: {(detail.error as Error)?.message}</Empty>}
      </div>

      {/* Tabs */}
      <div role="tablist" style={{ display: "flex", borderBottom: `1px solid ${colors.border}`, padding: "0 8px" }}>
        <TabButton label="Timeline" active={tab === "timeline"} onClick={() => setTab("timeline")} count={timeline.data?.entries.length} />
        <TabButton label="Messages" active={tab === "messages"} onClick={() => setTab("messages")} count={d?.messages.length} />
        <TabButton label="AI Decisions" active={tab === "decisions"} onClick={() => setTab("decisions")} count={d?.agentDecisions.length} />
        <TabButton
          label="Obligations"
          active={tab === "obligations"}
          onClick={() => setTab("obligations")}
          count={d?.obligations?.filter((o) => o.open).length}
        />
        <TabButton
          label="Knowledge"
          active={tab === "knowledge"}
          onClick={() => setTab("knowledge")}
          count={d?.knowledge?.conflicts.length}
        />
        <TabButton
          label="Context"
          active={tab === "context"}
          onClick={() => setTab("context")}
          count={d?.context?.sourcesUsed.length}
        />
        <TabButton label="AI Usage" active={tab === "usage"} onClick={() => setTab("usage")} count={d?.llmUsage?.calls.length} />
        <TabButton label="Logs" active={tab === "logs"} onClick={() => setTab("logs")} count={logs.data?.trace.length} />
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 16px" }}>
        {tab === "timeline" && (
          <>
            <SectionTitle>Event Timeline</SectionTitle>
            {timeline.isLoading ? <Spinner /> : <Timeline entries={timeline.data?.entries ?? []} />}
          </>
        )}
        {tab === "messages" && (
          <>
            <SectionTitle>Conversation</SectionTitle>
            {detail.isLoading ? <Spinner /> : <MessageThread messages={d?.messages ?? []} />}
          </>
        )}
        {tab === "decisions" && (
          <>
            <SectionTitle>Agent Decisions</SectionTitle>
            {detail.isLoading ? <Spinner /> : <AgentDecisions decisions={d?.agentDecisions ?? []} />}
          </>
        )}
        {tab === "obligations" && (
          <>
            <SectionTitle>Questions &amp; Commitments</SectionTitle>
            {detail.isLoading ? (
              <Spinner />
            ) : (
              <ObligationsPanel instanceId={instanceId} obligations={d?.obligations ?? []} />
            )}
          </>
        )}
        {tab === "knowledge" && (
          <>
            <SectionTitle>Campaign Knowledge</SectionTitle>
            {detail.isLoading ? <Spinner /> : <KnowledgePanel knowledge={d?.knowledge} />}
          </>
        )}
        {tab === "context" && (
          <>
            <SectionTitle>AI Context</SectionTitle>
            {detail.isLoading ? <Spinner /> : <ContextPanel context={d?.context} />}
          </>
        )}
        {tab === "usage" && (
          <>
            <SectionTitle>AI Usage</SectionTitle>
            <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
              Every LLM call made on behalf of this creator — tokens, estimated cost, and latency,
              per classify / negotiate / draft step. "—" means the provider reported no token usage.
            </p>
            {detail.isLoading ? (
              <Spinner />
            ) : d?.llmUsage ? (
              <InstanceLlmUsage totals={d.llmUsage.totals} calls={d.llmUsage.calls} />
            ) : (
              <Empty>No usage data.</Empty>
            )}
          </>
        )}
        {tab === "logs" && (
          <>
            <SectionTitle>Transition Trace</SectionTitle>
            <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
              Who triggered each hop — scheduler, worker, inbound email, or an AI agent — with the
              queue job that drove it. This is the end-to-end traceability surface.
            </p>
            {logs.isLoading ? <Spinner /> : <LogsTrace trace={logs.data?.trace ?? []} />}
          </>
        )}
      </div>

      {/* Footer hint */}
      <div style={{ padding: "8px 16px", borderTop: `1px solid ${colors.border}`, fontSize: 10.5, color: colors.textDim }}>
        Live · refreshes every few seconds
        {d ? ` · age ${formatDuration(Math.round((Date.now() - Date.parse(d.instance.enrolledAt)) / 1000))}` : ""}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number | undefined;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className="ds-focusable"
      style={{
        background: "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? colors.accent : "transparent"}`,
        color: active ? colors.text : colors.textMuted,
        fontSize: font.size.sm,
        fontWeight: active ? font.weight.semibold : font.weight.medium,
        padding: "10px 12px",
        cursor: "pointer",
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span style={{ marginLeft: 6, fontSize: font.size.xs, color: colors.textDim }}>{count}</span>
      )}
    </button>
  );
}
