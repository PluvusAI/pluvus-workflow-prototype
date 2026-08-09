import { useState } from "react";
import { LifeBuoy, Link2, MessagesSquare } from "lucide-react";
import {
  useManualQueue,
  notifyBrand,
  completeHandoff,
  approveManualReview,
  rejectManualReview,
  optOutManualReview,
  useBuilderInvalidator,
} from "../../api/builderClient";
import { POLL_INTERVAL_MS } from "../../api/client";
import { colors, radii, font, formatTimestamp, relativeTime } from "../../theme";
import { StatTile, EmptyState, SectionHeader, useToast } from "../ds";
import { InstanceInspector } from "../InstanceInspector";
import type { WorkflowDetail } from "../../api/builderTypes";
import type {
  ManualQueueItem,
  BrandNotificationStatus,
} from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
}

// Colour + label per brand-notification status.
const notifyMeta: Record<
  BrandNotificationStatus | "NONE",
  { label: string; color: string }
> = {
  SENT: { label: "Brand notified", color: colors.success },
  FAILED: { label: "Notification failed", color: colors.danger },
  SKIPPED: { label: "No recipient", color: colors.textDim },
  NONE: { label: "Not notified", color: colors.warning },
};

export function ManualQueueTab({ workflow }: Props) {
  const queue = useManualQueue(workflow.id);
  const inv = useBuilderInvalidator(workflow.id);
  const toast = useToast();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [notifying, setNotifying] = useState<string | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);

  const data = queue.data;
  const hasVersion = !!workflow.latestVersion;

  if (!hasVersion) {
    return (
      <EmptyState
        icon={<LifeBuoy size={24} strokeWidth={1.75} color={colors.textMuted} />}
        title="Manual queue is empty"
        description="Publish and launch the workflow first. Creators the AI can't handle on its own — and deals waiting for operator onboarding — will appear here for a human to pick up."
      />
    );
  }

  if (!data || data.total === 0) {
    return (
      <EmptyState
        icon={<LifeBuoy size={24} strokeWidth={1.75} color={colors.textMuted} />}
        title="Nothing needs a human"
        description={`No escalations and no deals awaiting onboarding. Auto-refreshes every ${POLL_INTERVAL_MS / 1000}s.`}
      />
    );
  }

  const notifiedCount = data.items.filter((i) => i.notification?.status === "SENT").length;
  const failedCount = data.items.filter(
    (i) => !i.notification || i.notification.status === "FAILED",
  ).length;
  // PLU-70: the queue holds two kinds of work now. Counting deals separately
  // keeps "how many agreements am I sitting on?" answerable at a glance.
  const handoffCount = data.items.filter((i) => i.kind === "handoff").length;

  async function handleNotify(item: ManualQueueItem) {
    setNotifying(item.instanceId);
    try {
      const res = await notifyBrand(item.instanceId);
      if (res.status === "SENT" || res.status === "ALREADY_NOTIFIED") {
        toast.success(
          res.recipient
            ? `Notified ${res.recipient}.`
            : "Brand notification sent.",
        );
      } else if (res.status === "SKIPPED") {
        toast.error("No notification recipient is configured for this campaign.");
      } else {
        toast.error("Notification failed to send. Check the email provider.");
      }
      await inv.invalidateManualQueue();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Notification failed.");
    } finally {
      setNotifying(null);
    }
  }

  async function handleComplete(item: ManualQueueItem) {
    setCompleting(item.instanceId);
    try {
      await completeHandoff(item.instanceId);
      toast.success(`${item.creatorName} marked as onboarded.`);
      await inv.invalidateManualQueue();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not complete the handoff.");
    } finally {
      setCompleting(null);
    }
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div className="ds-fade-in" style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div
          style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "24px 28px 40px",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className={queue.isFetching ? undefined : "ds-pulse"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: queue.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 8px ${queue.isFetching ? colors.warning : colors.success}66`,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: font.size.md, fontWeight: font.weight.medium, color: colors.text }}>
            Manual Queue
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
            v{workflow.latestVersion?.version} · refreshes every {POLL_INTERVAL_MS / 1000}s
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: "auto" }}>
            Updated {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        <p style={{ fontSize: font.size.md, color: colors.textMuted, margin: 0, lineHeight: 1.6, maxWidth: 640 }}>
          Creators waiting on a human. Some were escalated because the AI could not safely proceed;
          others agreed to a deal on a campaign set to operator onboarding, and are ready for you to
          finalize and onboard in Pluvus. The campaign contact is emailed either way.
        </p>

        {/* Totals */}
        <div style={{ display: "flex", gap: 14 }}>
          <StatTile label="In Queue" value={data.total} color={colors.warning} />
          <StatTile
            label="Deals to Onboard"
            value={handoffCount}
            color={handoffCount > 0 ? colors.success : colors.textMuted}
          />
          <StatTile label="Brand Notified" value={notifiedCount} color={colors.success} />
          <StatTile label="Needs Attention" value={failedCount} color={failedCount > 0 ? colors.danger : colors.textMuted} />
        </div>

        {/* Queue list */}
        {data.total > 0 && (
          <div>
            <SectionHeader count={data.total}>Needs a Human</SectionHeader>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {data.items.map((item) => (
                <QueueRow
                  key={item.instanceId}
                  item={item}
                  selected={selectedInstanceId === item.instanceId}
                  notifying={notifying === item.instanceId}
                  onOpen={() => setSelectedInstanceId(item.instanceId)}
                  onNotify={() => void handleNotify(item)}
                  completing={completing === item.instanceId}
                  onComplete={() => void handleComplete(item)}
                  onResolved={(msg) => {
                    toast.success(msg);
                    void inv.invalidateManualQueue();
                  }}
                  onResolveError={(msg) => toast.error(msg)}
                />
              ))}
            </div>
          </div>
        )}

        </div>
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div
          className="ds-slide-in-right"
          style={{
            width: 400,
            flexShrink: 0,
            borderLeft: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
          <InstanceInspector
            instanceId={selectedInstanceId}
            onClose={() => setSelectedInstanceId(null)}
          />
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  selected,
  notifying,
  onOpen,
  onNotify,
  completing,
  onComplete,
  onResolved,
  onResolveError,
}: {
  item: ManualQueueItem;
  selected: boolean;
  notifying: boolean;
  onOpen: () => void;
  onNotify: () => void;
  completing: boolean;
  onComplete: () => void;
  onResolved: (message: string) => void;
  onResolveError: (message: string) => void;
}) {
  const notify = item.notification;
  const meta = notifyMeta[notify?.status ?? "NONE"];
  // PLU-70: a handoff row answers "what did we agree, and when?" — an escalation
  // row answers "why did the AI stop?". Same shell, different middle.
  const handoff = item.kind === "handoff" ? item.handoff : null;
  // PLU-154: a live escalation row can be resolved by a human. An expired row is
  // read-only (the case timed out); a handoff has its own "mark completed" action.
  const resolvable = item.kind === "escalation";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
        padding: "14px 18px",
        background: selected ? "#16171e" : colors.panel,
        border: `1px solid ${selected ? `${colors.accent}66` : colors.border}`,
        borderRadius: radii.md,
        boxShadow: selected
          ? `0 0 0 3px ${colors.accent}1f, 0 1px 2px rgba(0,0,0,0.4)`
          : "0 1px 2px rgba(0,0,0,0.4)",
        transition: "border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
      }}
    >
      {/* Creator + reason — clickable to open inspector */}
      <button
        onClick={onOpen}
        className="ds-focusable"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: "transparent",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            style={{
              fontSize: font.size.lg,
              fontWeight: font.weight.semibold,
              color: colors.text,
              letterSpacing: -0.2,
            }}
          >
            {item.creatorName}
          </span>
          {item.creatorHandle && (
            <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
              @{item.creatorHandle}
            </span>
          )}
          {item.platform && (
            <span style={{ fontSize: font.size.sm, color: colors.textDim }}>· {item.platform}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          {handoff ? (
            <>
              {/* Compensation is the headline: it is what the operator needs to
                  act on, and it is the one fact a compact row must carry. */}
              <span
                style={{
                  fontSize: font.size.xs,
                  fontWeight: font.weight.semibold,
                  color: colors.success,
                  background: "rgba(62,207,142,0.12)",
                  border: "1px solid rgba(62,207,142,0.3)",
                  borderRadius: radii.pill,
                  padding: "2px 9px",
                  lineHeight: 1.5,
                }}
              >
                ✓ {handoff.agreedCompensation}
              </span>
              {handoff.campaignName && (
                <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
                  {handoff.campaignName}
                </span>
              )}
              <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
                · accepted {relativeTime(handoff.acceptedAt)}
              </span>
              <span
                style={{
                  fontSize: font.size.sm,
                  color:
                    handoff.status === "COMPLETED" ? colors.success : colors.warning,
                }}
              >
                · {handoff.status === "COMPLETED" ? "Onboarded" : "Awaiting finalization"}
              </span>
            </>
          ) : (
            <>
              <span
                style={{
                  fontSize: font.size.xs,
                  fontWeight: font.weight.medium,
                  color: "#e5b454",
                  background: "rgba(229,180,84,0.12)",
                  border: "1px solid rgba(229,180,84,0.3)",
                  borderRadius: radii.pill,
                  padding: "2px 9px",
                  lineHeight: 1.5,
                }}
              >
                ⚠ {item.reasonLabel}
              </span>
              <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
                {item.escalatedAt
                  ? `escalated ${relativeTime(item.escalatedAt)}`
                  : `updated ${relativeTime(item.updatedAt)}`}
              </span>
              {item.negotiationRound > 0 && (
                <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
                  · round {item.negotiationRound}
                </span>
              )}
              {/* PLU-154: deadline countdown + nudge count. Only when the timeout
                  feature is on (deadline present). An expired row says so. */}
              {item.timedOut ? (
                <span style={{ fontSize: font.size.sm, color: colors.danger }}>
                  · timed out
                </span>
              ) : (
                item.deadline && (
                  <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
                    · resolve by {relativeTime(item.deadline)}
                    {item.nudgeCount > 0 && ` · ${item.nudgeCount} nudge${item.nudgeCount === 1 ? "" : "s"} sent`}
                  </span>
                )
              )}
            </>
          )}
        </div>
      </button>

      {/* Content-links escalation: the URLs the creator submitted, each an
          openable anchor. Notify-only — the queue is a launch point, not a control
          panel: there is NO approve/reject action. Rendered on its own row
          (flexBasis 100%) so it wraps below the creator/reason line. Outside the
          button (anchors can't nest in a button); order:-1 places it below via the
          row's wrap. Omitted entirely when there are no submitted links. */}
      {item.linkCount > 0 && (
        <div
          style={{
            flexBasis: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 3,
            marginTop: 4,
            paddingLeft: 2,
          }}
        >
          <span style={{ fontSize: font.size.xs, color: colors.textDim }}>
            <Link2 size={13} strokeWidth={1.75} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {item.linkCount} content link{item.linkCount === 1 ? "" : "s"} submitted
          </span>
          {item.submittedUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="ds-focusable"
              title={url}
              style={{
                fontSize: font.size.sm,
                color: colors.accent,
                textDecoration: "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {url}
            </a>
          ))}
        </div>
      )}

      {/* E6: one-click deep-link to the email thread holding the full
          conversation. Rendered only when the provider supplied a URL — omitted
          gracefully otherwise (mock/unconfigured provider, or not yet threaded).
          Outside the reason button so it's a real anchor, and stopPropagation so
          opening the thread doesn't also open the inspector. */}
      {item.threadUrl && (
        <a
          href={item.threadUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ds-focusable"
          title="Open the full email thread"
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: font.size.sm,
            color: colors.accent,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          <MessagesSquare size={13} strokeWidth={1.75} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Open thread
        </a>
      )}

      {/* Notification status */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: font.size.sm, color: meta.color }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.color }} />
          {meta.label}
        </span>
        {notify?.recipient && notify.status !== "SKIPPED" && (
          <span style={{ fontSize: font.size.xs, color: colors.textDim }}>{notify.recipient}</span>
        )}
        {notify?.status === "FAILED" && notify.error && (
          <span
            style={{ fontSize: font.size.xs, color: colors.danger, maxWidth: 200, textAlign: "right" }}
            title={notify.error}
          >
            {notify.error.length > 40 ? `${notify.error.slice(0, 40)}…` : notify.error}
          </span>
        )}
      </div>

      {/* PLU-70: the single operator action. Only on an un-onboarded handoff. */}
      {handoff && handoff.status !== "COMPLETED" && (
        <button
          onClick={onComplete}
          disabled={completing}
          className="ds-focusable ds-btn ds-btn-primary"
          style={{
            flexShrink: 0,
            fontSize: font.size.sm,
            fontWeight: font.weight.semibold,
            color: "#fff",
            background: colors.success,
            border: "1px solid transparent",
            borderRadius: radii.sm + 1,
            padding: "0 14px",
            height: 32,
            cursor: completing ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
          title="Mark this handoff complete once you have finalized the deal and onboarded the creator in Pluvus"
        >
          {completing ? "Saving…" : "Mark completed"}
        </button>
      )}

      {/* Notify / resend action */}
      <button
        onClick={onNotify}
        disabled={notifying}
        className={`ds-focusable ds-btn ${notify?.status === "SENT" ? "ds-btn-secondary" : "ds-btn-primary"}`}
        style={{
          flexShrink: 0,
          fontSize: font.size.sm,
          fontWeight: notify?.status === "SENT" ? font.weight.medium : font.weight.semibold,
          color: notify?.status === "SENT" ? colors.text : "#fff",
          background: notify?.status === "SENT" ? colors.panel : colors.accent,
          border: `1px solid ${notify?.status === "SENT" ? colors.borderStrong : "transparent"}`,
          borderRadius: radii.sm + 1,
          padding: "0 14px",
          height: 32,
          cursor: notifying ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {notifying
          ? "Sending…"
          : notify?.status === "SENT"
            ? "Resend"
            : "Notify brand"}
      </button>

      {/* PLU-154: human resolution actions — approve/finalize, reject/close,
          creator opted-out. Full-width strip below the row (flexBasis 100%). Only
          on a live escalation; a handoff/expired row shows its own affordance. */}
      {resolvable && (
        <ResolutionPanel
          item={item}
          onResolved={onResolved}
          onResolveError={onResolveError}
        />
      )}
    </div>
  );
}

// PLU-154: the resolve-a-case controls. Self-contained (its own form + in-flight
// state) so QueueRow stays a display component. Approve opens a small terms form;
// reject/opt-out take an optional reason. Buttons disable while in-flight (the OCC
// on the server also guards a double-click).
function ResolutionPanel({
  item,
  onResolved,
  onResolveError,
}: {
  item: ManualQueueItem;
  onResolved: (message: string) => void;
  onResolveError: (message: string) => void;
}) {
  const [mode, setMode] = useState<null | "approve" | "reject" | "opt-out">(null);
  const [busy, setBusy] = useState(false);
  const [resolvedBy, setResolvedBy] = useState("");
  const [reason, setReason] = useState("");
  const [fee, setFee] = useState("");
  const [commission, setCommission] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [approvedDeviation, setApprovedDeviation] = useState(false);

  async function submit() {
    if (!resolvedBy.trim()) {
      onResolveError("Enter your name (resolvedBy) before resolving.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "approve") {
        await approveManualReview(item.instanceId, {
          resolvedBy: resolvedBy.trim(),
          reason: reason.trim() || undefined,
          terms: {
            fixedFee: fee.trim() ? Number(fee) : undefined,
            commissionRate: commission.trim() ? Number(commission) : undefined,
            deliverables: deliverables.trim() || undefined,
            approvedDeviation: approvedDeviation || undefined,
          },
        });
        onResolved(`${item.creatorName} approved → ready for onboarding.`);
      } else if (mode === "reject") {
        await rejectManualReview(item.instanceId, {
          resolvedBy: resolvedBy.trim(),
          reason: reason.trim() || undefined,
        });
        onResolved(`${item.creatorName} rejected.`);
      } else if (mode === "opt-out") {
        await optOutManualReview(item.instanceId, {
          resolvedBy: resolvedBy.trim(),
          reason: reason.trim() || undefined,
        });
        onResolved(`${item.creatorName} recorded as opted out.`);
      }
      setMode(null);
    } catch (err) {
      onResolveError(err instanceof Error ? err.message : "Could not resolve the case.");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    fontSize: font.size.sm,
    color: colors.text,
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.sm,
    padding: "5px 8px",
  } as const;

  return (
    <div style={{ flexBasis: "100%", marginTop: 4 }}>
      {mode === null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ds-focusable ds-btn ds-btn-secondary" style={resolveBtnStyle} onClick={() => setMode("approve")}>
            Approve / finalize
          </button>
          <button className="ds-focusable ds-btn ds-btn-secondary" style={resolveBtnStyle} onClick={() => setMode("reject")}>
            Reject / close
          </button>
          <button className="ds-focusable ds-btn ds-btn-secondary" style={resolveBtnStyle} onClick={() => setMode("opt-out")}>
            Creator opted out
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "10px 12px",
            border: `1px solid ${colors.border}`,
            borderRadius: radii.sm,
            background: "#14151b",
          }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              style={{ ...inputStyle, flex: "1 1 160px" }}
              placeholder="Your name (required)"
              value={resolvedBy}
              onChange={(e) => setResolvedBy(e.target.value)}
            />
            <input
              style={{ ...inputStyle, flex: "2 1 220px" }}
              placeholder={mode === "approve" ? "Note (optional)" : "Reason (optional)"}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {mode === "approve" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input style={{ ...inputStyle, width: 120 }} placeholder="Fee ($)" value={fee} onChange={(e) => setFee(e.target.value)} />
              <input style={{ ...inputStyle, width: 140 }} placeholder="Commission (0–1)" value={commission} onChange={(e) => setCommission(e.target.value)} />
              <input style={{ ...inputStyle, flex: "1 1 200px" }} placeholder="Deliverables (optional)" value={deliverables} onChange={(e) => setDeliverables(e.target.value)} />
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: font.size.xs, color: colors.textDim }}>
                <input type="checkbox" checked={approvedDeviation} onChange={(e) => setApprovedDeviation(e.target.checked)} />
                Approve out-of-band fee
              </label>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="ds-focusable ds-btn ds-btn-primary"
              style={{ ...resolveBtnStyle, background: colors.accent, color: "#fff", border: "1px solid transparent" }}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "Saving…" : mode === "approve" ? "Confirm approve" : mode === "reject" ? "Confirm reject" : "Confirm opt-out"}
            </button>
            <button className="ds-focusable ds-btn ds-btn-secondary" style={resolveBtnStyle} disabled={busy} onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const resolveBtnStyle = {
  fontSize: font.size.sm,
  fontWeight: font.weight.medium,
  color: colors.text,
  background: colors.panel,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radii.sm + 1,
  padding: "0 12px",
  height: 30,
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;

