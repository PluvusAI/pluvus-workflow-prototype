import { useState, useEffect, useId, useRef } from "react";
import { colors, radii, font } from "../../theme";
import {
  Button,
  Input,
  Textarea,
  Select,
  FormField,
  IconButton,
  ConfirmDialog,
  Badge,
} from "../ds";
import { stateColor, stateLabel } from "../../theme";
import { nodeLabel, nodeIconComponent, nodeColor, nodeDescription } from "./nodeMeta";
import type {
  DraftNode,
  InitialOutreachConfig,
  FollowUpConfig,
  NegotiationConfig,
  RewardSetupConfig,
  ContentBriefConfig,
} from "../../api/builderTypes";
import { uploadFile, generateOutreachTemplate } from "../../api/builderClient";
import {
  REQUIRED_OUTREACH_VARIABLE_NAMES,
  type OutreachVariable,
  PREVIEW_SAMPLE,
  renderOutreachPreview,
  extractUnknownTokens,
  unavailableUsedTokens,
  availableOutreachVariables,
  validateOutreachConfig,
} from "../../workflow/outreachVariables";

interface Props {
  node: DraftNode;
  /** Owning workflow — needed by the outreach AI-assist proxy route (PLU-117). */
  workflowId: string;
  /**
   * The parent campaign's brand + name (PLU-117). Threaded so the outreach
   * builder resolves {{brandName}}/{{senderName}}/{{campaignName}} to the REAL
   * campaign values in the preview — the same values the server stamps at
   * save/publish — instead of a blank or an internal fallback.
   */
  campaignBrand?: string | null;
  campaignName?: string | null;
  onUpdate: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  onMoveUp: (nodeId: string) => void;
  onMoveDown: (nodeId: string) => void;
  isFirst: boolean;
  isLast: boolean;
  saving?: boolean;
  saveError?: string | null;
  savedAt?: string | null;
}

export function NodeConfigPanel({
  node,
  workflowId,
  campaignBrand = null,
  campaignName = null,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  saving = false,
  saveError = null,
  savedAt = null,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const color = nodeColor(node.type);
  const Icon = nodeIconComponent(node.type);

  return (
    <div
      className="ds-slide-in-right"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: colors.panel,
      }}
    >
      {/* Panel header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: font.size.xs,
            fontWeight: font.weight.semibold,
            color: colors.textDim,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 10,
          }}
        >
          Step Configuration
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span
            aria-hidden
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: `${color}2e`,
              border: `1.5px solid ${colors.cardBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: colors.text,
              flexShrink: 0,
            }}
          >
            <Icon size={18} strokeWidth={2.25} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: font.size.lg,
                fontWeight: font.weight.semibold,
                color: colors.text,
                letterSpacing: -0.2,
              }}
            >
              {nodeLabel(node.type)}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: colors.textDim, marginTop: 2 }}>
              {node.id}
            </div>
          </div>
        </div>
        {nodeDescription(node.type) && (
          <div style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.55, marginTop: 12 }}>
            {nodeDescription(node.type)}
          </div>
        )}
      </div>

      {/* Config form */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
        <NodeForm
          node={node}
          workflowId={workflowId}
          campaignBrand={campaignBrand}
          campaignName={campaignName}
          onUpdate={onUpdate}
        />
      </div>

      {/* Sticky save status */}
      <div
        style={{
          padding: "7px 18px",
          borderTop: `1px solid ${colors.border}`,
          flexShrink: 0,
          fontSize: font.size.sm,
          minHeight: 30,
          display: "flex",
          alignItems: "center",
          background: colors.panelAlt,
        }}
        aria-live="polite"
      >
        {saveError ? (
          <span style={{ color: colors.danger }}>● Save failed — {saveError}</span>
        ) : saving ? (
          <span style={{ color: colors.textDim }}>Saving changes…</span>
        ) : savedAt ? (
          <span style={{ color: colors.textDim }}>
            <span style={{ color: colors.success }}>✓</span> All changes saved
          </span>
        ) : (
          <span style={{ color: colors.textDim }}>Changes save automatically</span>
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          padding: "12px 18px",
          borderTop: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <IconButton
          label="Move step up"
          icon="↑"
          disabled={isFirst}
          onClick={() => onMoveUp(node.id)}
          style={{ border: `1px solid ${isFirst ? colors.border : colors.borderStrong}` }}
        />
        <IconButton
          label="Move step down"
          icon="↓"
          disabled={isLast}
          onClick={() => onMoveDown(node.id)}
          style={{ border: `1px solid ${isLast ? colors.border : colors.borderStrong}` }}
        />
        <div style={{ flex: 1 }} />
        {/* Every node type is deletable — graph validation guarantees the flow
            still has a valid terminal + phase order before it can be published. */}
        <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
          Delete step
        </Button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete step?"
          message={
            <>
              Delete the <strong>{nodeLabel(node.type)}</strong> step? This removes it from the draft
              workflow. You can re-publish afterwards.
            </>
          }
          confirmLabel="Delete step"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(node.id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-node forms
// ---------------------------------------------------------------------------

function NodeForm({
  node,
  workflowId,
  campaignBrand,
  campaignName,
  onUpdate,
}: {
  node: DraftNode;
  workflowId: string;
  campaignBrand?: string | null;
  campaignName?: string | null;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  switch (node.type) {
    case "INITIAL_OUTREACH":
      return (
        <InitialOutreachForm
          nodeId={node.id}
          workflowId={workflowId}
          campaignBrand={campaignBrand ?? null}
          campaignName={campaignName ?? null}
          config={node.config as InitialOutreachConfig}
          onUpdate={onUpdate}
        />
      );
    case "FOLLOW_UP":
      return (
        <FollowUpForm nodeId={node.id} config={node.config as FollowUpConfig} onUpdate={onUpdate} />
      );
    case "REPLY_DETECTION":
      return (
        <ReplyDetectionInfo />
      );
    case "NEGOTIATION":
      return (
        <NegotiationForm
          nodeId={node.id}
          config={node.config as NegotiationConfig}
          onUpdate={onUpdate}
        />
      );
    case "REWARD_SETUP":
      return <RewardSetupInfo config={node.config as RewardSetupConfig} />;
    case "PAYMENT_INFO":
      return <PaymentInfoInfo config={node.config as Record<string, unknown>} />;
    case "CONTENT_BRIEF":
      return (
        <ContentBriefForm
          nodeId={node.id}
          config={node.config as ContentBriefConfig}
          onUpdate={onUpdate}
        />
      );
    case "END":
      return <EndNodeInfo />;
    default:
      return (
        <div style={{ fontSize: font.size.md, color: colors.textMuted }}>
          No configuration available for this step type.
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Initial Outreach form
// ---------------------------------------------------------------------------

function InitialOutreachForm({
  nodeId,
  workflowId,
  campaignBrand,
  campaignName,
  config,
  onUpdate,
}: {
  nodeId: string;
  workflowId: string;
  campaignBrand?: string | null;
  campaignName?: string | null;
  config: InitialOutreachConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  // PLU-117: the config the builder resolves against for the PREVIEW / palette /
  // availability. The node config may not carry brandName/senderName/campaignName
  // until the next save (the server stamps them via restampBrand +
  // stampOutreachDerivedFields), so we overlay the campaign's real values here —
  // config still WINS when it already has a value — so the operator sees exactly
  // what will be sent instead of a blank or an internal fallback.
  const previewConfig: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) };
  const fillIf = (key: string, val: string | null | undefined): void => {
    const cur = previewConfig[key];
    if ((typeof cur !== "string" || cur.trim() === "") && typeof val === "string" && val.trim() !== "") {
      previewConfig[key] = val;
    }
  };
  fillIf("brandName", campaignBrand);
  fillIf("senderName", campaignBrand);
  fillIf("campaignName", campaignName);
  // Absent mode is treated as "ai" (legacy default, matches the executor). New
  // nodes are stamped "manual" by nodeDefaults, so this branch only affects
  // already-created legacy drafts, which stay on AI until the operator switches.
  const [mode, setMode] = useState<"manual" | "ai">(config.outreachMode ?? "ai");
  const [subject, setSubject] = useState(config.subjectTemplate ?? "");
  const [body, setBody] = useState(config.bodyTemplate ?? "");
  const subjectId = useId();
  const bodyId = useId();

  // Refs + last-focused tracking so the variable palette inserts a {{token}} at
  // the caret of whichever field the operator last touched.
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const focusedRef = useRef<"subject" | "body">("body");

  useEffect(() => {
    setMode(config.outreachMode ?? "ai");
    setSubject(config.subjectTemplate ?? "");
    setBody(config.bodyTemplate ?? "");
  }, [nodeId, config.outreachMode, config.subjectTemplate, config.bodyTemplate]);

  // Spread config, override mode + subject/body. `over` lets us flush a value
  // that hasn't round-tripped through state yet (mode toggle, palette insert).
  function flush(over?: Partial<InitialOutreachConfig>) {
    onUpdate(nodeId, {
      ...config,
      outreachMode: mode,
      subjectTemplate: subject,
      bodyTemplate: body,
      ...over,
    });
  }

  function selectMode(next: "manual" | "ai") {
    setMode(next);
    flush({ outreachMode: next });
  }

  // Insert `{{name}}` at the caret of the last-focused field. Splices into the
  // string, updates state, flushes, and restores the caret after the token.
  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const target = focusedRef.current;
    if (target === "subject") {
      const el = subjectRef.current;
      const at = el?.selectionStart ?? subject.length;
      const next = subject.slice(0, at) + token + subject.slice(el?.selectionEnd ?? at);
      setSubject(next);
      flush({ subjectTemplate: next });
      requestAnimationFrame(() => {
        if (el) {
          el.focus();
          const pos = at + token.length;
          el.setSelectionRange(pos, pos);
        }
      });
    } else {
      const el = bodyRef.current;
      const at = el?.selectionStart ?? body.length;
      const next = body.slice(0, at) + token + body.slice(el?.selectionEnd ?? at);
      setBody(next);
      flush({ bodyTemplate: next });
      requestAnimationFrame(() => {
        if (el) {
          el.focus();
          const pos = at + token.length;
          el.setSelectionRange(pos, pos);
        }
      });
    }
  }

  // Live validation against the effective config so inline errors mirror what
  // the publish check will report.
  const validationIssue = validateOutreachConfig({
    outreachMode: mode,
    subjectTemplate: subject,
    bodyTemplate: body,
  });
  const subjectError = validationIssue?.field === "subject" ? validationIssue.message : undefined;
  const bodyError = validationIssue?.field === "body" ? validationIssue.message : undefined;

  const isManual = mode === "manual";

  // --- PLU-117 §4.3: AI-assist (template authoring, manual mode only) ---------
  // The AI helps author/revise the ONE reusable template at SETUP time. Its
  // output NEVER auto-sends: it proposes copy, the operator explicitly Applies it
  // (confirm-before-overwrite so a revise can't silently clobber edits), and a
  // one-step Undo restores the prior copy. Every send is still the operator's
  // approved template with only placeholders swapped.
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<{
    subject: string;
    body: string;
    alternateSubjects: string[];
    flaggedPlaceholders: string[];
  } | null>(null);
  // Snapshot of the copy BEFORE the last Apply, for one-step Undo.
  const [undoState, setUndoState] = useState<{ subject: string; body: string } | null>(null);

  async function runAi(over?: { instruction?: string; includeCurrent?: boolean }) {
    setAiLoading(true);
    setAiError(null);
    try {
      const instr = over?.instruction ?? (instruction.trim() || undefined);
      // Include the current copy as context when REVISING (an instruction present,
      // or the operator already has copy) so the model improves rather than
      // discards edits. A blank generate from scratch omits it.
      const revising = !!instr || subject.trim().length > 0 || body.trim().length > 0;
      const result = await generateOutreachTemplate(workflowId, {
        ...(instr ? { instruction: instr } : {}),
        ...(revising && subject.trim() ? { currentSubject: subject } : {}),
        ...(revising && body.trim() ? { currentBody: body } : {}),
      });
      setProposal(result);
    } catch (err) {
      setAiError(
        err instanceof Error && /400/.test(err.message)
          ? "That instruction looks like a prompt-injection attempt — rephrase it."
          : "Couldn't generate a template right now. Try again in a moment.",
      );
    } finally {
      setAiLoading(false);
    }
  }

  // Apply the proposed subject+body over the current copy (with an Undo snapshot).
  function applyProposal() {
    if (!proposal) return;
    setUndoState({ subject, body });
    setSubject(proposal.subject);
    setBody(proposal.body);
    flush({ subjectTemplate: proposal.subject, bodyTemplate: proposal.body });
    setProposal(null);
  }

  // Apply just an alternate subject line (no body change, still undoable).
  function applyAlternateSubject(alt: string) {
    setUndoState({ subject, body });
    setSubject(alt);
    flush({ subjectTemplate: alt });
  }

  function undoApply() {
    if (!undoState) return;
    setSubject(undoState.subject);
    setBody(undoState.body);
    flush({ subjectTemplate: undoState.subject, bodyTemplate: undoState.body });
    setUndoState(null);
  }

  // Required placeholders (creatorName / brandName) the template USES — warn the
  // operator that a creator whose value is blank will be skipped (PLU-117 §3).
  const usedRequired = [
    ...new Set(
      [...(subject + " " + body).matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)]
        .map((m) => m[1]!)
        .filter((name) => REQUIRED_OUTREACH_VARIABLE_NAMES.has(name)),
    ),
  ];

  return (
    <FormStack>
      <OutreachModeToggle mode={mode} onSelect={selectMode} />

      {isManual ? (
        <InfoBox>
          You are writing the exact first email each creator receives. It is sent{" "}
          <strong>verbatim</strong> after variables are filled in — the AI does not rewrite it. Use
          the variables below to personalize it; leave money out (rates are negotiated on reply).
        </InfoBox>
      ) : (
        <InfoBox>
          The first email is written by the <strong>AI</strong>, personalized from your campaign
          details. The subject and body below are an <strong>optional fallback</strong>, used only if
          AI generation is unavailable. Switch to <strong>Write it myself</strong> above to send your
          own copy instead.
        </InfoBox>
      )}

      {isManual && (
        <OutreachAiAssist
          loading={aiLoading}
          error={aiError}
          instruction={instruction}
          onInstruction={setInstruction}
          onGenerate={() => runAi()}
          onQuickInstruction={(i) => runAi({ instruction: i })}
          proposal={proposal}
          onApply={applyProposal}
          onDiscard={() => setProposal(null)}
          onApplyAlternate={applyAlternateSubject}
          canUndo={!!undoState}
          onUndo={undoApply}
          hasCopy={subject.trim().length > 0 || body.trim().length > 0}
        />
      )}

      <VariablePalette onInsert={insertVariable} config={previewConfig} />

      <Section title={isManual ? "Your outreach email" : "Fallback message (optional)"}>
        <FormField label="Subject Line" htmlFor={subjectId} error={subjectError}>
          <Input
            id={subjectId}
            ref={subjectRef}
            value={subject}
            invalid={!!subjectError}
            onFocus={() => (focusedRef.current = "subject")}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={() => flush()}
            placeholder="e.g. Partnership opportunity with {{brandName}}"
          />
        </FormField>
        <FormField
          label="Email Body"
          htmlFor={bodyId}
          hint="Plain text. Click a variable above to insert it at your cursor."
          error={bodyError}
        >
          <Textarea
            id={bodyId}
            ref={bodyRef}
            value={body}
            invalid={!!bodyError}
            onFocus={() => (focusedRef.current = "body")}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => flush()}
            rows={12}
            placeholder={
              isManual
                ? "Hi {{creatorName}},\n\nWrite your outreach here…"
                : "Leave blank to use the built-in default…"
            }
          />
        </FormField>
      </Section>

      {isManual && usedRequired.length > 0 && (
        <InfoBox>
          This template uses{" "}
          {usedRequired.map((v, i) => (
            <span key={v}>
              {i > 0 && ", "}
              <Code>{`{{${v}}}`}</Code>
            </span>
          ))}
          , which {usedRequired.length > 1 ? "are" : "is"} <strong>required</strong>. A creator
          whose value is missing is <strong>skipped and sent to Manual Review</strong> rather than
          emailed a broken sentence — the others still send.
        </InfoBox>
      )}

      <OutreachPreview subject={subject} body={body} config={previewConfig} />
    </FormStack>
  );
}

// PLU-117 §4.3: AI-assist panel for authoring/revising the reusable template. AI
// operates at the TEMPLATE level (not per-creator). It proposes copy; the operator
// Applies it (confirm-before-overwrite) — nothing here is ever auto-sent.
const QUICK_INSTRUCTIONS = [
  "Make it shorter",
  "Make it more casual",
  "Remove marketing language",
  "Suggest alternate subject lines",
] as const;

function OutreachAiAssist({
  loading,
  error,
  instruction,
  onInstruction,
  onGenerate,
  onQuickInstruction,
  proposal,
  onApply,
  onDiscard,
  onApplyAlternate,
  canUndo,
  onUndo,
  hasCopy,
}: {
  loading: boolean;
  error: string | null;
  instruction: string;
  onInstruction: (v: string) => void;
  onGenerate: () => void;
  onQuickInstruction: (i: string) => void;
  proposal: {
    subject: string;
    body: string;
    alternateSubjects: string[];
    flaggedPlaceholders: string[];
  } | null;
  onApply: () => void;
  onDiscard: () => void;
  onApplyAlternate: (alt: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  hasCopy: boolean;
}) {
  const instrId = useId();
  return (
    <Section title="AI assist">
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          background: colors.bg,
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.6 }}>
          AI helps you write <strong>one</strong> reusable template from your campaign details — it
          does not write a different email per creator. Generate a starting point or refine what you
          have, then edit and preview below. Nothing is sent until you publish.
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button size="sm" variant="secondary" onClick={onGenerate} disabled={loading}>
            {loading ? "Generating…" : hasCopy ? "Regenerate template" : "Generate template with AI"}
          </Button>
          {canUndo && (
            <Button size="sm" variant="ghost" onClick={onUndo} disabled={loading}>
              Undo
            </Button>
          )}
        </div>

        <FormField
          label="Improve it"
          htmlFor={instrId}
          hint='Tell the AI how to revise your current copy — e.g. "make it shorter".'
        >
          <Input
            id={instrId}
            value={instruction}
            onChange={(e) => onInstruction(e.target.value)}
            placeholder="e.g. make it warmer and more concise"
            disabled={loading}
          />
        </FormField>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {QUICK_INSTRUCTIONS.map((q) => (
            <button
              key={q}
              type="button"
              disabled={loading}
              onClick={() => onQuickInstruction(q)}
              className="ds-focusable"
              style={{
                cursor: loading ? "default" : "pointer",
                fontSize: 11,
                background: colors.panelAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                padding: "4px 9px",
                color: colors.text,
                opacity: loading ? 0.5 : 1,
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ fontSize: font.size.xs, color: colors.danger }}>{error}</div>
        )}

        {proposal && (
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              background: colors.panel,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              style={{
                fontSize: font.size.xs,
                fontWeight: font.weight.semibold,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                color: colors.textDim,
              }}
            >
              Proposed template
            </div>
            <div style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.text }}>
              {proposal.subject}
            </div>
            <div
              style={{
                fontSize: font.size.sm,
                color: colors.textMuted,
                whiteSpace: "pre-wrap",
                lineHeight: 1.6,
              }}
            >
              {proposal.body}
            </div>

            {proposal.flaggedPlaceholders.length > 0 && (
              <div style={{ fontSize: font.size.xs, color: colors.danger }}>
                The AI used unsupported placeholder
                {proposal.flaggedPlaceholders.length > 1 ? "s" : ""}:{" "}
                {proposal.flaggedPlaceholders.map((p) => `{{${p}}}`).join(", ")} — these are removed
                when sent. Replace or remove them.
              </div>
            )}

            {proposal.alternateSubjects.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: font.size.xs, color: colors.textDim }}>
                  Alternate subject lines
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {proposal.alternateSubjects.map((alt) => (
                    <button
                      key={alt}
                      type="button"
                      onClick={() => onApplyAlternate(alt)}
                      className="ds-focusable"
                      style={{
                        cursor: "pointer",
                        fontSize: 11,
                        background: colors.panelAlt,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 4,
                        padding: "4px 9px",
                        color: colors.text,
                        textAlign: "left",
                      }}
                      title="Use this subject line"
                    >
                      {alt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <Button size="sm" variant="primary" onClick={onApply}>
                Apply to fields
              </Button>
              <Button size="sm" variant="ghost" onClick={onDiscard}>
                Discard
              </Button>
            </div>
            <div style={{ fontSize: font.size.xs, color: colors.textDim }}>
              Applying replaces your current subject and body. You can Undo once after.
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

// Segmented control: manual vs AI. Manual is the recommended, product-default
// path (each new node ships manual); AI is the opt-in fallback path.
function OutreachModeToggle({
  mode,
  onSelect,
}: {
  mode: "manual" | "ai";
  onSelect: (m: "manual" | "ai") => void;
}) {
  const options: { key: "manual" | "ai"; label: string; sub: string }[] = [
    { key: "manual", label: "Write it myself", sub: "Recommended — your copy is sent as-is" },
    { key: "ai", label: "Let AI write it", sub: "The AI drafts the first email" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Outreach mode"
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
    >
      {options.map((o) => {
        const active = mode === o.key;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(o.key)}
            className="ds-focusable"
            style={{
              textAlign: "left",
              cursor: "pointer",
              padding: "12px 14px",
              borderRadius: radii.md,
              border: `1px solid ${active ? colors.accent : colors.border}`,
              background: active ? colors.accentWash : colors.panel,
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            <span
              style={{
                fontSize: font.size.sm,
                fontWeight: font.weight.semibold,
                color: active ? colors.accent : colors.text,
              }}
            >
              {o.label}
            </span>
            <span style={{ fontSize: font.size.xs, color: colors.textDim }}>{o.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

// Click-to-insert palette of the allowed template variables, grouped. Each chip
// inserts its {{token}} at the caret of the last-focused field.
function VariablePalette({
  onInsert,
  config,
}: {
  onInsert: (name: string) => void;
  config: Record<string, unknown>;
}) {
  const groups: OutreachVariable["group"][] = ["Creator", "Brand", "Campaign"];
  // PLU-117: only offer variables that will resolve to a real value for this
  // campaign — a placeholder the brand didn't fill in (e.g. {{campaignName}} with
  // no campaign name) would render blank, so it isn't shown at all.
  const available = availableOutreachVariables(config);
  const shownGroups = groups.filter((g) => available.some((v) => v.group === g));
  return (
    <Section title="Insert a variable">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {shownGroups.map((g) => (
          <div key={g} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: font.size.xs, color: colors.textDim }}>{g}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {available.filter((v) => v.group === g).map((v) => (
                <button
                  key={v.name}
                  type="button"
                  title={`${v.label} (${v.fallbackNote})`}
                  onClick={() => onInsert(v.name)}
                  className="mono ds-focusable"
                  style={{
                    cursor: "pointer",
                    fontSize: 11,
                    background: colors.panelAlt,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 4,
                    padding: "3px 7px",
                    color: colors.text,
                  }}
                >
                  {`{{${v.name}}}`}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// Read-only live preview: resolves variables against the campaign's real brand/
// campaign values (on config) + sample creator values, mirroring the server
// send-time render. Unknown {{tokens}} are highlighted so a typo is obvious.
function OutreachPreview({
  subject,
  body,
  config,
}: {
  subject: string;
  body: string;
  // The effective preview config (node config + the campaign's real brand/name).
  config: Record<string, unknown>;
}) {
  const cfg = config;
  const previewSubject = renderOutreachPreview(subject, cfg);
  const previewBody = renderOutreachPreview(body, cfg);
  const unknown = [
    ...new Set([...extractUnknownTokens(subject), ...extractUnknownTokens(body)]),
  ];
  // PLU-117: known placeholders the brand didn't fill in — they render as a blank
  // gap. Flag them so the operator removes/fills them instead of shipping a
  // sentence with a hole ("upcoming  campaign").
  const unavailable = unavailableUsedTokens(subject, body, cfg);

  return (
    <Section title="Preview">
      <div
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          background: colors.bg,
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontSize: font.size.xs, color: colors.textDim }}>
          Sample creator: {PREVIEW_SAMPLE.creatorName} ({PREVIEW_SAMPLE.platform},{" "}
          {PREVIEW_SAMPLE.niche})
        </div>
        <div style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.text }}>
          {previewSubject || <span style={{ color: colors.textDim }}>No subject</span>}
        </div>
        <div
          style={{
            fontSize: font.size.sm,
            color: colors.textMuted,
            whiteSpace: "pre-wrap",
            lineHeight: 1.6,
          }}
        >
          {previewBody || <span style={{ color: colors.textDim }}>No body</span>}
        </div>
        {unavailable.length > 0 && (
          <div style={{ fontSize: font.size.xs, color: colors.danger }}>
            No value for {unavailable.map((u) => `{{${u}}}`).join(", ")} in this campaign — {}
            {unavailable.length > 1 ? "they render" : "it renders"} blank. Remove{" "}
            {unavailable.length > 1 ? "them" : "it"} or add the value to the campaign.
          </div>
        )}
        {unknown.length > 0 && (
          <div style={{ fontSize: font.size.xs, color: colors.danger }}>
            Unknown variable{unknown.length > 1 ? "s" : ""}:{" "}
            {unknown.map((u) => `{{${u}}}`).join(", ")} — these are removed when sent. Fix or remove
            them before publishing.
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Follow-Up form
// ---------------------------------------------------------------------------

function FollowUpForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: FollowUpConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [intervals, setIntervals] = useState<number[]>(config.intervals ?? [3]);
  const [unit, setUnit] = useState(config.intervalUnit ?? "days");
  const [maxCount, setMaxCount] = useState(config.maxCount ?? 2);
  const [body, setBody] = useState(config.bodyTemplate ?? "");
  const maxId = useId();
  const unitId = useId();
  const bodyId = useId();

  useEffect(() => {
    setIntervals(config.intervals ?? [3]);
    setUnit(config.intervalUnit ?? "days");
    setMaxCount(config.maxCount ?? 2);
    setBody(config.bodyTemplate ?? "");
  }, [nodeId]);

  // `over` lets us flush with values that haven't yet round-tripped through
  // state (replaces the prior setTimeout(flush, 0) hack). stopOnReply is no
  // longer written: the "cancel follow-ups on reply" behavior is hardcoded in
  // the runtime (an inbound reply always clears the follow-up dueAt), so the old
  // toggle promised an off-switch that never existed. flush rebuilds the config
  // from these fields only, so any legacy stopOnReply is naturally dropped.
  function flush(over?: Partial<FollowUpConfig>) {
    onUpdate(nodeId, {
      intervals,
      intervalUnit: unit,
      maxCount,
      bodyTemplate: body,
      ...over,
    });
  }

  return (
    <FormStack>
      <InfoBox>
        Sends follow-up emails at configured intervals, and <strong>always stops as soon as the
        creator replies</strong>. Each follow-up is written by the AI, personalized from your
        campaign details — the body below is an <strong>optional fallback</strong>, used only if AI
        generation is unavailable. Leave it blank to use the built-in default.
      </InfoBox>

      <Section title="Cadence">
        <FormField label="Max Follow-Ups" htmlFor={maxId}>
          <Input
            id={maxId}
            type="number"
            min={1}
            max={5}
            value={maxCount}
            onChange={(e) => setMaxCount(Number(e.target.value))}
            onBlur={() => flush()}
            style={{ width: 90 }}
          />
        </FormField>

        <FormField label="Intervals" hint="How long to wait before each follow-up.">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {intervals.map((v, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Input
                  type="number"
                  min={1}
                  value={v}
                  aria-label={`Interval ${i + 1}`}
                  onChange={(e) => {
                    const next = [...intervals];
                    next[i] = Number(e.target.value);
                    setIntervals(next);
                  }}
                  onBlur={() => flush()}
                  style={{ width: 64 }}
                />
                {intervals.length > 1 && (
                  <IconButton
                    label={`Remove interval ${i + 1}`}
                    icon="×"
                    size={22}
                    style={{ color: colors.danger }}
                    onClick={() => {
                      const next = intervals.filter((_, j) => j !== i);
                      setIntervals(next);
                      flush({ intervals: next });
                    }}
                  />
                )}
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = [...intervals, 3];
                setIntervals(next);
                flush({ intervals: next });
              }}
            >
              + Add
            </Button>
          </div>
        </FormField>

        <FormField label="Interval Unit" htmlFor={unitId}>
          <Select
            id={unitId}
            value={unit}
            onChange={(e) => {
              const next = e.target.value as "seconds" | "minutes" | "hours" | "days";
              setUnit(next);
              flush({ intervalUnit: next });
            }}
          >
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </Select>
        </FormField>

      </Section>

      <Section title="Fallback message (optional)">
        <FormField label="Follow-Up Body" htmlFor={bodyId} hint="Fallback only — used for every follow-up if AI generation is unavailable.">
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => flush()}
            rows={8}
            placeholder="Leave blank to use the built-in default…"
          />
        </FormField>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Reply Detection form
// ---------------------------------------------------------------------------

// Reply Detection has NO configurable fields. The classifier's low-confidence
// threshold is a fixed engine constant (LOW_CONFIDENCE_THRESHOLD = 0.50 in
// server replyDetection.ts) and low-confidence replies ALWAYS route to Manual
// Review — neither was ever read from node config. The old slider + toggle were
// dead controls, so this is now a read-only summary of the actual behavior.
function ReplyDetectionInfo() {
  return (
    <FormStack>
      <InfoBox>
        AI classifies each reply as Positive, Negative, Question, Opt-Out, or Unknown, then routes it
        to the matching next step. This step has no settings — the thresholds below are fixed.
      </InfoBox>

      <Section title="Confidence Threshold">
        <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: colors.text }}>
          50%
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>
          Fixed. A reply the AI classifies with less than 50% confidence is treated as Unknown.
        </div>
      </Section>

      <Section title="Low-Confidence Behavior">
        <Badge color={stateColor["MANUAL_REVIEW"]} dot>
          {stateLabel["MANUAL_REVIEW"]}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          Always on. Any reply below the threshold (or that fails to classify) is sent to{" "}
          <strong>Manual Review</strong> for a human to handle, rather than auto-advanced.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Negotiation form
// ---------------------------------------------------------------------------

function NegotiationForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: NegotiationConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [minBudget, setMinBudget] = useState(config.minBudget ?? 0);
  const [maxBudget, setMaxBudget] = useState(config.maxBudget ?? 1000);
  const [maxRounds, setMaxRounds] = useState(config.maxRounds ?? 3);
  const [commissionRate, setCommissionRate] = useState(config.commissionRate ?? 0);
  const minId = useId();
  const maxId = useId();
  const roundsId = useId();
  const commissionId = useId();

  useEffect(() => {
    setMinBudget(config.minBudget ?? 0);
    setMaxBudget(config.maxBudget ?? 1000);
    setMaxRounds(config.maxRounds ?? 3);
    setCommissionRate(config.commissionRate ?? 0);
  }, [nodeId]);

  // commissionRate is only included when > 0 (0 is the omitted default = no
  // commission). Over-budget tolerance has no UI control (hidden by product
  // decision — the engine still honors it, fee-only; see server/agent
  // overCeilingTolerance wiring, Phase C / #12). We PRESERVE any existing saved
  // value by reading it straight from `config` here, so editing other fields
  // doesn't silently drop it; new campaigns just never set it (defaults to 0 =
  // escalate on any over-max ask).
  function flush(over?: Partial<NegotiationConfig>) {
    const next = {
      minBudget,
      maxBudget,
      maxRounds,
      commissionRate,
      ...over,
    };
    const { commissionRate: rate, ...rest } = next;
    const savedTolerance = config.overCeilingTolerance;
    // approvalMode is no longer written: it had no consumer (the engine always
    // auto-accepts within budget), so the "manual" option promised a human gate
    // that never existed. flush rebuilds the config from these fields only, so
    // any legacy approvalMode is naturally dropped on the next save.
    onUpdate(nodeId, {
      ...rest,
      ...(rate > 0 ? { commissionRate: rate } : {}),
      ...(typeof savedTolerance === "number" && savedTolerance > 0
        ? { overCeilingTolerance: savedTolerance }
        : {}),
    });
  }

  const budgetInvalid = maxBudget < minBudget;

  return (
    <FormStack>
      <InfoBox>
        The AI agent opens at the preferred budget and concedes up only as needed — never above the
        maximum. Escalates to Manual Review after the max rounds limit is reached.
      </InfoBox>

      <Section title="Budget">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField
            label="Preferred Budget ($)"
            htmlFor={minId}
            hint="The rate you'd ideally close at — the agent opens here."
          >
            <Input
              id={minId}
              type="number"
              min={0}
              value={minBudget}
              onChange={(e) => setMinBudget(Number(e.target.value))}
              onBlur={() => flush()}
            />
          </FormField>
          <FormField
            label="Maximum Budget ($)"
            htmlFor={maxId}
            hint="Absolute ceiling — the agent never offers above this."
            error={budgetInvalid ? "Must be ≥ preferred budget" : undefined}
          >
            <Input
              id={maxId}
              type="number"
              min={0}
              value={maxBudget}
              invalid={budgetInvalid}
              onChange={(e) => setMaxBudget(Number(e.target.value))}
              onBlur={() => flush()}
            />
          </FormField>
        </div>
        <FormField
          label="Commission Rate (%)"
          htmlFor={commissionId}
          hint="Set to 0 for fixed-fee deals."
        >
          <Input
            id={commissionId}
            type="number"
            min={0}
            max={100}
            value={commissionRate}
            onChange={(e) => setCommissionRate(Number(e.target.value))}
            onBlur={() => flush()}
            style={{ width: 90 }}
          />
        </FormField>
      </Section>

      <Section title="Approval">
        <FormField label="Max Negotiation Rounds" htmlFor={roundsId}>
          <Input
            id={roundsId}
            type="number"
            min={1}
            max={10}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
            onBlur={() => flush()}
            style={{ width: 90 }}
          />
        </FormField>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Reward Setup node (read-only summary)
// ---------------------------------------------------------------------------
// Finalizes the commercial agreement after a successful negotiation. The final
// fixed fee is resolved at runtime (the rate the negotiation closed on), so it
// is shown as "resolved from the closed deal" here; commission and deliverables
// come from the campaign / negotiation config. Mirrors the runtime node display:
// Final Fixed Fee · Commission · Deliverables · Status.

function RewardSetupInfo({ config }: { config: RewardSetupConfig }) {
  const commission =
    typeof config.commissionRate === "number" && config.commissionRate > 0
      ? config.commissionRate
      : null;
  const deliverablesRaw =
    typeof config.deliverables === "string" ? config.deliverables.trim() : "";
  const deliverableItems = deliverablesRaw
    ? deliverablesRaw
        .split(/\r?\n|,/)
        .map((d) => d.trim())
        .filter(Boolean)
    : [];

  return (
    <FormStack>
      <InfoBox>
        Runs after a successful negotiation. Records the agreed fee, commission,
        and deliverables, then emails the creator a{" "}
        <strong>Campaign Agreement Confirmation</strong> and waits for them to
        reply <Code>I Agree</Code> before advancing.
      </InfoBox>

      <Section title="Final Fixed Fee">
        <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: colors.text }}>
          Agreed rate
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>
          Resolved at runtime from the rate the negotiation closed on.
        </div>
      </Section>

      <Section title="Commission">
        <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: colors.text }}>
          {commission !== null ? `${commission}%` : "None"}
        </div>
      </Section>

      <Section title="Deliverables">
        {deliverableItems.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, color: colors.text, lineHeight: 1.7 }}>
            {deliverableItems.map((d, i) => (
              <li key={i} style={{ fontSize: font.size.md }}>
                {d}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>
            Set on the campaign; shown to the creator in the confirmation email.
          </div>
        )}
      </Section>

      <Section title="Status">
        <Badge color={stateColor["REWARD_PENDING"]} dot>
          {stateLabel["REWARD_PENDING"]}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          Each creator waits here until they confirm. On confirmation the instance
          moves to <strong>{stateLabel["REWARD_CONFIRMED"]}</strong>.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Payment Info node (read-only summary)
// ---------------------------------------------------------------------------
// Collects the creator's payout information after they confirm the agreement.
// The node emails a link to a hosted payout form and waits for the submission
// before resuming the workflow. No builder configuration today — the form link
// and email are derived at runtime — so this mirrors the runtime node display:
// Payment Method · Submission Status · Collected Fields.

function PaymentInfoInfo({ config }: { config: Record<string, unknown> }) {
  // The campaign's "ships a physical product" flag is stamped into every node's
  // config; when on, the hosted form also collects a shipping address.
  const shipsProduct = config["shipsPhysicalProduct"] === true;
  // The fields the hosted payout form collects, with the two required ones
  // marked. "Verified" is a placeholder only (no verification is performed).
  const fields: Array<{ label: string; required: boolean }> = [
    { label: "Preferred Method", required: true },
    { label: "Account Identifier", required: true },
    { label: "Country", required: false },
    { label: "Notes", required: false },
    ...(shipsProduct ? [{ label: "Shipping Address", required: true }] : []),
  ];

  return (
    <FormStack>
      <InfoBox>
        Runs after the creator confirms the agreement. Emails a secure link to a{" "}
        <strong>hosted payout form</strong> and waits for the creator to submit
        their payout details. On submission the workflow resumes automatically —
        this node does not send payments or verify anything.
        {shipsProduct && (
          <>
            {" "}
            This campaign ships a physical product, so the form also collects a{" "}
            <strong>shipping address</strong>.
          </>
        )}
      </InfoBox>

      <Section title="Payout Methods">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {["PayPal", "Wise", "Bank Transfer"].map((m) => (
            <span
              key={m}
              style={{
                fontSize: font.size.sm,
                color: colors.text,
                background: colors.panelAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.pill,
                padding: "3px 10px",
              }}
            >
              {m}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Collected Fields">
        <ul style={{ margin: 0, paddingLeft: 4, listStyle: "none", lineHeight: 1.9 }}>
          {fields.map((f) => (
            <li key={f.label} style={{ fontSize: font.size.md, color: colors.text }}>
              <span style={{ color: colors.success, marginRight: 8 }}>✓</span>
              {f.label}
              {!f.required && (
                <span style={{ color: colors.textDim, marginLeft: 6 }}>(optional)</span>
              )}
            </li>
          ))}
        </ul>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>
          Payout verification is not performed (placeholder for a future step).
        </div>
      </Section>

      <Section title="Submission Status">
        <Badge color={stateColor["PAYMENT_PENDING"]} dot>
          {stateLabel["PAYMENT_PENDING"]}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          Each creator waits here until they submit the form. On submission the
          instance moves to <strong>{stateLabel["PAYMENT_RECEIVED"]}</strong> and
          the workflow continues to the next connected step.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Content Brief form (configurable) — merged post-negotiation node
// ---------------------------------------------------------------------------
// Sends the merged email (finalized offer + secure payout link + campaign brief
// PDF) right after a successful negotiation, then waits for the payout form. The
// brand uploads the Campaign Brief PDF (required to launch) and optionally sets a
// referral link + creator notes here, before launch. The offer fields (fee /
// commission / deliverables) are stamped from the campaign / negotiation config,
// not entered here. The PDF is uploaded to the server's local storage on select;
// only its stored reference + original filename are persisted in node config —
// never the bytes.

function ContentBriefForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: ContentBriefConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [briefFileRef, setBriefFileRef] = useState(config.briefFileRef ?? "");
  const [briefFileName, setBriefFileName] = useState(config.briefFileName ?? "");
  const [creatorNotes, setCreatorNotes] = useState(config.creatorNotes ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const notesId = useId();

  useEffect(() => {
    setBriefFileRef(config.briefFileRef ?? "");
    setBriefFileName(config.briefFileName ?? "");
    setCreatorNotes(config.creatorNotes ?? "");
    setUploadError(null);
  }, [nodeId]);

  // `over` lets us flush with values that haven't yet round-tripped through state
  // (same idiom as the Follow-Up / Negotiation forms). The manual referralLink
  // field was removed: attribution mints a UNIQUE per-creator tracking link
  // (partnership.ts), delivered in the welcome email — a static brand-typed link
  // here was redundant and tracked nothing. Any legacy saved value is dropped.
  function flush(over?: Partial<ContentBriefConfig>) {
    // Drop any legacy referralLink so re-saving a pre-existing node clears it.
    // The field is gone from ContentBriefConfig, but a config saved before the
    // removal may still carry the key at runtime — strip it via a widened view.
    const { referralLink: _drop, ...rest } = config as Record<string, unknown>;
    onUpdate(nodeId, {
      ...rest,
      briefFileRef,
      briefFileName,
      creatorNotes,
      ...over,
    });
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again re-triggers onChange.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      setUploadError("Please choose a PDF file.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const res = await uploadFile(file);
      setBriefFileRef(res.reference);
      setBriefFileName(res.originalName);
      // Persist immediately (no blur to wait for on a file control).
      flush({ briefFileRef: res.reference, briefFileName: res.originalName });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function removeBrief() {
    setBriefFileRef("");
    setBriefFileName("");
    flush({ briefFileRef: "", briefFileName: "" });
  }

  const hasBrief = !!briefFileRef;

  return (
    <FormStack>
      <InfoBox>
        Runs right after a successful negotiation. Sends the creator{" "}
        <strong>one email</strong> with the finalized offer (fee, commission &
        deliverables), a <strong>secure payout link</strong>, and the{" "}
        <strong>campaign brief PDF</strong> (plus any notes), then waits for them to
        submit their payout details.
      </InfoBox>

      <Section title="Campaign Brief PDF">
        <FormField
          label="Brief document"
          hint="Required to launch. PDF only — attached to the creator's email."
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => void handleFile(e)}
            style={{ display: "none" }}
            aria-label="Upload campaign brief PDF"
          />
          {hasBrief ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
              }}
            >
              <span aria-hidden>📄</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: font.size.md,
                  color: colors.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={briefFileName || "campaign brief"}
              >
                {briefFileName || "campaign-brief.pdf"}
              </span>
              <Badge color={colors.success} dot>
                Uploaded
              </Badge>
            </div>
          ) : (
            <div
              style={{
                fontSize: font.size.sm,
                color: colors.textMuted,
                marginBottom: 6,
              }}
            >
              No file uploaded yet.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : hasBrief ? "Replace PDF" : "Upload PDF"}
            </Button>
            {hasBrief && (
              <Button variant="danger" size="sm" onClick={removeBrief} disabled={uploading}>
                Remove
              </Button>
            )}
          </div>
          {uploadError && (
            <div style={{ fontSize: font.size.sm, color: colors.danger, marginTop: 6 }}>
              {uploadError}
            </div>
          )}
        </FormField>
      </Section>

      <Section title="Creator Notes">
        <FormField
          label="Notes"
          htmlFor={notesId}
          hint="Optional. Appended to the email body for the creator."
        >
          <Textarea
            id={notesId}
            value={creatorNotes}
            onChange={(e) => setCreatorNotes(e.target.value)}
            onBlur={() => flush()}
            rows={5}
            placeholder="e.g. Please tag us in your first post and use the hashtag #campaign."
          />
        </FormField>
      </Section>

      <Section title="Status">
        <Badge color={hasBrief ? stateColor["CONTENT_BRIEF_SENT"] : colors.warning} dot>
          {hasBrief ? "Ready to send on acceptance" : "Brief PDF required"}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          The merged email sends automatically once the negotiation is accepted,
          moving the creator to <strong>{stateLabel["PAYMENT_PENDING"]}</strong>.
          Submitting the payout form then completes the run at{" "}
          <strong>{stateLabel["CONTENT_BRIEF_SENT"]}</strong>.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// End node (read-only)
// ---------------------------------------------------------------------------

function EndNodeInfo() {
  return (
    <FormStack>
      <InfoBox>
        Terminal node. Marks a creator as completed and closes the execution instance. No
        configuration needed.
      </InfoBox>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Shared UI atoms (Phase C)
// ---------------------------------------------------------------------------

function FormStack({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          fontSize: font.size.xs,
          fontWeight: font.weight.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          color: colors.textDim,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        fontSize: font.size.sm,
        color: colors.textMuted,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="mono"
      style={{
        fontSize: 10.5,
        background: colors.panelAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: 4,
        padding: "1px 4px",
        color: colors.text,
      }}
    >
      {children}
    </code>
  );
}
