// ---------------------------------------------------------------------------
// GraphCanvas (Phase 17) — the real drag-and-drop workflow editor.
// ---------------------------------------------------------------------------
// React Flow is now an actual editor, not a renderer. Nodes are draggable,
// connectable, and deletable; edges are reconnectable and deletable; new nodes
// are dropped in from the palette. The component is CONTROLLED: the parent owns
// the WorkflowDefinition (source of truth) and this component emits changes back
// through a single `onChange(next)` callback. React Flow's internal state is
// derived from the definition each render, so the graph model and the canvas can
// never drift.
// ---------------------------------------------------------------------------

import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
  useNodesState,
  useEdgesState,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import { BuilderNodeComponent } from "./BuilderNode";
import { SelectableEdge, type SelectableEdgeData } from "./SelectableEdge";
import { NodePalette, PALETTE_DND_MIME } from "./NodePalette";
import { nodeColor, nodeLabel } from "./nodeMeta";
import { colors } from "../../theme";
import { useToast } from "../ds";
import {
  defaultConfigFor,
  freshNodeId,
} from "../../workflow/nodeDefaults";
import {
  edgeId as makeEdgeId,
  NODE_WIDTH,
  NODE_HEIGHT,
  type WorkflowDefinition,
  type GraphNode,
  type GraphEdge,
} from "../../workflow/graphModel";
import {
  canConnect,
  canReconnect,
  applyConnect,
  applyReconnect,
  applyDisconnect,
} from "../../workflow/connectionRules";
import type { DraftNode, NodeType } from "../../api/builderTypes";
import { issuesByNode, type ValidationIssue } from "../../workflow/graphValidation";

const NODE_TYPES = { builderNode: BuilderNodeComponent };
const EDGE_TYPES = { selectable: SelectableEdge };

interface Props {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  executionCounts?: Record<string, number> | undefined;
  published?: boolean | undefined;
  /** Node-level validation issues, for red-ringing invalid nodes on the canvas
   * AND showing the specific reason(s) in each node's footer. */
  issues?: ValidationIssue[];
  /** When set, pan/center the canvas onto this node (click-to-focus from the
   * issues panel / sidebar). A `{ id, nonce }` shape so re-focusing the SAME
   * node still fires (the nonce changes each click). */
  focusNode?: { id: string; nonce: number } | null;
  /** Disable all editing (e.g. read-only contexts). */
  readOnly?: boolean;
}

export function GraphCanvas(props: Props) {
  // ReactFlowProvider is required for useReactFlow (coordinate projection on drop).
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner({
  definition,
  onChange,
  selectedNodeId,
  onSelectNode,
  executionCounts,
  published,
  issues,
  focusNode,
  readOnly = false,
}: Props) {
  const rf = useReactFlow();
  const toast = useToast();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // PLU-130: selectedEdgeId drives the edge toolbar (single source of truth, fed
  // into buildRfEdges); reconnectingEdgeId lets isValidConnection exclude the
  // in-flight edge during a reconnect drag.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const reconnectingEdgeId = useRef<string | null>(null);

  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Node-id → label lookup for edge toolbars.
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of definition.nodes) m.set(n.id, nodeLabel(n.type));
    return m;
  }, [definition.nodes]);

  const isLive = useMemo(
    () => !!executionCounts && Object.values(executionCounts).some((v) => v > 0),
    [executionCounts],
  );

  // Per-node issue buckets → red/amber ring + the specific reason(s) rendered
  // in each node's footer. Single source: the validateGraph() output passed in.
  const nodeIssueMap = useMemo(() => issuesByNode(issues ?? []), [issues]);

  // -------------------------------------------------------------------------
  // React Flow owns the LIVE interactive node/edge state (via useNodesState /
  // useEdgesState). This is essential: during a drag, RF mutates this internal
  // state itself through applyNodeChanges — so nodes move natively and never
  // "disappear" (the previous fully-controlled approach fought RF's drag loop by
  // re-deriving every node object each render). We sync in two directions:
  //   • inward  — when the parent `definition` changes (add node, delete, load,
  //               reorder), we rebuild RF's state from it.
  //   • outward — on RF changes we apply them locally AND push the meaningful
  //               ones (positions, removals, connections) up to the definition.
  // -------------------------------------------------------------------------
  const [rfNodes, setRfNodes, onNodesChangeInternal] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChangeInternal] = useEdgesState([]);

  // Build RF nodes/edges from the definition. Presentational data (selection,
  // live counts, validity ring) is layered on here.
  const buildRfNodes = useCallback(
    (def: WorkflowDefinition): Node[] =>
      def.nodes.map((n) => {
        const draft: DraftNode = { id: n.id, type: n.type, order: 0, config: n.config };
        return {
          id: n.id,
          type: "builderNode",
          position: n.position,
          data: {
            node: draft,
            selected: n.id === selectedNodeId,
            executionCount: executionCounts,
            published,
            issues: nodeIssueMap.get(n.id),
          },
          selected: n.id === selectedNodeId,
          draggable: !readOnly,
          connectable: !readOnly,
        };
      }),
    [selectedNodeId, executionCounts, published, nodeIssueMap, readOnly],
  );

  // Disconnect one edge (toolbar action) + clear its selection.
  const disconnectEdge = useCallback(
    (edgeIdToRemove: string) => {
      if (readOnly) return;
      const def = definitionRef.current;
      onChangeRef.current({ ...def, edges: applyDisconnect(def, edgeIdToRemove) });
      setSelectedEdgeId((cur) => (cur === edgeIdToRemove ? null : cur));
    },
    [readOnly],
  );

  const buildRfEdges = useCallback(
    (def: WorkflowDefinition): Edge<SelectableEdgeData>[] =>
      def.edges.map((e) => {
        // Selected edge lifts to accent + thicker + raised zIndex so it's
        // separable from a converging bundle (A8).
        const isSelected = e.id === selectedEdgeId;
        const stroke = isSelected ? colors.accent : colors.borderStrong;
        const edge: Edge<SelectableEdgeData> = {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "selectable",
          updatable: !readOnly,
          selected: isSelected,
          zIndex: isSelected ? 10 : 0,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: stroke,
            width: 16,
            height: 16,
          },
          style: { stroke, strokeWidth: isSelected ? 3 : 2 },
          animated: isLive,
          data: {
            sourceLabel: labelById.get(e.source) ?? e.source,
            targetLabel: labelById.get(e.target) ?? e.target,
            onDisconnect: disconnectEdge,
            readOnly,
          },
        };
        if (isSelected) edge.className = "rf-edge-selected";
        return edge;
      }),
    [readOnly, isLive, selectedEdgeId, labelById, disconnectEdge],
  );

  // Inward sync: rebuild RF state whenever the STRUCTURE of the definition
  // changes. We key on the set of node ids + edge ids (and positions) rather
  // than object identity so that a same-shape re-render (e.g. after our own
  // outward sync) doesn't clobber RF mid-interaction, but real changes (add /
  // delete / load / reorder / drag from elsewhere) do refresh the canvas.
  const nodeStructureKey = useMemo(
    () => definition.nodes.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join("|"),
    [definition.nodes],
  );
  const edgeStructureKey = useMemo(
    () => definition.edges.map((e) => e.id).join("|"),
    [definition.edges],
  );

  useEffect(() => {
    setRfNodes(buildRfNodes(definition));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeStructureKey, buildRfNodes]);

  useEffect(() => {
    setRfEdges(buildRfEdges(definition));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeStructureKey, buildRfEdges]);

  // Click-to-focus: when the parent asks to focus a node (from the issues panel
  // or sidebar), smoothly center the canvas on it. Keyed on the nonce so
  // re-focusing the same node still pans. Guards against a stale/removed id.
  useEffect(() => {
    if (!focusNode) return;
    const target = definition.nodes.find((n) => n.id === focusNode.id);
    if (!target) return;
    const cx = target.position.x + NODE_WIDTH / 2;
    const cy = target.position.y + NODE_HEIGHT / 2;
    rf.setCenter(cx, cy, { zoom: Math.max(rf.getZoom(), 0.9), duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNode?.id, focusNode?.nonce]);

  // -- node changes: let RF apply them, then sync structure outward ---------
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (readOnly) {
        onNodesChangeInternal(changes.filter((c) => c.type === "select" || c.type === "dimensions"));
        return;
      }

      // Any node may be deleted — graph validation guarantees a valid terminal
      // and phase order, so there's no need to hard-lock specific node types.
      const removeIds = new Set<string>();
      for (const c of changes) {
        if (c.type === "remove") removeIds.add(c.id);
      }
      const allowed = changes;

      // Apply to RF's live state so dragging is smooth + native.
      onNodesChangeInternal(allowed);

      // Sync outward only for changes that alter the persisted structure:
      // final drag positions (dragging === false) and removals.
      const hasRemoval = removeIds.size > 0;
      const settledDrag = allowed.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      if (!hasRemoval && !settledDrag) return;

      // Determine final positions: prefer the position carried on the settling
      // change events, falling back to RF's store (authoritative for anything
      // not in this batch). Then push structure to the definition.
      const posById = new Map(rf.getNodes().map((n) => [n.id, n.position]));
      for (const c of allowed) {
        if (c.type === "position" && c.position) posById.set(c.id, c.position);
      }
      const nextNodes = definition.nodes
        .filter((n) => !removeIds.has(n.id))
        .map((n) => ({ ...n, position: posById.get(n.id) ?? n.position }));
      let nextEdges = definition.edges;
      if (hasRemoval) {
        nextEdges = definition.edges.filter(
          (e) => !removeIds.has(e.source) && !removeIds.has(e.target),
        );
        // Auto-heal: reconnect a deleted node's single predecessor to its single
        // successor so a mid-chain delete keeps the flow linear.
        for (const id of removeIds) {
          const preds = definition.edges.filter((e) => e.target === id).map((e) => e.source);
          const succs = definition.edges.filter((e) => e.source === id).map((e) => e.target);
          if (
            preds.length === 1 &&
            succs.length === 1 &&
            preds[0] !== succs[0] &&
            !removeIds.has(preds[0]!) &&
            !removeIds.has(succs[0]!)
          ) {
            const healId = makeEdgeId(preds[0]!, succs[0]!);
            if (!nextEdges.some((e) => e.id === healId)) {
              nextEdges = [...nextEdges, { id: healId, source: preds[0]!, target: succs[0]! }];
            }
          }
        }
      }
      onChange({ ...definition, nodes: nextNodes, edges: nextEdges });
      if (hasRemoval && selectedNodeId && removeIds.has(selectedNodeId)) onSelectNode(null);
    },
    [definition, onChange, readOnly, selectedNodeId, onSelectNode, onNodesChangeInternal, rf],
  );

  // -- edge changes: apply to RF, sync removals outward ---------------------
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChangeInternal(changes);
      if (readOnly) return;
      const removeIds = new Set<string>();
      for (const c of changes) if (c.type === "remove") removeIds.add(c.id);
      if (removeIds.size) {
        onChange({ ...definition, edges: definition.edges.filter((e) => !removeIds.has(e.id)) });
      }
    },
    [definition, onChange, readOnly, onEdgesChangeInternal],
  );

  // -- helper to emit new edges (connect / reconnect) -----------------------
  const emitEdges = useCallback(
    (edges: GraphEdge[]) => onChange({ ...definition, edges }),
    [definition, onChange],
  );

  // Live drag feedback (RF adds `react-flow__handle-valid` where this is true).
  // Same rules as commit, so the highlight can't disagree with the drop; during
  // a reconnect the in-flight edge is excluded (see canReconnect).
  const isValidConnection = useCallback(
    (conn: Connection) => {
      const moving = reconnectingEdgeId.current;
      const verdict = moving
        ? canReconnect(definition, moving, conn.source, conn.target)
        : canConnect(definition, conn.source, conn.target);
      return verdict.ok;
    },
    [definition],
  );

  // New connection: applyConnect reroutes the source's "next" (insert, not
  // branch); an invalid connection is blocked with an explanatory toast.
  const onConnect = useCallback(
    (conn: Connection) => {
      if (readOnly || !conn.source || !conn.target) return;
      const verdict = canConnect(definition, conn.source, conn.target);
      if (!verdict.ok) {
        toast.error(verdict.reason);
        return;
      }
      emitEdges(applyConnect(definition, conn.source, conn.target));
    },
    [definition, emitEdges, readOnly, toast],
  );

  // Reconnect an existing edge's endpoint (blocked with a toast if invalid).
  const onReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      if (readOnly || !conn.source || !conn.target) return;
      const verdict = canReconnect(definition, oldEdge.id, conn.source, conn.target);
      if (!verdict.ok) {
        toast.error(verdict.reason);
        return;
      }
      emitEdges(applyReconnect(definition, oldEdge.id, conn.source, conn.target));
    },
    [definition, emitEdges, readOnly, toast],
  );

  // Track the in-flight edge for isValidConnection; always cleared on end.
  const onEdgeUpdateStart = useCallback((_: unknown, edge: Edge) => {
    reconnectingEdgeId.current = edge.id;
  }, []);
  const onEdgeUpdateEnd = useCallback(() => {
    reconnectingEdgeId.current = null;
  }, []);

  // -- selection -----------------------------------------------------------
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedEdgeId(null); // node + edge selection are mutually exclusive
      onSelectNode(node.id === selectedNodeId ? null : node.id);
    },
    [onSelectNode, selectedNodeId],
  );
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      onSelectNode(null); // clear node selection so only the edge toolbar shows
      setSelectedEdgeId((cur) => (cur === edge.id ? null : edge.id));
    },
    [onSelectNode],
  );
  const onPaneClick = useCallback(() => {
    onSelectNode(null);
    setSelectedEdgeId(null);
  }, [onSelectNode]);

  // -- drop a new node from the palette ------------------------------------
  // A newly added node lands FREE — no edges are drawn for it. The user wires
  // it into the flow themselves by dragging between the visible handles (drag a
  // node's bottom dot to another node's top dot). This keeps adding a node from
  // silently rerouting the graph.
  const addNodeOfType = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      const id = freshNodeId(type);
      const node: GraphNode = { id, type, position, config: defaultConfigFor(type) };
      onChange({ ...definition, nodes: [...definition.nodes, node] });
      onSelectNode(id);
    },
    [definition, onChange, onSelectNode],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (readOnly) return;
      const type = event.dataTransfer.getData(PALETTE_DND_MIME) as NodeType;
      if (!type) return;
      const projected = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      // Center the node under the cursor.
      addNodeOfType(type, { x: projected.x - NODE_WIDTH / 2, y: projected.y - NODE_HEIGHT / 2 });
    },
    [rf, addNodeOfType, readOnly],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Click-to-append (accessible palette fallback): drop near the bottom of the
  // current content so it lands in view.
  const appendNodeOfType = useCallback(
    (type: NodeType) => {
      const maxY = definition.nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
      addNodeOfType(type, { x: 160, y: maxY + NODE_HEIGHT + 64 });
    },
    [definition.nodes, addNodeOfType],
  );

  return (
    <div style={{ display: "flex", height: "100%", width: "100%" }}>
      {!readOnly && (
        <div
          style={{
            width: 228,
            flexShrink: 0,
            borderRight: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
          <NodePalette onAdd={appendNodeOfType} />
        </div>
      )}
      <div ref={wrapperRef} style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeUpdate={onReconnect}
          onEdgeUpdateStart={onEdgeUpdateStart}
          onEdgeUpdateEnd={onEdgeUpdateEnd}
          isValidConnection={isValidConnection}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onDrop={onDrop}
          onDragOver={onDragOver}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.25}
          maxZoom={1.75}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          // PLU-130: forgiving connect + edge-endpoint grab zones.
          connectionRadius={20}
          edgeUpdaterRadius={16}
          panOnDrag
          zoomOnScroll
          style={{ background: colors.bg }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} color="#22242c" gap={24} size={1.5} />
          <Controls
            showInteractive={false}
            style={{
              background: colors.panel,
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 10,
              overflow: "hidden",
              boxShadow: "0 2px 6px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.28)",
            }}
          />
          <MiniMap
            pannable
            zoomable
            ariaLabel="Workflow minimap"
            style={{
              background: colors.panel,
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 10,
              boxShadow: "0 2px 6px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.28)",
            }}
            maskColor="rgba(11,12,15,0.7)"
            nodeColor={(n) => {
              const data = n.data as { node?: DraftNode } | undefined;
              return data?.node ? nodeColor(data.node.type) : colors.border;
            }}
            nodeStrokeWidth={0}
            nodeBorderRadius={4}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
