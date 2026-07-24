import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  useWorkflow,
  useWorkflowVersions,
  saveDraft,
  publishWorkflow,
  validateWorkflow,
  useBuilderInvalidator,
  useWorkflowExecution,
} from "../../api/builderClient";
import { colors, radii, font, formatTimestamp } from "../../theme";
import { GraphCanvas } from "./GraphCanvas";
import { BuilderLeftSidebar } from "./BuilderLeftSidebar";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { EnrollTab } from "./EnrollTab";
import { LaunchTab } from "./LaunchTab";
import { MonitorTab } from "./MonitorTab";
import { ManualQueueTab } from "./ManualQueueTab";
import {
  Button,
  IconButton,
  Breadcrumbs,
  Tabs,
  StatusBadge,
  EmptyState,
  Tooltip,
  Skeleton,
  SkeletonRows,
  useToast,
  useMediaQuery,
  bp,
  type Crumb,
} from "../ds";
import type { DraftNode } from "../../api/builderTypes";
import {
  linearNodesToGraph,
  graphToLinearNodes,
  topologicalOrder,
  defaultPositionForIndex,
  edgeId,
  type WorkflowDefinition,
  type GraphNode,
} from "../../workflow/graphModel";
import {
  validateGraph,
  issuesByNode,
  dedupeIssues,
  type ValidationIssue,
} from "../../workflow/graphValidation";
import { nodeLabel, nodeIconComponent } from "./nodeMeta";

type Tab = "build" | "enroll" | "launch" | "monitor" | "queue";

interface Props {
  workflowId: string;
  onBack: () => void;
}

export function WorkflowBuilder({ workflowId, onBack }: Props) {
  const wfQuery = useWorkflow(workflowId);
  const versionsQuery = useWorkflowVersions(workflowId);
  const execution = useWorkflowExecution(workflowId);
  const inv = useBuilderInvalidator(workflowId);
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("build");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // The workflow GRAPH is the editor's source of truth. It is derived from the
  // server's draftNodes on load and serialized back to draftNodes on save.
  const [localDef, setLocalDef] = useState<WorkflowDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Publish-attempt failures, kept as structured issues so each one stays
  // clickable + tied to its node (not a flat string wall).
  const [publishIssues, setPublishIssues] = useState<ValidationIssue[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  // Which node the canvas should pan to. Nonce bumps each request so clicking
  // the same node twice still re-centers.
  const [focusNode, setFocusNode] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compact = useMediaQuery(bp.laptop);

  const wf = wfQuery.data;

  // Remembers the last non-empty definition we rendered, so a transient query
  // state (e.g. `wf` momentarily undefined during an invalidate→refetch) can
  // never blank the canvas by falling back to an empty graph.
  const lastGoodDefRef = useRef<WorkflowDefinition | null>(null);

  // Seed the local graph from server draftNodes the first time they arrive. We
  // DON'T continuously sync from server data — local edits take priority
  // (mirrors the previous localNodes ?? draftNodes behaviour).
  const serverNodes = wf?.draftNodes;
  useEffect(() => {
    if (localDef === null && serverNodes && serverNodes.length > 0) {
      setLocalDef(linearNodesToGraph(serverNodes));
    }
  }, [localDef, serverNodes]);

  // The definition currently being edited. Fallbacks, in priority order:
  //   1. localDef (active edits, source of truth)
  //   2. a live conversion of server draftNodes (first render before the effect)
  //   3. the last non-empty def we held (guards against a transient empty server
  //      response blanking the canvas — the disappearing-workflow bug)
  const def: WorkflowDefinition = useMemo(() => {
    if (localDef) return localDef;
    const fromServer =
      serverNodes && serverNodes.length > 0 ? linearNodesToGraph(serverNodes) : null;
    if (fromServer) return fromServer;
    if (lastGoodDefRef.current) return lastGoodDefRef.current;
    return linearNodesToGraph([]);
  }, [localDef, serverNodes]);

  // Track the last non-empty def for the fallback above.
  useEffect(() => {
    if (def.nodes.length > 0) lastGoodDefRef.current = def;
  }, [def]);

  // Live client-side validation — drives inline error display + node red-rings.
  const validation = useMemo(() => validateGraph(def), [def]);

  // Per-node issue buckets, derived once and threaded to the canvas, sidebar,
  // and issues panel — the SINGLE validity source (no more nodeWarning drift).
  const nodeIssues = useMemo(() => issuesByNode(validation.errors), [validation.errors]);

  // Select a node AND pan the canvas to it — used by the issues panel + publish
  // banner for click-to-focus navigation.
  const focusOnNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    focusNonce.current += 1;
    setFocusNode({ id: nodeId, nonce: focusNonce.current });
  }, []);

  // Display-facing linear nodes (clean configs, derived order) for the sidebar +
  // config panel, which speak DraftNode[]. Order comes from the topological walk.
  const displayNodes: DraftNode[] = useMemo(
    () =>
      topologicalOrder(def).map((n, i) => ({
        id: n.id,
        type: n.type,
        order: i,
        config: n.config,
      })),
    [def],
  );

  const selectedNode = displayNodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedIndex = selectedNode
    ? displayNodes.findIndex((n) => n.id === selectedNode.id)
    : -1;

  // -- persistence ---------------------------------------------------------
  function scheduleSave(nextDef: WorkflowDefinition) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void doSave(nextDef);
    }, 1000);
  }

  const doSave = useCallback(
    async (defToSave: WorkflowDefinition) => {
      // Guard: never persist an empty graph that only exists because the
      // server data hadn't loaded yet (the `def` fallback is `[]`). Saving that
      // would wipe a real draft. A genuine "user deleted every node" is
      // vanishingly rare and still recoverable via re-publish, so we simply
      // refuse to auto-save an empty graph.
      if (defToSave.nodes.length === 0) {
        setSaving(false);
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        // Serialize the graph down to the runtime's linear ordered array (with
        // graph metadata stashed in the runtime-ignored `_graph` sidecar).
        const linear = graphToLinearNodes(defToSave);
        const res = await saveDraft(workflowId, linear);
        await inv.invalidateWorkflow();
        setSavedAt(res.updatedAt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Save failed";
        setSaveError(msg);
        toast.error(`Couldn't save draft: ${msg}`);
      } finally {
        setSaving(false);
      }
    },
    [workflowId, inv, toast],
  );

  // -- graph edits (from the canvas) ---------------------------------------
  const handleGraphChange = useCallback(
    (next: WorkflowDefinition) => {
      setLocalDef(next);
      scheduleSave(next);
    },
    // scheduleSave is stable enough (only reads refs); intentionally omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // -- config panel edits --------------------------------------------------
  function handleNodeUpdate(nodeId: string, config: Record<string, unknown>) {
    const next: WorkflowDefinition = {
      ...def,
      nodes: def.nodes.map((n) =>
        n.id === nodeId ? { ...n, config: config as GraphNode["config"] } : n,
      ),
    };
    setLocalDef(next);
    scheduleSave(next);
  }

  function handleDeleteNode(nodeId: string) {
    // Auto-heal the chain: if the deleted node sat between a single predecessor
    // and a single successor, reconnect them so a mid-chain delete keeps the
    // flow linear (instead of leaving two disconnected halves the user has to
    // manually rewire). Branches/merges are left as-is for validation to flag.
    const preds = def.edges.filter((e) => e.target === nodeId).map((e) => e.source);
    const succs = def.edges.filter((e) => e.source === nodeId).map((e) => e.target);
    const remainingEdges = def.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
    if (preds.length === 1 && succs.length === 1 && preds[0] !== succs[0]) {
      const healId = edgeId(preds[0]!, succs[0]!);
      if (!remainingEdges.some((e) => e.id === healId)) {
        remainingEdges.push({ id: healId, source: preds[0]!, target: succs[0]! });
      }
    }
    const next: WorkflowDefinition = {
      ...def,
      nodes: def.nodes.filter((n) => n.id !== nodeId),
      edges: remainingEdges,
    };
    setLocalDef(next);
    setSelectedNodeId(null);
    scheduleSave(next);
  }

  // Move up/down operate on the current linear order: reorder the chain, then
  // rebuild the linear edges + re-layout positions to match. Keeps the config
  // panel's existing ↑/↓ buttons meaningful in the graph world.
  function reorderLinear(nodeId: string, dir: -1 | 1) {
    const ordered = topologicalOrder(def);
    const idx = ordered.findIndex((n) => n.id === nodeId);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= ordered.length) return;
    const next = [...ordered];
    const a = next[idx]!;
    const b = next[swapWith]!;
    next[idx] = b;
    next[swapWith] = a;
    relayoutLinear(next);
  }

  function relayoutLinear(orderedNodes: GraphNode[]) {
    const nodes = orderedNodes.map((n, i) => ({ ...n, position: defaultPositionForIndex(i) }));
    const edges = nodes.slice(0, -1).map((n, i) => {
      const target = nodes[i + 1]!;
      return { id: edgeId(n.id, target.id), source: n.id, target: target.id };
    });
    const next: WorkflowDefinition = { ...def, nodes, edges };
    setLocalDef(next);
    scheduleSave(next);
  }

  const handleMoveUp = (nodeId: string) => reorderLinear(nodeId, -1);
  const handleMoveDown = (nodeId: string) => reorderLinear(nodeId, 1);

  // "Tidy layout" — snap the current graph into a clean linear chain (positions
  // + edges re-linked in topological order). Handy after free-form editing to
  // normalize before publishing.
  function handleAutoArrange() {
    relayoutLinear(topologicalOrder(def));
    toast.success("Tidied into a linear flow.");
  }

  async function handlePublish() {
    setPublishing(true);
    setPublishError(null);
    setPublishIssues([]);

    // Client-side gate first — fast feedback, no round-trip if obviously invalid.
    const local = validateGraph(def);
    if (!local.valid) {
      setPublishIssues(local.errors.filter((e) => e.severity === "error"));
      setPublishing(false);
      toast.error("Validation failed — fix the highlighted issues before publishing.");
      return;
    }

    // Flush any pending save so the server validates + publishes the latest graph.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await doSave(def);

    try {
      const remote = await validateWorkflow(workflowId);
      if (!remote.valid) {
        // Prefer the server's structured issues (node-tied → clickable). Fall
        // back to wrapping the plain error strings as graph-level issues.
        const issues: ValidationIssue[] =
          remote.issues && remote.issues.length
            ? remote.issues.filter((i) => i.severity === "error")
            : remote.errors.map((message, i) => ({
                code: `REMOTE_${i}`,
                message,
                severity: "error" as const,
              }));
        setPublishIssues(issues);
        setPublishing(false);
        toast.error("Validation failed — fix the highlighted issues before publishing.");
        return;
      }
      const res = await publishWorkflow(workflowId);
      await Promise.all([inv.invalidateWorkflow(), inv.invalidateVersions()]);
      // NOTE: we deliberately DO NOT reset localDef to null here. Publishing only
      // creates an immutable version + flips status to PUBLISHED — it never
      // changes draftNodes. The current `def` was just saved (doSave above) and is
      // authoritative, so keeping it avoids a re-seed race where the graph briefly
      // falls back to an empty definition (which made the canvas "disappear").
      toast.success(`Published version v${res.version}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Publish failed";
      setPublishError(msg);
      toast.error(`Publish failed: ${msg}`);
    } finally {
      setPublishing(false);
    }
  }

  const executionCounts = execution.data?.stateCounts;
  const queueCount = executionCounts?.["MANUAL_REVIEW"] ?? 0;

  // -- loading / error states --------------------------------------------
  if (wfQuery.isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 20px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
          <Skeleton width={26} height={26} radius={7} />
          <Skeleton width={220} height={13} />
          <div style={{ flex: 1 }} />
          <Skeleton width={76} height={24} radius={999} />
        </div>
        <div style={{ flex: 1, padding: 24 }}>
          <SkeletonRows count={4} height={64} />
        </div>
      </div>
    );
  }

  if (wfQuery.isError || !wf) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load workflow"
        description="The workflow could not be loaded. It may have been deleted, or the server is unreachable."
        action={
          <Button variant="secondary" onClick={onBack} leftIcon="←">
            Back to campaigns
          </Button>
        }
      />
    );
  }

  const isPublished = wf.status === "PUBLISHED";

  const crumbs: Crumb[] = [
    { label: "Campaigns", onClick: onBack },
    ...(wf.campaign ? [{ label: wf.campaign.name }] : []),
    { label: wf.name },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      {/* Builder header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "11px 20px",
          borderBottom: `1px solid ${colors.border}`,
          background: colors.panel,
          flexShrink: 0,
        }}
      >
        <IconButton label="Back to campaigns" icon="←" onClick={onBack} />
        <div style={{ width: 1, height: 16, background: colors.borderStrong }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Breadcrumbs items={crumbs} />
        </div>
        <StatusBadge status={wf.status} />
        {wf.latestVersion && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowVersions((v) => !v)}
            aria-expanded={showVersions}
          >
            v{wf.latestVersion.version}
          </Button>
        )}
        <SaveStatus saving={saving} error={saveError} savedAt={savedAt} />
      </div>

      {/* Tab bar */}
      <div style={{ flexShrink: 0 }}>
        <Tabs<Tab>
          active={activeTab}
          onChange={setActiveTab}
          items={[
            { key: "build", label: "Build" },
            { key: "enroll", label: "Enroll" },
            { key: "launch", label: "Launch" },
            { key: "monitor", label: "Monitor" },
            {
              key: "queue",
              label: "Manual Queue",
              badge:
                queueCount > 0 ? (
                  <span
                    style={{
                      minWidth: 18,
                      height: 18,
                      padding: "0 5px",
                      borderRadius: 9,
                      background: colors.warning,
                      color: "#1b1300",
                      fontSize: font.size.xs,
                      fontWeight: font.weight.bold,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {queueCount}
                  </span>
                ) : undefined,
            },
          ]}
        />
      </div>

      {/* Versions drawer */}
      {showVersions && (
        <div
          className="ds-fade-in"
          style={{
            padding: "12px 20px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.panelAlt,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              color: colors.textDim,
              fontSize: font.size.xs,
              fontWeight: font.weight.semibold,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginRight: 4,
            }}
          >
            Version history
          </span>
          {versionsQuery.data?.length
            ? versionsQuery.data.map((v) => {
                const isCurrent = v.version === wf.latestVersion?.version;
                return (
                  <span
                    key={v.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: font.size.sm,
                      color: isCurrent ? colors.text : colors.textMuted,
                      background: isCurrent ? `${colors.accent}17` : colors.panel,
                      border: `1px solid ${isCurrent ? `${colors.accent}40` : colors.border}`,
                      borderRadius: 999,
                      padding: "3px 12px",
                      lineHeight: 1.5,
                    }}
                  >
                    <span style={{ fontWeight: font.weight.semibold, color: isCurrent ? colors.accent : colors.text }}>
                      v{v.version}
                    </span>
                    <span style={{ color: colors.textDim }}>
                      {v.instanceCount} instance{v.instanceCount !== 1 ? "s" : ""} · {formatTimestamp(v.publishedAt)}
                    </span>
                  </span>
                );
              })
            : (
              <span style={{ fontSize: font.size.sm, color: colors.textDim }}>No published versions yet.</span>
            )}
        </div>
      )}

      {/* Validation errors (publish attempt) — de-duped, and each row that maps
          to a node is clickable to jump straight to it. */}
      {publishIssues.length > 0 && (
        <div
          className="ds-fade-in"
          style={{
            padding: "10px 20px",
            background: `${colors.danger}0f`,
            borderBottom: `1px solid ${colors.danger}40`,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: font.size.md, color: colors.danger, fontWeight: font.weight.semibold }}>
              Can't publish yet — fix {dedupeIssues(publishIssues).length} issue
              {dedupeIssues(publishIssues).length !== 1 ? "s" : ""}:
            </span>
            <IconButton
              label="Dismiss"
              icon="✕"
              size={22}
              onClick={() => setPublishIssues([])}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {dedupeIssues(publishIssues).map((issue, i) => {
              const node = issue.nodeId
                ? displayNodes.find((n) => n.id === issue.nodeId)
                : undefined;
              const clickable = !!node;
              return (
                <button
                  key={issue.code + i}
                  onClick={clickable ? () => focusOnNode(node!.id) : undefined}
                  disabled={!clickable}
                  className={clickable ? "ds-focusable" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "2px 0",
                    fontSize: font.size.sm,
                    color: colors.danger,
                    cursor: clickable ? "pointer" : "default",
                  }}
                >
                  <span aria-hidden>·</span>
                  {node &&
                    (() => {
                      const NIcon = nodeIconComponent(node.type);
                      return (
                        <span
                          style={{
                            fontWeight: font.weight.semibold,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <NIcon size={12} strokeWidth={2.25} style={{ flexShrink: 0 }} />
                          {nodeLabel(node.type)}:
                        </span>
                      );
                    })()}
                  <span>{issue.message}</span>
                  {clickable && (
                    <span aria-hidden style={{ color: colors.textDim, fontSize: font.size.xs }}>
                      → jump
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {activeTab === "build" ? (
          <>
            {/* Left sidebar */}
            {!compact && (
              <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${colors.border}` }}>
                <BuilderLeftSidebar
                  workflow={wf}
                  nodes={displayNodes}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                  execution={execution.data}
                  versionCount={versionsQuery.data?.length ?? 0}
                  nodeIssues={nodeIssues}
                />
              </div>
            )}

            {/* Canvas */}
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              <GraphCanvas
                definition={def}
                onChange={handleGraphChange}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                executionCounts={executionCounts}
                published={isPublished}
                issues={validation.errors}
                focusNode={focusNode}
              />

              {/* Live validity pill + publish bar */}
              <div
                style={{
                  position: "absolute",
                  bottom: 20,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  background: "rgba(19,20,24,0.92)",
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                  border: `1px solid ${colors.borderStrong}`,
                  borderRadius: radii.lg,
                  padding: "10px 12px 10px 18px",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4), 0 24px 64px rgba(0,0,0,0.5)",
                  maxWidth: "min(760px, calc(100% - 48px))",
                }}
              >
                <IssuesPanel
                  validation={validation}
                  displayNodes={displayNodes}
                  onFocusNode={focusOnNode}
                />
                <Tooltip content="Snap every step into a clean top-to-bottom flow and re-link them in order. Use it to tidy up after free-form editing.">
                  <Button variant="secondary" size="sm" onClick={handleAutoArrange}>
                    Tidy layout
                  </Button>
                </Tooltip>
                <div style={{ width: 1, height: 20, background: colors.borderStrong }} />
                <span style={{ fontSize: font.size.sm, color: colors.textMuted }}>
                  {isPublished ? "Re-publish to apply draft changes" : "Ready to go live?"}
                </span>
                <Button variant="primary" onClick={() => void handlePublish()} disabled={publishing}>
                  {publishing ? "Publishing…" : "Publish version"}
                </Button>
                {publishError && (
                  <span style={{ fontSize: font.size.sm, color: colors.danger }}>{publishError}</span>
                )}
              </div>
            </div>

            {/* Config panel — always present so the canvas doesn't reflow */}
            <div
              style={{
                width: 340,
                flexShrink: 0,
                borderLeft: `1px solid ${colors.border}`,
                background: colors.panel,
              }}
            >
              {selectedNode ? (
                <NodeConfigPanel
                  key={selectedNode.id}
                  node={selectedNode}
                  workflowId={workflowId}
                  campaignBrand={wf?.campaign?.brand ?? null}
                  campaignName={wf?.campaign?.name ?? null}
                  onUpdate={handleNodeUpdate}
                  onDelete={handleDeleteNode}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                  isFirst={selectedIndex === 0}
                  isLast={selectedIndex === displayNodes.length - 1}
                  saving={saving}
                  saveError={saveError}
                  savedAt={savedAt}
                />
              ) : (
                <EmptyState
                  compact
                  icon="⚙"
                  title="No step selected"
                  description="Select a node on the canvas, drag a new one from the palette, or connect nodes to build your flow."
                />
              )}
            </div>
          </>
        ) : activeTab === "enroll" ? (
          <EnrollTab
            workflow={wf}
            onEnrolled={() => {
              void inv.invalidateExecution();
            }}
          />
        ) : activeTab === "launch" ? (
          <LaunchTab
            workflow={wf}
            onLaunched={() => {
              void inv.invalidateExecution();
              setActiveTab("monitor");
            }}
          />
        ) : activeTab === "queue" ? (
          <ManualQueueTab workflow={wf} />
        ) : (
          <MonitorTab workflow={wf} />
        )}
      </div>
    </div>
  );
}

// Live-validity indicator in the publish bar. When valid it's a quiet green
// check; when not, it's a button that opens a navigable list of every issue —
// each node-tied row jumps the canvas straight to the offending node so a user
// can walk the list and fix them one by one.
function IssuesPanel({
  validation,
  displayNodes,
  onFocusNode,
}: {
  validation: { valid: boolean; errors: ValidationIssue[] };
  displayNodes: DraftNode[];
  onFocusNode: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const errors = useMemo(
    () => dedupeIssues(validation.errors.filter((e) => e.severity === "error")),
    [validation.errors],
  );

  // Auto-close the popover once everything is fixed.
  useEffect(() => {
    if (errors.length === 0) setOpen(false);
  }, [errors.length]);

  if (validation.valid) {
    return (
      <Tooltip content="This workflow passes all graph checks and is ready to publish.">
        <span
          style={{
            fontSize: font.size.sm,
            color: colors.success,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontWeight: font.weight.semibold,
          }}
        >
          <span aria-hidden>✓</span> Valid
        </span>
      </Tooltip>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ds-focusable"
        style={{
          fontSize: font.size.sm,
          color: colors.danger,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontWeight: font.weight.semibold,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <span aria-hidden>⚠</span> {errors.length} issue{errors.length !== 1 ? "s" : ""}
        <span aria-hidden style={{ fontSize: 9, color: colors.textDim }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div
          role="list"
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            left: 0,
            width: 340,
            maxHeight: 300,
            overflowY: "auto",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: font.size.xs,
              color: colors.textDim,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              fontWeight: font.weight.semibold,
              padding: "4px 8px 6px",
            }}
          >
            Fix these to publish
          </div>
          {errors.map((issue, i) => {
            const node = issue.nodeId
              ? displayNodes.find((n) => n.id === issue.nodeId)
              : undefined;
            const clickable = !!node;
            return (
              <button
                key={issue.code + i}
                role="listitem"
                onClick={
                  clickable
                    ? () => {
                        onFocusNode(node!.id);
                        setOpen(false);
                      }
                    : undefined
                }
                disabled={!clickable}
                className={clickable ? "ds-focusable ds-row" : undefined}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  borderRadius: radii.sm,
                  padding: "6px 8px",
                  cursor: clickable ? "pointer" : "default",
                }}
              >
                {node ? (
                  (() => {
                    const NIcon = nodeIconComponent(node.type);
                    return (
                      <span
                        style={{
                          fontSize: font.size.xs,
                          color: colors.textMuted,
                          fontWeight: font.weight.semibold,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <NIcon size={12} strokeWidth={2.25} style={{ flexShrink: 0 }} />
                        {nodeLabel(node.type)}
                      </span>
                    );
                  })()
                ) : (
                  <span
                    style={{
                      fontSize: font.size.xs,
                      color: colors.textDim,
                      fontWeight: font.weight.semibold,
                    }}
                  >
                    Workflow
                  </span>
                )}
                <span style={{ fontSize: font.size.sm, color: colors.danger, lineHeight: 1.35 }}>
                  {issue.message}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SaveStatus({
  saving,
  error,
  savedAt,
}: {
  saving: boolean;
  error: string | null;
  savedAt: string | null;
}) {
  if (error) {
    return (
      <Tooltip content={error}>
        <span style={{ fontSize: font.size.sm, color: colors.danger, display: "inline-flex", alignItems: "center", gap: 5 }}>
          ● Save failed
        </span>
      </Tooltip>
    );
  }
  if (saving) {
    return <span style={{ fontSize: font.size.sm, color: colors.textDim }}>Saving…</span>;
  }
  if (savedAt) {
    return (
      <span style={{ fontSize: font.size.sm, color: colors.textDim, display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ color: colors.success }}>✓</span> Saved
      </span>
    );
  }
  return null;
}

const centerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
};
