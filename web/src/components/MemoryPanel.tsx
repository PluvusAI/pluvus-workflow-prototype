// ---------------------------------------------------------------------------
// MemoryPanel — PLU-113 campaign-scoped creator memory in the inspector.
// ---------------------------------------------------------------------------
// Shows the durable creator facts learned THIS campaign — live ones (ACTIVE +
// CONFLICTED, still fed to the model) and, below, the superseded/removed history
// — with per-fact operator actions (EDIT / RESOLVE_CONFLICT / REMOVE) and a small
// "add a fact" form (O7). Mirrors ObligationsPanel.

import { useState } from "react";
import type {
  CampaignCreatorMemoryDTO,
  CorrectMemoryAction,
  MemoryFactKey,
} from "../api/types";
import { useCorrectMemory, useCreateMemory } from "../api/client";
import { colors, font } from "../theme";
import { Empty } from "./ui";
import { Button, Select } from "./ds";

const FACT_KEYS: MemoryFactKey[] = [
  "REQUESTED_RATE",
  "MINIMUM_RATE",
  "AVAILABILITY",
  "LOGISTICS_CONSTRAINT",
  "OBJECTION",
  "DELIVERABLE_PREFERENCE",
  "COMPENSATION_PREFERENCE",
  "MANAGER_INVOLVED",
  "MANAGER_CONTACT",
];

function keyLabel(key: MemoryFactKey): string {
  return key
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function statusColor(status: CampaignCreatorMemoryDTO["status"]): string {
  switch (status) {
    case "ACTIVE":
      return colors.success;
    case "CONFLICTED":
      return colors.warning;
    default:
      return colors.textMuted;
  }
}

export function MemoryPanel({
  instanceId,
  memory,
}: {
  instanceId: string;
  memory: CampaignCreatorMemoryDTO[];
}) {
  const live = memory.filter((m) => m.live);
  const history = memory.filter((m) => !m.live);

  return (
    <div>
      <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
        Durable creator facts learned this campaign (PLU-113) — availability,
        objections, preferences, manager, and their stated rate/floor (context, not
        the offer figure). Live facts are fed into every AI email. Conflicts (the
        creator answered two ways) are surfaced, not overwritten — resolve one below.
      </p>

      <AddFactForm instanceId={instanceId} />

      <SubHeading>Live ({live.length})</SubHeading>
      {live.length === 0 ? (
        <Empty>No durable facts learned yet.</Empty>
      ) : (
        live.map((m) => (
          <MemoryRow key={m.id} instanceId={instanceId} fact={m} editable />
        ))
      )}

      {history.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <SubHeading>Superseded / removed ({history.length})</SubHeading>
          {history.map((m) => (
            <MemoryRow key={m.id} instanceId={instanceId} fact={m} editable={false} />
          ))}
        </>
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
        margin: "10px 0 8px",
      }}
    >
      {children}
    </div>
  );
}

function AddFactForm({ instanceId }: { instanceId: string }) {
  const create = useCreateMemory(instanceId);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<MemoryFactKey>("OBJECTION");
  const [value, setValue] = useState("");

  if (!open) {
    return (
      <div style={{ marginBottom: 12 }}>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          + Add a fact
        </Button>
      </div>
    );
  }

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 12,
        background: colors.panelAlt,
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <Select
        value={key}
        onChange={(e) => setKey(e.target.value as MemoryFactKey)}
        aria-label="Fact type"
        style={{ maxWidth: 200 }}
      >
        {FACT_KEYS.map((k) => (
          <option key={k} value={k}>
            {keyLabel(k)}
          </option>
        ))}
      </Select>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Value (e.g. no exclusivity)"
        aria-label="Fact value"
        style={{
          flex: 1,
          minWidth: 160,
          fontSize: 12,
          padding: "5px 8px",
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          background: colors.panel,
          color: colors.text,
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={create.isPending || !value.trim()}
        onClick={() =>
          create.mutate(
            { key, value: value.trim() },
            {
              onSuccess: () => {
                setValue("");
                setOpen(false);
              },
            },
          )
        }
      >
        {create.isPending ? "Saving…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {create.isError && (
        <span style={{ fontSize: 10.5, color: colors.danger }}>
          {(create.error as Error)?.message ?? "Failed"}
        </span>
      )}
    </div>
  );
}

function MemoryRow({
  instanceId,
  fact,
  editable,
}: {
  instanceId: string;
  fact: CampaignCreatorMemoryDTO;
  editable: boolean;
}) {
  const m = fact;
  const correct = useCorrectMemory(instanceId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.value);

  const apply = (action: CorrectMemoryAction, value?: string) =>
    correct.mutate(
      { factId: m.id, action, ...(value !== undefined ? { value } : {}) },
      { onSuccess: () => setEditing(false) },
    );

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
        <span style={{ fontSize: 10.5, color: colors.textMuted }}>{keyLabel(m.key)}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: font.weight.semibold,
            color: statusColor(m.status),
            border: `1px solid ${statusColor(m.status)}`,
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {m.status}
        </span>
        <span style={{ fontSize: 10, color: colors.textDim }}>· {m.source}</span>
        {m.source === "ai" && (
          <span style={{ fontSize: 10, color: colors.textDim }}>
            · {(m.confidence * 100).toFixed(0)}% conf
          </span>
        )}
        {m.category && (
          <span style={{ fontSize: 10, color: colors.textDim }}>· {m.category}</span>
        )}
      </div>

      {editing ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Edit value"
            style={{
              flex: 1,
              minWidth: 160,
              fontSize: 12.5,
              padding: "5px 8px",
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              background: colors.panel,
              color: colors.text,
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={correct.isPending || !draft.trim()}
            onClick={() => apply("EDIT", draft.trim())}
          >
            {correct.isPending ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: colors.text, lineHeight: 1.4 }}>{m.value}</div>
      )}

      {m.status === "CONFLICTED" && m.priorValue && !editing && (
        <div style={{ fontSize: 11, color: colors.warning, marginTop: 4 }}>
          Conflicting — was “{m.priorValue}”, now “{m.value}”. Pick the correct one.
        </div>
      )}

      {m.note && (
        <div style={{ fontSize: 11, color: colors.textDim, marginTop: 4 }}>Note: {m.note}</div>
      )}

      {editable && !editing && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button size="sm" variant="ghost" onClick={() => { setDraft(m.value); setEditing(true); }}>
            Edit
          </Button>
          {m.status === "CONFLICTED" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={correct.isPending}
                onClick={() => apply("RESOLVE_CONFLICT", m.value)}
              >
                Keep current
              </Button>
              {m.priorValue && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={correct.isPending}
                  onClick={() => apply("RESOLVE_CONFLICT", m.priorValue ?? undefined)}
                >
                  Keep prior
                </Button>
              )}
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={correct.isPending}
            onClick={() => apply("REMOVE")}
          >
            Remove
          </Button>
          {correct.isError && (
            <span style={{ fontSize: 10.5, color: colors.danger }}>
              {(correct.error as Error)?.message ?? "Failed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
