// ---------------------------------------------------------------------------
// MemoryPanel — PLU-113 campaign-scoped creator memory in the inspector.
// ---------------------------------------------------------------------------
// Shows durable creator facts (live + history) with their FULL immutable revision
// trail (Calvin review #4), each revision linked to its source message + evidence
// excerpt (review #8), and operator correct / remove / add-by-hand actions (review
// #5). A CONFLICTED fact surfaces both values ("was X, now Y"). Pending failed
// memory writes (review #6) are shown at the top with a dismiss action.

import { useState } from "react";
import type {
  CreatorMemoryFactDTO,
  CreatorMemoryRevisionDTO,
  FailedMemoryWriteDTO,
} from "../api/types";
import {
  useCorrectMemory,
  useRemoveMemory,
  useCreateMemory,
  useDismissFailedMemory,
} from "../api/client";
import { colors, font } from "../theme";
import { Empty } from "./ui";
import { Button, Select, Input } from "./ds";

// The durable-fact taxonomy an operator may add by hand (matches MemoryFactKey).
const MEMORY_KEYS = [
  "REQUESTED_RATE",
  "MINIMUM_RATE",
  "AVAILABILITY",
  "LOGISTICS_CONSTRAINT",
  "OBJECTION",
  "DELIVERABLE_PREFERENCE",
  "COMPENSATION_PREFERENCE",
  "MANAGER_INVOLVED",
  "MANAGER_CONTACT",
] as const;

function statusColor(status: string): string {
  switch (status) {
    case "ACTIVE":
      return colors.success;
    case "CONFLICTED":
      return colors.warning;
    default:
      return colors.textMuted; // SUPERSEDED / REMOVED
  }
}

function keyLabel(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function MemoryPanel({
  instanceId,
  memory,
  failedMemoryWrites,
}: {
  instanceId: string;
  memory: CreatorMemoryFactDTO[];
  failedMemoryWrites: FailedMemoryWriteDTO[];
}) {
  const live = memory.filter((f) => f.live);
  const history = memory.filter((f) => !f.live);

  return (
    <div>
      <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
        Durable facts remembered about this creator for THIS campaign (PLU-113).
        Requested/minimum rate are CONTEXT — what the creator asked, never the offer.
        Every value change is kept as an immutable revision, traceable to its source
        message. You can correct, remove, or add facts by hand.
      </p>

      {failedMemoryWrites.length > 0 && (
        <>
          <SubHeading>Failed writes ({failedMemoryWrites.length})</SubHeading>
          {failedMemoryWrites.map((w) => (
            <FailedWriteRow key={w.id} instanceId={instanceId} write={w} />
          ))}
          <div style={{ height: 14 }} />
        </>
      )}

      <SubHeading>Live facts ({live.length})</SubHeading>
      {live.length === 0 ? (
        <Empty>No durable facts recorded yet.</Empty>
      ) : (
        live.map((f) => <MemoryRow key={f.id} instanceId={instanceId} fact={f} editable />)
      )}

      {history.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <SubHeading>History ({history.length})</SubHeading>
          {history.map((f) => (
            <MemoryRow key={f.id} instanceId={instanceId} fact={f} editable={false} />
          ))}
        </>
      )}

      <div style={{ height: 16 }} />
      <SubHeading>Add a fact</SubHeading>
      <AddFactForm instanceId={instanceId} />
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

function MemoryRow({
  instanceId,
  fact,
  editable,
}: {
  instanceId: string;
  fact: CreatorMemoryFactDTO;
  editable: boolean;
}) {
  const f = fact;
  const correct = useCorrectMemory(instanceId);
  const remove = useRemoveMemory(instanceId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(f.value);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
        background: colors.panelAlt,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10.5, color: colors.textMuted }}>{keyLabel(f.key)}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: font.weight.semibold,
            color: statusColor(f.status),
            border: `1px solid ${statusColor(f.status)}`,
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {f.status}
        </span>
        {f.category && <span style={{ fontSize: 10, color: colors.textDim }}>· {f.category}</span>}
      </div>

      <div style={{ fontSize: 12.5, color: colors.text, lineHeight: 1.4 }}>{f.value}</div>

      {f.status === "CONFLICTED" && f.conflictValue && (
        <div style={{ fontSize: 11, color: colors.warning, marginTop: 4 }}>
          Conflict: was “{f.conflictValue}”, now “{f.value}” — unresolved.
        </div>
      )}

      {/* Source traceability (review #8): the current revision's provenance. */}
      <RevisionProvenance revision={f.revisions[0]} />

      <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        {f.revisions.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHistory((s) => !s)}
            style={linkButtonStyle}
          >
            {showHistory ? "Hide" : "Show"} history ({f.revisions.length})
          </button>
        )}
        {editable && !editing && (
          <>
            <button type="button" onClick={() => setEditing(true)} style={linkButtonStyle}>
              Correct
            </button>
            <button
              type="button"
              onClick={() => remove.mutate({ memoryId: f.id })}
              style={{ ...linkButtonStyle, color: colors.danger }}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </button>
          </>
        )}
      </div>

      {editing && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Corrected value"
            style={{ maxWidth: 240 }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={correct.isPending || !draft.trim()}
            onClick={() =>
              correct.mutate(
                { memoryId: f.id, value: draft.trim() },
                { onSuccess: () => setEditing(false) },
              )
            }
          >
            {correct.isPending ? "Saving…" : "Save"}
          </Button>
          <button type="button" onClick={() => setEditing(false)} style={linkButtonStyle}>
            Cancel
          </button>
          {correct.isError && (
            <span style={{ fontSize: 10.5, color: colors.danger }}>
              {(correct.error as Error)?.message ?? "Failed"}
            </span>
          )}
        </div>
      )}

      {showHistory && (
        <div style={{ marginTop: 8, borderTop: `1px dashed ${colors.border}`, paddingTop: 8 }}>
          {f.revisions.map((r) => (
            <RevisionItem key={r.id} revision={r} />
          ))}
        </div>
      )}
    </div>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontSize: 11,
  color: colors.accent,
};

/** The one-line provenance under the live value: source + date + evidence excerpt. */
function RevisionProvenance({ revision }: { revision: CreatorMemoryRevisionDTO | undefined }) {
  if (!revision) return null;
  const when = new Date(revision.createdAt).toLocaleString();
  return (
    <div style={{ fontSize: 10.5, color: colors.textDim, marginTop: 4 }}>
      {revision.source === "operator" ? "Edited by operator" : "From creator message"} · {when}
      {revision.evidenceText && (
        <>
          {" "}
          · evidence: <span style={{ fontStyle: "italic" }}>“{revision.evidenceText}”</span>
        </>
      )}
    </div>
  );
}

function RevisionItem({ revision }: { revision: CreatorMemoryRevisionDTO }) {
  const when = new Date(revision.createdAt).toLocaleString();
  return (
    <div style={{ fontSize: 11, color: colors.textDim, marginBottom: 6, lineHeight: 1.4 }}>
      <span style={{ color: colors.text }}>{revision.value || "(removed)"}</span>
      {"  "}
      <span style={{ color: colors.textMuted }}>
        — {revision.source} · {when}
        {revision.sourceMessageId ? ` · msg ${revision.sourceMessageId.slice(0, 8)}` : ""}
      </span>
      {revision.evidenceText && (
        <div style={{ fontStyle: "italic", marginTop: 2 }}>“{revision.evidenceText}”</div>
      )}
      {revision.note && <div style={{ marginTop: 2 }}>Note: {revision.note}</div>}
    </div>
  );
}

function FailedWriteRow({
  instanceId,
  write,
}: {
  instanceId: string;
  write: FailedMemoryWriteDTO;
}) {
  const dismiss = useDismissFailedMemory(instanceId);
  const when = new Date(write.createdAt).toLocaleString();
  return (
    <div
      style={{
        border: `1px solid ${colors.danger}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
        background: colors.panelAlt,
      }}
    >
      <div style={{ fontSize: 11.5, color: colors.danger }}>
        A memory write failed and is recoverable.
      </div>
      <div style={{ fontSize: 11, color: colors.textDim, marginTop: 4 }}>{write.error}</div>
      <div style={{ fontSize: 10.5, color: colors.textMuted, marginTop: 4 }}>{when}</div>
      <div style={{ marginTop: 8 }}>
        <Button
          size="sm"
          variant="secondary"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({ writeId: write.id })}
        >
          {dismiss.isPending ? "Dismissing…" : "Dismiss"}
        </Button>
      </div>
    </div>
  );
}

function AddFactForm({ instanceId }: { instanceId: string }) {
  const create = useCreateMemory(instanceId);
  const [key, setKey] = useState<string>(MEMORY_KEYS[0]);
  const [value, setValue] = useState("");

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <Select value={key} onChange={(e) => setKey(e.target.value)} aria-label="Fact type" style={{ maxWidth: 200 }}>
        {MEMORY_KEYS.map((k) => (
          <option key={k} value={k}>
            {keyLabel(k)}
          </option>
        ))}
      </Select>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Value"
        aria-label="Fact value"
        style={{ maxWidth: 240 }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={create.isPending || !value.trim()}
        onClick={() =>
          create.mutate({ key, value: value.trim() }, { onSuccess: () => setValue("") })
        }
      >
        {create.isPending ? "Adding…" : "Add"}
      </Button>
      {create.isError && (
        <span style={{ fontSize: 10.5, color: colors.danger }}>
          {(create.error as Error)?.message ?? "Failed"}
        </span>
      )}
    </div>
  );
}
