// ---------------------------------------------------------------------------
// KnowledgePanel — PLU-82 knowledge precedence & conflicts in the inspector.
// ---------------------------------------------------------------------------
// READ-ONLY (no resolve action, unlike ObligationsPanel). Three sections:
//   1. Brief availability — the four-state result (NO_BRIEF / AVAILABLE / PARTIAL
//      / PARSE_FAILED) so an operator sees WHY a brief is empty.
//   2. Material conflicts — brief-vs-Campaign disagreements, showing BOTH sources
//      (campaignValue + briefExcerpt) so the operator can adjudicate. Values are
//      shown here (operator-gated) but are never logged to stdout server-side.
//   3. Selected sources — the winning source label per finalized term (the
//      "selected source in internal debug context" criterion).
//
// Operator-gated by the same requireOperatorKey the /observability mount uses.

import type {
  KnowledgeDTO,
  BriefAvailabilityDTO,
  KnowledgeConflictDTO,
} from "../api/types";
import { colors, font } from "../theme";
import { Empty } from "./ui";

function availabilityColor(status: BriefAvailabilityDTO["status"]): string {
  switch (status) {
    case "AVAILABLE":
      return colors.success;
    case "PARTIAL":
      return colors.warning;
    case "PARSE_FAILED":
      return colors.danger;
    case "NO_BRIEF":
    default:
      return colors.textMuted;
  }
}

// A human label for a winning-source code (mirrors SourceLabel server-side).
const SOURCE_LABELS: Record<string, string> = {
  confirmed_agreement: "Confirmed agreement",
  operator_override: "Operator override",
  negotiation_state: "Negotiation state",
  workflow_config: "Workflow config",
  campaign_default: "Campaign default",
};

function sourceLabel(code: string | null): string {
  if (!code) return "— (none configured)";
  return SOURCE_LABELS[code] ?? code;
}

export function KnowledgePanel({ knowledge }: { knowledge: KnowledgeDTO | undefined }) {
  if (
    !knowledge ||
    (!knowledge.briefAvailability &&
      knowledge.conflicts.length === 0 &&
      Object.keys(knowledge.resolvedSources).length === 0)
  ) {
    return <Empty>No knowledge records yet (no negotiation turns or resolved terms).</Empty>;
  }

  const { briefAvailability, conflicts, resolvedSources } = knowledge;
  const sourceEntries = Object.entries(resolvedSources);
  // review §6: active conflicts are still live; cleared ones were corrected by a
  // later re-resolution and are shown demoted, not as active failures.
  const activeConflicts = conflicts.filter((c) => c.status !== "cleared");
  const clearedConflicts = conflicts.filter((c) => c.status === "cleared");

  return (
    <div>
      <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
        Deterministic knowledge precedence and brief health (PLU-82). Which source
        won each finalized term, whether the campaign brief is readable, and any
        material brief-vs-Campaign conflict — surfaced for a human, never
        auto-resolved.
      </p>

      {/* 1. Brief availability */}
      <SubHeading>Brief availability</SubHeading>
      {briefAvailability ? (
        <div
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            padding: "10px 12px",
            marginBottom: 8,
            background: colors.panelAlt,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: font.weight.semibold,
                color: availabilityColor(briefAvailability.status),
                border: `1px solid ${availabilityColor(briefAvailability.status)}`,
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {briefAvailability.status}
            </span>
            {briefAvailability.round !== null && (
              <span style={{ fontSize: 10, color: colors.textDim }}>
                · round {briefAvailability.round}
              </span>
            )}
          </div>
          {briefAvailability.error && (
            <div style={{ fontSize: 11, color: colors.textDim, marginTop: 6 }}>
              {briefAvailability.error}
            </div>
          )}
          {briefAvailability.missingSections.length > 0 && (
            <div style={{ fontSize: 11, color: colors.textDim, marginTop: 6 }}>
              Missing expected sections: {briefAvailability.missingSections.join(", ")}
            </div>
          )}
        </div>
      ) : (
        <Empty>No brief availability recorded (no negotiation turn yet).</Empty>
      )}

      {/* 2. Material conflicts. review §6: split active vs cleared so a conflict a
          later re-resolution corrected no longer reads as live. Active first. */}
      <div style={{ height: 14 }} />
      <SubHeading>
        Material conflicts ({activeConflicts.length} active
        {clearedConflicts.length > 0 ? `, ${clearedConflicts.length} cleared` : ""})
      </SubHeading>
      {conflicts.length === 0 ? (
        <Empty>No material brief-vs-Campaign conflicts detected.</Empty>
      ) : (
        [...activeConflicts, ...clearedConflicts].map((c, i) => (
          <ConflictRow key={`${c.campaignField}-${c.reason}-${i}`} conflict={c} />
        ))
      )}

      {/* 3. Selected sources */}
      <div style={{ height: 14 }} />
      <SubHeading>Selected sources ({sourceEntries.length})</SubHeading>
      {sourceEntries.length === 0 ? (
        <Empty>No finalized terms resolved yet (deal not accepted).</Empty>
      ) : (
        <div
          style={{
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            background: colors.panelAlt,
            overflow: "hidden",
          }}
        >
          {sourceEntries.map(([field, code], i) => (
            <div
              key={field}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "8px 12px",
                fontSize: 12,
                color: colors.text,
                borderTop: i === 0 ? "none" : `1px solid ${colors.border}`,
              }}
            >
              <span style={{ color: colors.textMuted }}>{field}</span>
              <span>{sourceLabel(code)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: font.size.xs,
        fontWeight: font.weight.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        color: colors.textMuted,
        margin: "0 0 8px",
      }}
    >
      {children}
    </div>
  );
}

function ConflictRow({ conflict }: { conflict: KnowledgeConflictDTO }) {
  const c = conflict;
  const cleared = c.status === "cleared";
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
        background: colors.panelAlt,
        // review §6: a corrected conflict is demoted (dimmed) so it reads as
        // history, not a live failure the operator must act on.
        opacity: cleared ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10.5, color: colors.textMuted }}>{c.campaignField}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: font.weight.semibold,
            color: cleared ? colors.textDim : colors.warning,
            border: `1px solid ${cleared ? colors.textDim : colors.warning}`,
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {cleared ? "cleared" : "conflict"}
        </span>
        {c.pageStart !== undefined && (
          <span style={{ fontSize: 10, color: colors.textDim }}>· p{c.pageStart}</span>
        )}
        {c.round !== null && (
          <span style={{ fontSize: 10, color: colors.textDim }}>· round {c.round}</span>
        )}
        {cleared && c.lastRound !== null && c.lastRound !== c.round && (
          <span style={{ fontSize: 10, color: colors.textDim }}>· last seen round {c.lastRound}</span>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: colors.textDim, lineHeight: 1.4 }}>{c.reason}</div>

      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
        <div style={{ fontSize: 11.5 }}>
          <span style={{ color: colors.textMuted }}>Campaign (authoritative): </span>
          <span style={{ color: colors.text }}>{c.campaignValue || "—"}</span>
        </div>
        <div style={{ fontSize: 11.5 }}>
          <span style={{ color: colors.textMuted }}>Brief says: </span>
          <span style={{ color: colors.text }}>{c.briefExcerpt || "—"}</span>
        </div>
      </div>
    </div>
  );
}
