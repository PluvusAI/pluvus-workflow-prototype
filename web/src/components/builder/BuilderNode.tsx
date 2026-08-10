import { memo, type CSSProperties } from "react";
import { Handle, Position } from "reactflow";
import { colors, radii, font, shadow } from "../../theme";
import type { DraftNode } from "../../api/builderTypes";
import {
  nodeLabel,
  nodeIconComponent,
  nodeColor,
  configSummary,
  configChips,
  nodeTypeToState,
} from "./nodeMeta";
import {
  dedupeIssues,
  nodeValidity,
  type ValidationIssue,
} from "../../workflow/graphValidation";

export interface BuilderNodeData {
  node: DraftNode;
  selected: boolean;
  executionCount?: Record<string, number> | undefined;
  published?: boolean | undefined;
  /** Every validation issue attached to THIS node (config + structural), from
   * the single validateGraph() pass. Drives the border ring AND the specific
   * reason(s) shown in the card footer. Empty/undefined ⇒ node is valid. */
  issues?: ValidationIssue[] | undefined;
}

const NODE_WIDTH = 300;

export const BuilderNodeComponent = memo(function BuilderNodeComponent({
  data,
}: {
  data: BuilderNodeData;
}) {
  const { node, selected, executionCount, published, issues } = data;
  const typeColor = nodeColor(node.type);
  const Icon = nodeIconComponent(node.type);
  const label = nodeLabel(node.type);
  const summary = configSummary(node);
  const chips = configChips(node);

  // Single validity source: the issues threaded down from validateGraph().
  const nodeIssues = issues && issues.length ? dedupeIssues(issues) : [];
  const validity = nodeValidity(nodeIssues); // "ok" | "warning" | "error"
  const invalid = validity !== "ok";
  // Error → danger red; warning → amber. Used for the ring + footer text.
  const issueColor = validity === "error" ? colors.danger : colors.warning;

  const stateName = nodeTypeToState(node.type);
  const liveCount = stateName && executionCount ? executionCount[stateName] ?? 0 : null;
  const hasLive = liveCount !== null && liveCount > 0;

  // Sticker node: heavy ink border + hard offset shadow. Selection/invalidity
  // recolour the border + add a soft ring on top of the hard drop-shadow.
  const borderColor = selected ? colors.accent : invalid ? issueColor : colors.cardBorder;
  const baseShadow = shadow.md;
  const ring = selected
    ? `0 0 0 3px ${colors.accent}30, ${baseShadow}`
    : invalid
    ? `0 0 0 3px ${issueColor}22, ${baseShadow}`
    : baseShadow;

  return (
    <div
      className="ds-card-interactive"
      style={{
        width: NODE_WIDTH,
        background: colors.panel,
        border: `2px solid ${borderColor}`,
        borderRadius: radii.lg,
        overflow: "hidden",
        boxShadow: ring,
        position: "relative",
      }}
    >
      {/* Connection handles (PLU-130): a 24px transparent hit target with the
          visible 11px dot painted via CSS (.rf-handle::after), centred on the
          node edge. RF hit-tests the element box, so the large box makes
          connecting forgiving. --dot-* vars colour each handle's dot. Top =
          target (incoming), bottom = source (outgoing). */}
      <Handle
        type="target"
        position={Position.Top}
        className="rf-handle rf-handle-target"
        aria-label="Connection target (incoming)"
        style={
          {
            top: -12,
            "--dot-bg": colors.panel,
            "--dot-border": typeColor,
          } as CSSProperties
        }
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="rf-handle rf-handle-source"
        aria-label="Drag to connect (outgoing)"
        style={
          {
            bottom: -12,
            "--dot-bg": typeColor,
            "--dot-border": colors.panel,
          } as CSSProperties
        }
      />

      {/* Accent rail — fades out so it reads as a highlight, not a border */}
      <div
        style={{
          height: 2,
          background: `linear-gradient(90deg, ${typeColor}, ${typeColor}00)`,
        }}
      />

      <div style={{ padding: "13px 15px 14px" }}>
        {/* Header: icon · name · status dot */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: `${typeColor}2e`,
              border: `1.5px solid ${colors.cardBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: colors.text,
              flexShrink: 0,
            }}
          >
            <Icon size={16} strokeWidth={2.25} />
          </span>
          <span
            style={{
              fontSize: font.size.md,
              fontWeight: font.weight.semibold,
              color: colors.text,
              letterSpacing: -0.1,
            }}
          >
            {label}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {published && (
              <span
                title="Published"
                style={{ fontSize: 10, color: colors.success, fontWeight: font.weight.bold }}
              >
                ✓
              </span>
            )}
            {hasLive && (
              <span
                title={`${liveCount} in this stage`}
                className="nums"
                style={{
                  background: typeColor,
                  color: "#fff",
                  borderRadius: radii.pill,
                  fontSize: 10.5,
                  fontWeight: font.weight.bold,
                  padding: "1px 8px",
                  lineHeight: 1.7,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
                }}
              >
                {liveCount}
              </span>
            )}
          </span>
        </div>

        {/* Body: one-line summary. Stays the friendly "what this node does"
            line even when invalid — the specific reason is shown in the footer
            so the user sees both context and problem. */}
        <div
          style={{
            fontSize: font.size.sm,
            color: colors.textMuted,
            lineHeight: 1.5,
            marginTop: 9,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </div>

        {/* Body: config chips */}
        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
            {chips.map((c, i) => (
              <span
                key={i}
                style={{
                  fontSize: 10.5,
                  fontWeight: font.weight.medium,
                  color: colors.textMuted,
                  background: colors.panelAlt,
                  border: `1px solid ${colors.border}`,
                  borderRadius: radii.pill,
                  padding: "1px 8px",
                  lineHeight: 1.7,
                  whiteSpace: "nowrap",
                }}
              >
                {c}
              </span>
            ))}
          </div>
        )}

        {/* Footer: the SPECIFIC reason(s) this node is invalid — no more generic
            "Needs configuration". One row per distinct issue, color-coded by
            severity so the user sees exactly what to fix, right on the node. */}
        {invalid && (
          <div
            style={{
              marginTop: 10,
              paddingTop: 9,
              borderTop: `1px solid ${colors.border}`,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {nodeIssues.map((issue, i) => {
              const color = issue.severity === "error" ? colors.danger : colors.warning;
              return (
                <div
                  key={issue.code + i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 5,
                    fontSize: 10.5,
                    color,
                    fontWeight: font.weight.semibold,
                    lineHeight: 1.35,
                  }}
                >
                  <span aria-hidden style={{ flexShrink: 0 }}>
                    {issue.severity === "error" ? "⚠" : "○"}
                  </span>
                  <span>{issue.message}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
