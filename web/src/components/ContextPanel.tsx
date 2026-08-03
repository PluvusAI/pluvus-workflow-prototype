// ---------------------------------------------------------------------------
// ContextPanel — PLU-81 sanitized AI-context record in the inspector.
// ---------------------------------------------------------------------------
// READ-ONLY. Exposes the "sanitized internal representation of the context"
// assembled for the LATEST negotiation turn — the acceptance criterion "context
// sources visible through internal observability." Every field shown is a
// label/key/count, NEVER a value:
//   - Purpose + round the context was assembled for.
//   - "Available sources" — provenance LABELS offered to the agent (campaign field
//     keys, brief section keys, obligation categories, transcript depth, band
//     PRESENCE). The agent's retrieval router decides what it actually renders and
//     does not echo that back, so these are what was OFFERED, not "used."
//   - Counts — transcript message ids, decision-history event count, open
//     obligation ids, selected campaign fields + brief sections.
//   - Band PRESENCE only — never the floor/ceiling numbers (§7.5).
//   - estimatedTokens — a LABELED coarse chars/4 proxy (over-counts; excludes agent
//     template boilerplate + retrieval pruning). For real token truth the operator
//     is pointed at the AI Usage tab (provider-reported LlmCall.inputTokens, §7.3).
//
// Fold-onto-payload, not a live rebuild (§7.1): this reads the record folded onto
// the latest NEGOTIATION_TURN, so a parked / pre-first-turn instance renders empty
// ("empty = no turn ran," NOT "no context"). Operator-gated by the same
// requireOperatorKey the /observability mount uses.

import type { ContextDTO } from "../api/types";
import { colors, font } from "../theme";
import { Empty } from "./ui";

export function ContextPanel({ context }: { context: ContextDTO | undefined }) {
  if (!context) {
    return <Empty>No context assembled yet (no negotiation turn has run).</Empty>;
  }

  const {
    purpose,
    round,
    messageIdsIncluded,
    eventCount,
    campaignFieldsSelected,
    briefSectionsUsed,
    openObligationIds,
    summaryVersion,
    estimatedTokens,
    sourcesUsed,
    bandPresent,
  } = context;

  return (
    <div>
      <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
        The sanitized AI-context record assembled for the latest turn (PLU-81).
        Labels, keys, and counts only — never values. Band presence is shown, never
        the floor/ceiling. The token estimate is a coarse size proxy; for real token
        counts see the AI Usage tab.
      </p>

      {/* 1. Purpose + round */}
      <SubHeading>Assembled for</SubHeading>
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
              color: colors.text,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              padding: "1px 6px",
            }}
          >
            {purpose}
          </span>
          {round !== null && (
            <span style={{ fontSize: 10, color: colors.textDim }}>· round {round}</span>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: font.weight.semibold,
              color: bandPresent ? colors.success : colors.textMuted,
              border: `1px solid ${bandPresent ? colors.success : colors.border}`,
              borderRadius: 4,
              padding: "1px 6px",
            }}
          >
            band {bandPresent ? "present" : "absent"}
          </span>
          {summaryVersion && (
            <span style={{ fontSize: 10, color: colors.textDim }}>· summary {summaryVersion}</span>
          )}
        </div>
      </div>

      {/* 2. Counts */}
      <div style={{ height: 14 }} />
      <SubHeading>What was assembled</SubHeading>
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          background: colors.panelAlt,
          overflow: "hidden",
        }}
      >
        <CountRow label="Transcript messages" value={messageIdsIncluded.length} first />
        <CountRow label="Decision-history events" value={eventCount} />
        <CountRow label="Open obligations" value={openObligationIds.length} />
        <CountRow
          label="Campaign fields selected"
          value={campaignFieldsSelected.length ? campaignFieldsSelected.join(", ") : "—"}
        />
        <CountRow
          label="Brief sections used"
          value={briefSectionsUsed.length ? briefSectionsUsed.join(", ") : "—"}
        />
        <CountRow label="Estimated tokens (coarse proxy)" value={estimatedTokens.toLocaleString()} />
      </div>

      {/* 3. Available sources */}
      <div style={{ height: 14 }} />
      <SubHeading>Available sources ({sourcesUsed.length})</SubHeading>
      {sourcesUsed.length === 0 ? (
        <Empty>No context sources offered this turn.</Empty>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {sourcesUsed.map((s) => (
            <span
              key={s}
              style={{
                fontSize: 10.5,
                color: colors.textMuted,
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                padding: "2px 7px",
                background: colors.panelAlt,
              }}
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CountRow({
  label,
  value,
  first,
}: {
  label: string;
  value: string | number;
  first?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 12px",
        fontSize: 12,
        color: colors.text,
        borderTop: first ? "none" : `1px solid ${colors.border}`,
      }}
    >
      <span style={{ color: colors.textMuted }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value}</span>
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
