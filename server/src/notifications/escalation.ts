// ---------------------------------------------------------------------------
// Manual-queue escalation notifications (Phase 11)
// ---------------------------------------------------------------------------
// When a creator's ExecutionInstance enters MANUAL_REVIEW, the brand running the
// campaign needs to know a human must take over. This module emails the brand
// once per escalation and records the notice as a BrandNotification row so the
// app can show "the brand was (or wasn't) notified" on the manual queue.
//
// Design notes:
//   - Idempotent: keyed on (instanceId + reason). A BullMQ retry of the same
//     step re-enters here; the reserve insert hits the unique constraint and the
//     send is skipped. The brand is never double-emailed for the same event.
//   - Best-effort: a send/record failure must NEVER fail the state transition
//     that put the creator in the queue. Callers fire this after the state is
//     already persisted and swallow errors. A FAILED row is still written so the
//     UI can surface that the brand wasn't reached.
//   - Provider-agnostic: reuses the same IEmailProvider the workflow already
//     uses (mock | nylas). send() addresses the recipient via a Creator-shaped
//     object whose email/name are the brand's — both providers read only those.

import { eq } from "drizzle-orm";
import type {
  BrandNotification,
  BrandNotificationInsert,
  BrandNotificationStatus,
  Creator,
  DealHandoff,
  Event,
  EventInsert,
  EventType,
  Message,
} from "../db/schema.js";
import {
  campaigns,
  creators,
  executionInstances,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import { db } from "../db/drizzle.js";
import { isUniqueViolation } from "../db/errors.js";
import {
  createBrandNotification,
  findBrandNotificationByKey,
  updateBrandNotificationStatus,
  appendEvent,
  listEventsByInstance,
  listMessagesByInstance,
  findInstanceById,
} from "../db/index.js";
import { findEmailAccountById } from "../db/emailAccounts.js";
import { findDealHandoffByInstance } from "../db/dealHandoffs.js";
import { buildDraftHistory } from "../engine/executors/negotiationHistory.js";
import type { DraftHistoryEntry } from "../adapters/negotiation/types.js";
import type { IEmailProvider } from "../engine/providers.js";
import { emailProviderForAccount } from "../engine/providerFactory.js";
import type { EmailDraft } from "../engine/types.js";
import { DefaultThreadContextResolver } from "../engine/threadContext.js";

// The platform operator address — the last-resort recipient when a campaign has
// no notifyEmail and BRAND_NOTIFY_EMAIL is unset. Kept here (not just env) so a
// fresh checkout still routes escalations somewhere reachable in dev.
const OPERATOR_FALLBACK_EMAIL = "affiliatepartner@pluvus.com";

// Human-readable summary for each escalation reason code. The reason itself is
// the machine value persisted on BrandNotification.reason and the event payload.
const REASON_LABELS: Record<string, string> = {
  low_confidence_reply:
    "the AI could not confidently classify the creator's reply",
  output_guard_blocked:
    "an outbound draft was blocked by the safety guard before sending",
  escalated: "the negotiation agent escalated this conversation for human review",
  no_ceiling_configured:
    "this campaign has no maximum budget set, so the AI has no ceiling to negotiate within — set a maximum budget to let it auto-negotiate",
  agent_unavailable:
    "the AI agent was unavailable (degraded mode), so this was routed to a human",
  missing_brand_name:
    "a creator-facing email had no resolvable brand name to sign with (config needs fixing)",
  // Phase E (#5): always-escalate topics — a human must handle these regardless
  // of the AI's confidence (the agent may acknowledge but must not commit).
  legal_or_contract:
    "the creator raised a legal or contract change that needs a human to handle",
  dispute_or_hostile:
    "the creator raised a dispute, payment complaint, or hostile message",
  pricing_exception:
    "the creator asked for a custom fee structure, bonus, or guarantee outside the standard deal",
  undefined_terms:
    "the creator asked about a campaign term that isn't defined and needs a human to clarify",
  usage_rights_or_licensing:
    "the creator raised usage rights, exclusivity, or licensing — a commitment only a human can make",
  // Content submission: the creator replied with the link(s) to their published
  // content. An objective statement of fact — no judgment implied; a human opens
  // the links and reviews. (No payout/ledger action is triggered automatically.)
  content_links_submitted: "the creator submitted content links for review",
};

// PLU-70: the reason codes the operator-handoff branch notifies under. Kept
// distinct from the escalation reasons above because these are NOT failures —
// the AI did its job and closed a deal. `handoff_reply` is suffixed with the
// inbound message id at the call site so each distinct creator reply forwards
// exactly once while a retried delivery cannot double-send.
export const DEAL_FINALIZATION_REASON = "needs_deal_finalization";
export const HANDOFF_REPLY_REASON_PREFIX = "handoff_reply";

// The human name the brand confirmation email is signed with. The handoff note
// is written to read like a real campaign manager, not a system alert, so it
// carries a person's name rather than "— Pluvus Workflow Automation". A single
// operator runs the pilot today; when that changes, source this per-deployment
// (env var / campaign config) instead of the constant.
const HANDOFF_SENDER_NAME = "Ricky";

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? `it was escalated for human review (${reason})`;
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------
// Precedence: per-campaign notifyEmail → BRAND_NOTIFY_EMAIL env → operator.
// Returns null only if every source is empty AND the operator default is
// explicitly cleared (it never is by default), in which case we record SKIPPED.

export function resolveBrandRecipient(campaignNotifyEmail: string | null | undefined): string | null {
  const fromCampaign = campaignNotifyEmail?.trim();
  if (fromCampaign) return fromCampaign;
  const fromEnv = process.env["BRAND_NOTIFY_EMAIL"]?.trim();
  if (fromEnv) return fromEnv;
  return OPERATOR_FALLBACK_EMAIL || null;
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

interface EscalationContext {
  creator: Creator;
  campaignName: string | null;
  brandName: string | null;
  workflowName: string | null;
  notifyEmail: string | null;
  // The full both-sides conversation so far, so the escalation email can show the
  // operator exactly what was said instead of only pointing them to the dashboard.
  // Chronological (oldest → newest); empty when there is no history yet.
  transcript: DraftHistoryEntry[];
  // E6: the provider thread id for this instance (from the single-source-of-truth
  // ThreadContextResolver), so the escalation email can carry ONE deep-link to the
  // thread that now holds the whole conversation. undefined when no message has
  // threaded yet — the link is then omitted gracefully.
  threadId: string | null;
  // E6b: the RFC822 Message-ID of the first outbound message on this thread, used
  // to build the cold-load-safe Gmail deep-link (#search/rfc822msgid:…). The hex
  // thread id's #all/<id> alias only resolves when Gmail is already warm, so we key
  // the Gmail link off this header instead. null when it can't be resolved (mock
  // provider, unconfigured, no outbound message yet, or fetch failure) — the Gmail
  // section is then omitted gracefully.
  gmailRfc822MessageId: string | null;
  // Content-links escalation: the URLs the creator submitted, read from the latest
  // CONTENT_LINKS_SUBMITTED event that actually carried links. Empty/absent for every
  // other escalation reason — the URL section is then omitted from the notification.
  // Optional so pre-existing callers/fixtures that don't set it still typecheck; the
  // real loader always populates it (to [] when there are none).
  submittedUrls?: string[];
}

// DB seam — injectable so the reserve→send→finalize→audit sequencing (incl. the
// P2002 idempotency branch and the FAILED-on-send-error branch) is unit-testable
// without a live database. Defaults to the real db helpers.
export interface EscalationDeps {
  /**
   * `withTranscript: false` skips assembling the both-sides conversation. The
   * PLU-70 operator notices are deliberately concise and never render it, so
   * loading it would be pure cost on a path that closes deals in bulk.
   */
  loadContext(
    instanceId: string,
    opts?: { withTranscript?: boolean },
  ): Promise<EscalationContext | null>;
  findDealHandoffByInstance?(instanceId: string): Promise<DealHandoff | null>;
  createBrandNotification(data: BrandNotificationInsert): Promise<BrandNotification>;
  findBrandNotificationByKey(key: string): Promise<BrandNotification | null>;
  updateBrandNotificationStatus(
    id: string,
    data: { status: BrandNotificationStatus; error?: string | null },
  ): Promise<BrandNotification>;
  appendEvent(data: EventInsert): Promise<Event>;
  /** Resolve the run's pinned mailbox for every provider operation in the
   * notice (RFC822 lookup, thread URL, and send). Optional for existing tests. */
  resolveInstanceEmailProvider?(
    instanceId: string,
    callerProvider: IEmailProvider,
  ): Promise<IEmailProvider | null>;
  listMessagesByInstance?(instanceId: string): Promise<Message[]>;
}

async function resolveInstanceEmailProvider(
  instanceId: string,
  callerProvider: IEmailProvider,
): Promise<IEmailProvider | null> {
  if ((process.env["EMAIL_PROVIDER"] ?? "").toLowerCase() !== "nylas") {
    return callerProvider;
  }
  try {
    const instance = await findInstanceById(instanceId);
    if (!instance?.emailAccountId) return null;
    const account = await findEmailAccountById(instance.emailAccountId);
    if (!account || account.status !== "active") return null;
    return emailProviderForAccount(account);
  } catch (err) {
    console.error(
      `[escalation] could not resolve pinned mailbox for instance ${instanceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function loadEscalationContext(
  instanceId: string,
  opts?: { withTranscript?: boolean },
): Promise<EscalationContext | null> {
  // instance → creator + workflowVersion → workflow → (optional) campaign.
  const rows = await db
    .select({
      creator: creators,
      workflowName: workflows.name,
      campaignName: campaigns.name,
      brandName: campaigns.brand,
      notifyEmail: campaigns.notifyEmail,
    })
    .from(executionInstances)
    .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
    .innerJoin(
      workflowVersions,
      eq(executionInstances.workflowVersionId, workflowVersions.id),
    )
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .leftJoin(campaigns, eq(workflows.campaignId, campaigns.id))
    .where(eq(executionInstances.id, instanceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Assemble the both-sides transcript from the SAME source the negotiator/
  // copywriter use (buildDraftHistory): the instance's `Message` rows — our SENT
  // outbound rows interleaved with the creator's INBOUND messages, chronologically
  // (PLU-85). The NEGOTIATION_TURN events are passed only to enrich our outbound
  // entries with round/action/rate. Best-effort — a transcript failure must never
  // block the escalation notice, so a throw here degrades to an empty transcript
  // (the email still sends who/why + dashboard pointer). brandReplyMsgIds is
  // derived exactly as loadCreatorInbounds does.
  let transcript: DraftHistoryEntry[] = [];
  if (opts?.withTranscript === false) {
    // Concise notices (PLU-70 operator handoff) skip the transcript AND the E6
    // thread-link resolution — the operator reaches the thread via the CC on the
    // creator-facing handoff message, not a deep-link in this email, so the
    // resolver call would be pure cost. threadId/gmailRfc822MessageId are still
    // set (to null) to satisfy the EscalationContext contract; the handoff draft
    // builders ignore them.
    return {
      creator: row.creator,
      campaignName: row.campaignName ?? null,
      brandName: row.brandName ?? null,
      workflowName: row.workflowName ?? null,
      notifyEmail: row.notifyEmail ?? null,
      transcript,
      threadId: null,
      gmailRfc822MessageId: null,
    };
  }
  try {
    const [events, messages, inboundEvents] = await Promise.all([
      listEventsByInstance(instanceId, { type: "NEGOTIATION_TURN" }),
      listMessagesByInstance(instanceId),
      listEventsByInstance(instanceId, { type: "INBOUND_REPLY_RECEIVED" }),
    ]);
    const brandReplyMsgIds = new Set(
      inboundEvents
        .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
        .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
        .filter((id): id is string => typeof id === "string"),
    );
    transcript = buildDraftHistory(messages as Message[], brandReplyMsgIds, events);
  } catch (err) {
    console.error(
      `[escalation] could not assemble transcript for instance ${instanceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // E6: resolve the instance's thread id from the SAME source of truth the send
  // path uses (ThreadContextResolver), so the escalation email can deep-link the
  // one thread with the full history. Best-effort — a resolver/DB failure here
  // must never block the escalation notice, so a throw degrades to no threadId
  // (the email still sends and simply omits the link).
  let threadId: string | null = null;
  try {
    const ctx = await new DefaultThreadContextResolver().resolve(instanceId);
    threadId = ctx.threadId ?? null;
  } catch (err) {
    console.error(
      `[escalation] could not resolve threadId for instance ${instanceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Content-links escalation: read the submitted URLs from the most recent
  // CONTENT_LINKS_SUBMITTED event that actually carried links (the no-URL nudge
  // self-loop also emits this type with an empty urls array — skip those). Best-
  // effort — a failure here must not block the notice, so it degrades to no URLs.
  const submittedUrls = extractSubmittedUrls(
    await safeListEvents(instanceId, "CONTENT_LINKS_SUBMITTED"),
  );

  return {
    creator: row.creator,
    campaignName: row.campaignName ?? null,
    brandName: row.brandName ?? null,
    workflowName: row.workflowName ?? null,
    notifyEmail: row.notifyEmail ?? null,
    transcript,
    threadId,
    // Resolved by notifyBrandOfEscalation (it has the email provider); the DB seam
    // can't fetch a provider header, so it defaults to null here.
    gmailRfc822MessageId: null,
    submittedUrls,
  };
}

// Best-effort event read that never throws — a failure to load content-links
// events must not block the escalation notice.
async function safeListEvents(instanceId: string, type: EventType): Promise<Event[]> {
  try {
    return await listEventsByInstance(instanceId, { type });
  } catch (err) {
    console.error(
      `[escalation] could not load ${type} events for instance ${instanceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

// Pull the URLs from the most recent CONTENT_LINKS_SUBMITTED event that carried a
// non-empty `urls` array (the no-URL nudge self-loop emits the same type with an
// empty array). Returns [] when there is no such event.
export function extractSubmittedUrls(events: Event[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const raw = (payload as Record<string, unknown>)["urls"];
      if (Array.isArray(raw)) {
        const urls = raw.filter((u): u is string => typeof u === "string" && u.length > 0);
        if (urls.length > 0) return urls;
      }
    }
  }
  return [];
}

const defaultDeps: EscalationDeps = {
  loadContext: loadEscalationContext,
  findDealHandoffByInstance,
  createBrandNotification,
  findBrandNotificationByKey,
  updateBrandNotificationStatus,
  appendEvent,
  resolveInstanceEmailProvider,
  listMessagesByInstance,
};

// ---------------------------------------------------------------------------
// Gmail deep-link
// ---------------------------------------------------------------------------
// The Nylas-connected company mailbox is Gmail, so we want the escalation email to
// link straight into the OFFICIAL creator conversation there, where a human can
// read the full history and reply manually.
//
// IMPORTANT — why we do NOT use the hex thread id in a `#all/<id>` URL: that alias
// only resolves when Gmail is ALREADY loaded/warm in the tab; on a cold click it
// silently drops the id and lands on "All Mail". Google's own tooling documents
// that there is no supported way to build a Gmail web link from an API id. The
// one cold-load-safe deep-link is a `#search/rfc822msgid:<Message-ID>` search,
// which keys off the email's RFC822 `Message-ID` header (resolved via the
// provider's `rfc822MessageId()`), NOT the thread id.
//
// The URL is templated so an operator can retarget the account index / workspace
// without a code change. Absent the env var we default to the rfc822msgid search
// URL. Substitution: replace a `{messageId}` placeholder when present, else append;
// the id is URL-encoded (Gmail tolerates a raw `@`, but `+` etc. must be escaped).
// `{threadId}` is accepted as a legacy alias for the placeholder so an operator who
// set the old env var still gets a working (search-shaped) link. Pure (no I/O).
const DEFAULT_GMAIL_SEARCH_URL_TEMPLATE =
  "https://mail.google.com/mail/u/0/#search/rfc822msgid:{messageId}";

export function buildGmailThreadUrl(
  rfc822MessageId: string | null | undefined,
): string | undefined {
  if (!rfc822MessageId) return undefined;
  const template =
    process.env["GMAIL_THREAD_URL_TEMPLATE"]?.trim() || DEFAULT_GMAIL_SEARCH_URL_TEMPLATE;
  const encoded = encodeURIComponent(rfc822MessageId);
  if (template.includes("{messageId}")) {
    return template.replace(/\{messageId\}/g, encoded);
  }
  if (template.includes("{threadId}")) {
    // Legacy placeholder name — substitute the (safer) rfc822 id into it.
    return template.replace(/\{threadId\}/g, encoded);
  }
  return `${template}${encoded}`;
}

// ---------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------

// Cap the transcript rendered into the email so a very long negotiation doesn't
// produce a wall of text. We keep the MOST RECENT turns (the escalation trigger
// and the context around it are what the operator needs first) and note how many
// earlier turns were omitted, with a pointer to the dashboard for the full log.
const MAX_TRANSCRIPT_TURNS = 20;
// Trim any single message so one rambling reply can't dominate the email.
const MAX_TRANSCRIPT_MSG_CHARS = 600;

/** Render the both-sides transcript as a readable conversation block. Returns []
 *  (no lines) when there is no history, so first-turn escalations read as before. */
function renderTranscript(
  transcript: DraftHistoryEntry[],
  brandName: string | null,
  creatorName: string,
): string[] {
  if (!transcript.length) return [];

  const omitted = Math.max(0, transcript.length - MAX_TRANSCRIPT_TURNS);
  const shown = transcript.slice(-MAX_TRANSCRIPT_TURNS);
  const us = brandName ?? "You";

  const body: string[] = [];
  for (const t of shown) {
    const who = t.role === "creator" ? creatorName : us;
    // A round/action/rate tag on our turns gives the operator the negotiation
    // state at a glance (e.g. "You — round 2, COUNTER $375").
    const tag: string[] = [];
    if (t.role === "us") {
      if (typeof t.round === "number") tag.push(`round ${t.round}`);
      if (t.action) tag.push(t.action);
      if (typeof t.rate === "number") tag.push(`$${t.rate}`);
    }
    const header = tag.length ? `${who} — ${tag.join(", ")}:` : `${who}:`;
    let msg = (t.message ?? "").trim();
    if (msg.length > MAX_TRANSCRIPT_MSG_CHARS) {
      msg = `${msg.slice(0, MAX_TRANSCRIPT_MSG_CHARS)}… [truncated]`;
    }
    body.push(header, msg || "(no message text)", "");
  }
  // Drop the trailing blank separator.
  if (body[body.length - 1] === "") body.pop();

  const lines = [
    `─────────────────────────────────────────`,
    `Conversation so far${omitted > 0 ? ` (most recent ${MAX_TRANSCRIPT_TURNS} of ${transcript.length} messages; ${omitted} earlier omitted — see the dashboard for the full log)` : ""}:`,
    `─────────────────────────────────────────`,
    ``,
    ...body,
    ``,
    `─────────────────────────────────────────`,
  ];
  return lines;
}

/**
 * @param threadUrl optional provider deep-link builder (E6). When it yields a URL
 *   for the instance's threadId, the email carries a one-click link to the full
 *   thread; when it (or the threadId) is absent, the link is omitted gracefully.
 */
export function buildEscalationEmail(
  ctx: EscalationContext,
  reason: string,
  threadUrl?: (threadId: string) => string | undefined,
): EmailDraft {
  const { creator, brandName, campaignName, workflowName, transcript, threadId, gmailRfc822MessageId, submittedUrls } = ctx;
  const brand = brandName ?? "your brand";
  const creatorLine = creator.handle
    ? `${creator.name} (@${creator.handle})`
    : creator.name;

  const subject = `Action needed: ${creator.name} moved to the manual review queue`;

  // Retained but currently unused: the inline transcript is disabled below in
  // favor of the Gmail deep-link. Prefixed with `_` so noUnusedLocals stays happy
  // while keeping the render wired up for a one-line re-enable.
  const _transcriptLines = renderTranscript(transcript ?? [], brandName, creator.name);

  // E6: build the deep-link only when BOTH a threadId and a provider that can
  // turn it into a URL are present. Omitted entirely otherwise (no broken link).
  const threadLink = threadId && threadUrl ? threadUrl(threadId) : undefined;

  // Gmail deep-link into the OFFICIAL creator conversation on the company mailbox.
  // Built from the RFC822 Message-ID (cold-load-safe search URL) — present whenever
  // that id resolved; omitted cleanly on a first-turn escalation with no outbound
  // message yet, or when the provider can't supply the header.
  const gmailThreadLink = buildGmailThreadUrl(gmailRfc822MessageId);
  const gmailSection = gmailThreadLink
    ? [
        `─────────────────────────────────────────`,
        `⚠ Official Creator Conversation`,
        ``,
        `Continue this conversation directly from the official company mailbox.`,
        `Open Gmail Thread: ${gmailThreadLink}`,
        `─────────────────────────────────────────`,
        ``,
      ]
    : [];

  // Content-links escalation: list the submitted URLs so each is directly openable.
  // Compact by design — the conversation link (above) carries the full history; we
  // deliberately do NOT embed the transcript. Empty for every other escalation reason.
  const links = submittedUrls ?? [];
  const submittedUrlsSection =
    links.length > 0
      ? [
          `Submitted content links (${links.length}):`,
          ...links.map((u) => `  - ${u}`),
          ``,
        ]
      : [];

  const lines = [
    `Hi ${brand} team,`,
    ``,
    // Prominent, near-the-top pointer to the real Gmail thread so a human can jump
    // straight into the official conversation. Hidden entirely when there's no thread.
    ...gmailSection,
    `A creator in your outreach has been escalated to the manual review queue and needs a human to take over.`,
    ``,
    `Creator:   ${creatorLine}`,
    `Email:     ${creator.email}`,
    ...(creator.platform ? [`Platform:  ${creator.platform}`] : []),
    ...(creator.niche ? [`Niche:     ${creator.niche}`] : []),
    ...(campaignName ? [`Campaign:  ${campaignName}`] : []),
    ...(workflowName ? [`Workflow:  ${workflowName}`] : []),
    ``,
    `Why it was escalated: ${reasonLabel(reason)}.`,
    ``,
    // The creator's submitted content links, each on its own line so the operator
    // can open them directly. Present only for a content-links escalation; the
    // conversation link above remains the primary entry point to full context.
    ...submittedUrlsSection,
    // The full both-sides conversation, inline, so the operator can read exactly
    // what was said without leaving their inbox. Empty on a first-turn escalation.
    // TEMPORARILY DISABLED: the Gmail deep-link below now opens the real thread, so
    // the inline transcript is redundant. Re-enable by uncommenting the spread.
    // ...(transcriptLines.length ? [...transcriptLines, ``] : []),
    // E6 payoff: one link straight to the email thread that holds the whole
    // back-and-forth. Only present when a threaded thread id + a provider URL
    // builder both exist; omitted cleanly otherwise.
    ...(threadLink ? [`Open the full email thread: ${threadLink}`, ``] : []),
    `To continue the deal, reply to ${creator.name} directly at ${creator.email} — the automated workflow has PAUSED for this creator and will not send any further emails on its own. (Replying to THIS notification does nothing; it is an alert, not a routable thread.) You can also open the Manual Queue in the Pluvus dashboard.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// notifyBrandOfEscalation
// ---------------------------------------------------------------------------

export interface EscalationResult {
  status: "SENT" | "FAILED" | "SKIPPED" | "ALREADY_NOTIFIED";
  recipient: string | null;
}

/**
 * The shared reserve → send → finalize → audit sequence behind EVERY operator
 * notice (escalations and the PLU-70 handoff notices alike).
 *
 * Parameterized only by the reason code and a draft builder, so all three
 * callers share one copy of the guarantees that actually matter:
 *   - idempotent on (instanceId + reason) via the reserved BrandNotification row,
 *   - a send failure is recorded FAILED with the error rather than thrown,
 *   - no resolvable recipient is recorded SKIPPED rather than silently dropped,
 *   - never throws, so a notification can never block or roll back a state commit.
 *
 * `buildDraft` returning null means "there is nothing to send after all" — used
 * when the context a notice depends on is missing. It is recorded as SKIPPED so
 * the absence is still visible in the Manual Queue.
 */
async function deliverOperatorNotice(
  email: IEmailProvider,
  instanceId: string,
  reason: string,
  buildDraft: (
    ctx: EscalationContext,
    email: IEmailProvider,
  ) => Promise<EmailDraft | null> | EmailDraft | null,
  deps: EscalationDeps,
  opts?: { withTranscript?: boolean; logLabel?: string },
): Promise<EscalationResult> {
  const idempotencyKey = `escalation:${instanceId}:${reason}`;
  const label = opts?.logLabel ?? "escalation";

  try {
    const ctx = await deps.loadContext(instanceId, {
      withTranscript: opts?.withTranscript ?? true,
    });
    if (!ctx) {
      return { status: "SKIPPED", recipient: null };
    }

    const recipient = resolveBrandRecipient(ctx.notifyEmail);

    // ── Reserve (idempotency lock) ────────────────────────────────────────
    // Insert the row first so concurrent/retried steps can't both send. If the
    // key already exists, a prior attempt handled this escalation.
    let reservedId: string;
    try {
      const reserved = await deps.createBrandNotification({
        instanceId,
        recipient: recipient ?? "(none)",
        reason,
        status: recipient ? "SENT" : "SKIPPED",
        idempotencyKey,
      });
      reservedId = reserved.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const prior = await deps.findBrandNotificationByKey(idempotencyKey);
        return {
          status: "ALREADY_NOTIFIED",
          recipient: prior?.recipient ?? recipient,
        };
      }
      throw err;
    }

    // No recipient resolvable → record SKIPPED, no email, no event.
    if (!recipient) {
      return { status: "SKIPPED", recipient: null };
    }

    // Provider operations must stay in the execution's mailbox namespace. In a
    // Nylas deployment the caller is commonly the process-wide/default provider,
    // which may belong to another grant. Never use it for this run's header
    // lookup, link builder, or notice send when a pin cannot be resolved.
    const activeEmail = deps.resolveInstanceEmailProvider
      ? await deps.resolveInstanceEmailProvider(instanceId, email)
      : email;
    if (!activeEmail) {
      const message = "Pinned email account is unavailable";
      await deps.updateBrandNotificationStatus(reservedId, {
        status: "FAILED",
        error: message,
      });
      console.error(`[${label}] ${message} for instance ${instanceId}`);
      return { status: "FAILED", recipient };
    }

    // ── E6b: resolve the Gmail deep-link's rfc822 Message-ID ─────────────────
    // The cold-load-safe Gmail link keys off the RFC822 Message-ID of the first
    // OUTBOUND message on this thread (not the hex thread id). Resolve it here,
    // where we have the email provider. Best-effort: any failure leaves it null and
    // the Gmail section is simply omitted — the notice is never blocked.
    let gmailRfc822MessageId: string | null = null;
    if (activeEmail.rfc822MessageId) {
      try {
        const loadMessages = deps.listMessagesByInstance ?? listMessagesByInstance;
        const msgs = await loadMessages(instanceId);
        const firstOutbound = msgs
          .filter((m) => m.direction === "OUTBOUND" && m.externalMessageId)
          .sort(
            (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
          )[0];
        if (firstOutbound?.externalMessageId) {
          gmailRfc822MessageId =
            (await activeEmail.rfc822MessageId(firstOutbound.externalMessageId)) ?? null;
        }
      } catch (err) {
        console.error(
          `[escalation] could not resolve rfc822 Message-ID for instance ${instanceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ── Send ──────────────────────────────────────────────────────────────
    // Fold the freshly resolved Gmail Message-ID into the ctx handed to the
    // draft builder (loadContext leaves it null; it can only be resolved here,
    // where the email provider is available). The escalation builder reads it to
    // render the E6 cold-load-safe Gmail deep-link; handoff builders ignore it.
    const draft = await buildDraft({ ...ctx, gmailRfc822MessageId }, activeEmail);
    if (!draft) {
      // The notice had nothing to say (its backing record was missing). Record
      // SKIPPED so the gap is visible rather than silently absent.
      await deps.updateBrandNotificationStatus(reservedId, { status: "SKIPPED" });
      return { status: "SKIPPED", recipient };
    }
    // CRITICAL-2: address the brand via the explicit EmailRecipient rather than a
    // forged Creator-shaped object (the "brand-as-Creator" hack the audit flags).
    // These notices are ALERTS, not routable threads: they persist no Message row,
    // so a reply to one has nothing to route back into. (For PLU-70 the operator's
    // route INTO the conversation is the CC on the creator-facing handoff message,
    // not this email.) The creator is still passed as the thread owner for the
    // provider's fallback fields.
    try {
      await activeEmail.send(draft, ctx.creator, {
        email: recipient,
        name: ctx.brandName ?? ctx.creator.name,
      });
    } catch (sendErr) {
      const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
      await deps.updateBrandNotificationStatus(reservedId, { status: "FAILED", error: message });
      console.error(
        `[${label}] failed to email operator for instance ${instanceId} (reason ${reason}): ${message}`,
      );
      return { status: "FAILED", recipient };
    }

    // ── Audit event ───────────────────────────────────────────────────────
    await deps.appendEvent({
      instanceId,
      type: "BRAND_NOTIFIED",
      payload: { recipient, reason },
      occurredAt: new Date(),
    });

    console.log(
      `[${label}] operator notified for instance ${instanceId} → ${recipient} (reason ${reason})`,
    );
    return { status: "SENT", recipient };
  } catch (err) {
    // Final safety net: never let a notification failure bubble into the state
    // machine. Log and report, but do not throw.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${label}] unexpected error notifying operator for instance ${instanceId}: ${message}`,
    );
    return { status: "FAILED", recipient: null };
  }
}

/**
 * Notify the brand that a creator was escalated to the manual queue.
 *
 * Idempotent on (instanceId + reason): a second call for the same escalation
 * returns ALREADY_NOTIFIED without sending. Never throws — failures are recorded
 * as FAILED and returned, so the caller (the state machine) is never blocked.
 */
export async function notifyBrandOfEscalation(
  email: IEmailProvider,
  instanceId: string,
  reason: string,
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  return deliverOperatorNotice(
    email,
    instanceId,
    reason,
    (ctx, activeEmail) =>
      buildEscalationEmail(
        ctx,
        reason,
        activeEmail.threadUrl?.bind(activeEmail),
      ),
    deps,
    { logLabel: "escalation" },
  );
}

// ---------------------------------------------------------------------------
// PLU-70 — operator handoff notices
// ---------------------------------------------------------------------------

/** Render a dollar amount without a trailing ".0" (e.g. 560 → "$560"). */
function formatDollars(n: number): string {
  return `$${Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))}`;
}

/**
 * The "Fee" line of the confirmation email: the agreed fixed fee, with the
 * negotiation range in parentheses when it was captured — e.g.
 *   "$560 (your range: $500-$600)".
 * Commission-only deals (no fixed fee) return null so the caller omits the line;
 * the "Commission" line still states the commission.
 */
function formatFeeLine(handoff: DealHandoff): string | null {
  const { fixedFee, negotiationFloor, negotiationCeiling } = handoff;
  if (typeof fixedFee !== "number" || !Number.isFinite(fixedFee) || fixedFee <= 0) {
    return null;
  }
  const hasRange =
    typeof negotiationFloor === "number" &&
    Number.isFinite(negotiationFloor) &&
    typeof negotiationCeiling === "number" &&
    Number.isFinite(negotiationCeiling);
  const range = hasRange
    ? ` (your range: ${formatDollars(negotiationFloor!)}-${formatDollars(negotiationCeiling!)})`
    : "";
  return `${formatDollars(fixedFee)}${range}`;
}

/**
 * "A creator agreed to terms — reply Yes to approve."
 *
 * Written to read like a real campaign manager wrote it, not a system alert:
 * it restates the agreed terms as a confirmation request and asks the brand to
 * reply "Yes" to approve. It carries the AGREEMENT, not the conversation — the
 * operator opens the execution inspector when they want the thread.
 *
 * Reuses the campaign's existing escalation contact and the existing email
 * transport — there is no separate notification-email configuration for handoff.
 *
 * NOTE (copy only): the "reply Yes" ask is currently answered by a human. There
 * is no inbound "Yes" parser wired to auto-advance the deal — the operator reads
 * the reply and finalizes it in the Manual Queue as before.
 */
export function buildDealFinalizationEmail(
  ctx: EscalationContext,
  handoff: DealHandoff,
): EmailDraft {
  const { creator, brandName } = ctx;
  const campaignLabel = handoff.campaignName ?? ctx.campaignName;
  const creatorLine = creator.handle
    ? `${creator.name} (@${creator.handle})`
    : creator.name;

  const subject = `${creator.name} agreed to terms${
    campaignLabel ? ` — ${campaignLabel}` : ""
  } (please confirm)`;

  const feeLine = formatFeeLine(handoff);
  const hasCommission =
    typeof handoff.commissionRate === "number" &&
    Number.isFinite(handoff.commissionRate) &&
    handoff.commissionRate > 0;

  // Lead line — "within the range you set" only when we actually captured a band.
  const hasRange =
    typeof handoff.negotiationFloor === "number" &&
    Number.isFinite(handoff.negotiationFloor) &&
    typeof handoff.negotiationCeiling === "number" &&
    Number.isFinite(handoff.negotiationCeiling);
  const leadRange = hasRange ? ", within the range you set" : "";
  const campaignPhrase = campaignLabel ? ` for the ${campaignLabel} campaign` : "";

  const lines = [
    `Hi ${brandName ?? "there"},`,
    ``,
    `${creator.name} has agreed to terms${campaignPhrase}${leadRange}. Details below for your confirmation:`,
    ``,
    `Terms agreed`,
    `Creator: ${creatorLine}${creator.platform ? ` on ${creator.platform}` : ""}`,
    ...(feeLine ? [`Fee: ${feeLine}`] : []),
    ...(hasCommission
      ? [`Commission: ${formatAmount(handoff.commissionRate!)}% on sales through the referral link`]
      : []),
    ...(handoff.deliverables ? [`Deliverables: ${handoff.deliverables}`] : []),
    ...(handoff.timeline ? [`Timeline: ${handoff.timeline}`] : []),
    ...(handoff.paymentTerms ? [`Payment terms: ${handoff.paymentTerms}`] : []),
    ...(handoff.rewardDescription ? [`Perk: ${handoff.rewardDescription}`] : []),
    ``,
    `The creator is holding on this pending your confirmation.`,
    ``,
    `Reply "Yes" to approve and we'll send the contract and move into production. If we don't hear back, we'll hold the campaign until you confirm.`,
    ``,
    `Best,`,
    HANDOFF_SENDER_NAME,
  ];

  return { subject, body: lines.join("\n") };
}

/** Trim a trailing ".0" so a whole number reads as "10", not "10.0". */
function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/**
 * Notify the campaign's escalation contact that a deal is ready to finalize.
 *
 * Fired by runtime.stepInstance on a fresh transition into
 * NEEDS_DEAL_FINALIZATION, AFTER the state is committed. Idempotent on
 * (instanceId + "needs_deal_finalization"), so retried delivery can never
 * duplicate the transition or the DealHandoff record.
 *
 * If no recipient resolves, or the send fails, the handoff is NOT lost: the
 * instance stays in NEEDS_DEAL_FINALIZATION and remains visible in the Manual
 * Queue, and the BrandNotification row records SKIPPED/FAILED so the UI can show
 * that the operator was not reached (and offer a re-send).
 */
export async function notifyOperatorOfDealFinalization(
  email: IEmailProvider,
  instanceId: string,
  deps: EscalationDeps = defaultDeps,
  reason: string = DEAL_FINALIZATION_REASON,
): Promise<EscalationResult> {
  const loadHandoff = deps.findDealHandoffByInstance ?? findDealHandoffByInstance;
  return deliverOperatorNotice(
    email,
    instanceId,
    reason,
    async (ctx) => {
      const handoff = await loadHandoff(instanceId);
      if (!handoff) {
        console.error(
          `[deal-handoff] no DealHandoff row for instance ${instanceId} — nothing to notify about`,
        );
        return null;
      }
      return buildDealFinalizationEmail(ctx, handoff);
    },
    deps,
    // The whole point of this email is that it is short. Skip transcript assembly.
    { withTranscript: false, logLabel: "deal-handoff" },
  );
}

/** Forward a creator reply that arrived while the deal was parked on an operator. */
export function buildHandoffReplyEmail(
  ctx: EscalationContext,
  reply: { subject: string; body: string },
): EmailDraft {
  const { creator } = ctx;
  const subject = `${creator.name} replied — ${creator.email}`;

  const lines = [
    `${creator.name} replied while their deal is awaiting finalization.`,
    ``,
    `From:    ${creator.name} <${creator.email}>`,
    `Subject: ${reply.subject}`,
    ``,
    `─────────────────────────────────────────`,
    reply.body.trim() || "(no message text)",
    `─────────────────────────────────────────`,
    ``,
    `Reply to ${creator.name} directly at ${creator.email}. The automated workflow will NOT respond on its own — you own this conversation.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}

/**
 * Forward an inbound creator reply to the operator during NEEDS_DEAL_FINALIZATION.
 *
 * The CC on the handoff message already puts the operator in the thread for a
 * "reply all". This covers the creator who hits plain "reply" and therefore
 * reaches only our mailbox. Keyed on the inbound message id, so each distinct
 * reply forwards exactly once while a retried delivery cannot double-send.
 */
export async function notifyOperatorOfHandoffReply(
  email: IEmailProvider,
  instanceId: string,
  reply: { externalMessageId: string; subject: string; body: string },
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  return deliverOperatorNotice(
    email,
    instanceId,
    `${HANDOFF_REPLY_REASON_PREFIX}:${reply.externalMessageId}`,
    (ctx) => buildHandoffReplyEmail(ctx, reply),
    deps,
    { withTranscript: false, logLabel: "deal-handoff" },
  );
}
