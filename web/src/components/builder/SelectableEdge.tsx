// SelectableEdge (PLU-130) — a smoothstep edge that, when selected and editable,
// shows a midpoint toolbar naming its source/target nodes and a one-click
// Disconnect. Same geometry (getSmoothStepPath) as a plain smoothstep edge;
// stroke/marker come in via style/data so the canvas owns styling.

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "reactflow";
import { colors, font, radii } from "../../theme";
import { IconButton } from "../ds";

export interface SelectableEdgeData {
  sourceLabel: string;
  targetLabel: string;
  onDisconnect?: (edgeId: string) => void;
  readOnly?: boolean;
}

export const SelectableEdge = memo(function SelectableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<SelectableEdgeData>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const showToolbar = !!selected && !data?.readOnly;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        {...(markerEnd !== undefined ? { markerEnd } : {})}
        {...(style !== undefined ? { style } : {})}
      />
      {showToolbar && (
        <EdgeLabelRenderer>
          {/* nopan + pointerEvents so toolbar clicks don't pan the canvas. */}
          <div
            className="nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(19,20,24,0.94)",
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: radii.md,
              padding: "4px 6px 4px 10px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap",
              zIndex: 10,
            }}
          >
            <span
              style={{
                fontSize: font.size.xs,
                color: colors.textMuted,
                fontWeight: font.weight.medium,
              }}
            >
              <span style={{ color: colors.text }}>{data?.sourceLabel ?? "?"}</span>
              <span aria-hidden style={{ color: colors.textDim, margin: "0 5px" }}>
                →
              </span>
              <span style={{ color: colors.text }}>{data?.targetLabel ?? "?"}</span>
            </span>
            <IconButton
              label={`Disconnect ${data?.sourceLabel ?? ""} → ${data?.targetLabel ?? ""}`}
              size={22}
              className="ds-danger-hover"
              onClick={(e) => {
                e.stopPropagation();
                data?.onDisconnect?.(id);
              }}
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18" />
                  <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                  <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
                </svg>
              }
            />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
