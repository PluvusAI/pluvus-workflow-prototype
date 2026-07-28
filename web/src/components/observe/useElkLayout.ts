// ---------------------------------------------------------------------------
// useElkLayout — async ELK.js layered layout for the observability graph.
// ---------------------------------------------------------------------------
// React Flow renders the graph; ELK decides WHERE the nodes go. We feed ELK the
// visible states + edges and get back x/y positions for a clean top-to-bottom
// layered pipeline (main spine straight, branches fanned out). ELK runs async
// (it's a WASM-ish port), so until the first result lands we fall back to a
// synchronous curated layout so the canvas never flashes empty.
import { useEffect, useMemo, useRef, useState } from "react";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { InstanceState } from "../../api/types";
import { STATE_EDGES, PRIMARY_PATH } from "./stateGraph";

export interface XY {
  x: number;
  y: number;
}

export const NODE_W = 260;
export const NODE_H = 132;

// One ELK instance for the app (it spins a worker internally).
const elk = new ELK();

// Curated fallback positions — a straight main spine with branches to the right.
// Used only for the first paint before ELK resolves, or if ELK errors.
const FALLBACK_COL_MAIN = 40;
const FALLBACK_COL_BRANCH = 380;
const FALLBACK_COL_FAR = 720;
const FALLBACK_ROW = 190;

const FALLBACK: Record<InstanceState, XY> = {
  ENROLLED: { x: FALLBACK_COL_MAIN, y: 0 },
  OUTREACH_SENT: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW },
  AWAITING_REPLY: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 2 },
  FOLLOWED_UP: { x: FALLBACK_COL_BRANCH, y: FALLBACK_ROW * 2 },
  REPLY_RECEIVED: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 3 },
  NEGOTIATING: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 4 },
  ACCEPTED: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 5 },
  REWARD_PENDING: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 6 },
  REWARD_CONFIRMED: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 7 },
  PAYMENT_PENDING: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 8 },
  PAYMENT_RECEIVED: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 9 },
  CONTENT_BRIEF_SENT: { x: FALLBACK_COL_MAIN, y: FALLBACK_ROW * 10 },
  NEEDS_DEAL_FINALIZATION: { x: FALLBACK_COL_BRANCH, y: FALLBACK_ROW * 6 },
  HANDOFF_COMPLETE: { x: FALLBACK_COL_BRANCH, y: FALLBACK_ROW * 7 },
  AWAITING_BRAND_APPROVAL: { x: FALLBACK_COL_BRANCH, y: FALLBACK_ROW * 8 },
  REJECTED: { x: FALLBACK_COL_BRANCH, y: FALLBACK_ROW * 3 },
  MANUAL_REVIEW: { x: FALLBACK_COL_FAR, y: FALLBACK_ROW * 3.5 },
  OPTED_OUT: { x: FALLBACK_COL_BRANCH, y: FALLBACK_ROW * 5 },
  NO_RESPONSE: { x: FALLBACK_COL_FAR, y: FALLBACK_ROW * 2 },
};

/**
 * Compute ELK positions for the given set of visible states. Returns a map of
 * state → {x,y}; `ready` flips true once ELK has resolved (the caller can keep
 * using the fallback until then). Re-runs only when the *set of states* changes,
 * not on every poll — positions are structural, counts are not.
 */
export function useElkLayout(visibleStates: InstanceState[]): {
  positions: Record<string, XY>;
  ready: boolean;
} {
  // Stable key for the visible-state set so we don't relayout on count changes.
  const key = useMemo(() => [...visibleStates].sort().join(","), [visibleStates]);
  const [positions, setPositions] = useState<Record<string, XY>>(() => ({ ...FALLBACK }));
  const [ready, setReady] = useState(false);
  const latestKey = useRef(key);

  useEffect(() => {
    latestKey.current = key;
    const present = new Set(visibleStates);
    if (present.size === 0) {
      setPositions({ ...FALLBACK });
      setReady(true);
      return;
    }

    // Give ELK a stable per-primary-node priority so the happy path stays a
    // straight vertical spine and branches fan to the side.
    const priorityOf = (s: InstanceState) => {
      const i = PRIMARY_PATH.indexOf(s);
      return i >= 0 ? PRIMARY_PATH.length - i : 0;
    };

    const graph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.layered.spacing.nodeNodeBetweenLayers": "90",
        "elk.spacing.nodeNode": "64",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.crossingMinimization.semiInteractive": "true",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      },
      children: visibleStates.map((s) => ({
        id: s,
        width: NODE_W,
        height: NODE_H,
        layoutOptions: { "elk.priority": String(priorityOf(s)) },
      })),
      edges: STATE_EDGES.filter(
        (e) => e.from !== e.to && present.has(e.from) && present.has(e.to),
      ).map((e, i) => ({
        id: `e${i}`,
        sources: [e.from],
        targets: [e.to],
        // Primary edges get higher priority so ELK keeps them straight.
        layoutOptions: { "elk.priority": e.kind === "primary" ? "10" : "1" },
      })),
    };

    let cancelled = false;
    elk
      .layout(graph)
      .then((res) => {
        if (cancelled || latestKey.current !== key) return;
        const next: Record<string, XY> = {};
        for (const child of res.children ?? []) {
          next[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
        }
        setPositions(next);
        setReady(true);
      })
      .catch(() => {
        // ELK failed — keep the curated fallback, still mark ready so the canvas
        // renders something rather than hanging on a spinner.
        if (cancelled) return;
        setPositions({ ...FALLBACK });
        setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [key, visibleStates]);

  return { positions, ready };
}
