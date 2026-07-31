import {
  createMessage as createMessageDb,
  findMessageByIdempotencyKey as findByKeyDb,
  findMessageById as findByIdDb,
  updateMessageSent as updateMessageSentDb,
  findInstanceById as findInstanceByIdDb,
  findCreatorById as findCreatorByIdDb,
} from "../../db/index.js";
import { findCampaignById } from "../../db/campaigns.js";
import { findWorkflowById, findVersionById } from "../../db/workflows.js";
import { findEmailAccountById } from "../../db/emailAccounts.js";
import { emailProviderForAccount } from "../providerFactory.js";
import { isUniqueViolation } from "../../db/errors.js";
import type { DeferralClassifier } from "../../db/conversationObligations.js";
import type { ConversationObligation, Creator, Message, MessageInsert } from "../../db/schema.js";
import type { EmailAttachment, EmailDraft } from "../types.js";
import { isQuestionDeferredBySentBody } from "./commitmentDetection.js";
import type { IEmailProvider, EmailRecipient, EmailSendOptions } from "../providers.js";
import { isThreadLabeler } from "../providers.js";
import { campaignLabelName } from "../../providers/nylas/campaignLabel.js";
import {
  acquireSendLock as acquireSendLockDefault,
  releaseSendLock as releaseSendLockDefault,
} from "../../scheduler/lock.js";
import {
  DefaultThreadContextResolver,
  buildReplySubject,
  type ThreadContext,
  type ThreadContextResolver,
} from "../threadContext.js";

// ---------------------------------------------------------------------------
// Idempotent outbound send (FIX-11, generalized) — reserve/flush split
// ---------------------------------------------------------------------------
// Reserve-before-send: insert the OUTBOUND message row with a deterministic
// idempotencyKey BEFORE calling email.send(), using the row's unique constraint
// as the lock. The window being closed: a crash between email.send() and the
// row write would, on BullMQ retry, re-run the executor and send a SECOND email.
//
// Randomized Send Delay (§4.1): the reserve→send→finalize sequence is SPLIT so a
// randomized delay can sit between the decision (reserve) and delivery (flush):
//
//   reserveOutbound(...)  — resolve thread context, write the OUTBOUND row with
//                           idempotencyKey/subject/body. NEVER sends (not even on
//                           the P2002 reserved-but-unsent branch — that send
//                           moves to flush). Returns a STABLE messageId (§4.1b).
//   flushOutbound(id)     — reload the send context from the row (§4.1a), then
//                           provider.send + finalize + label, under a per-send
//                           lock with a post-lock NULL re-check (§4.2a).
//
//   sendOnce(...)         — the thin reserve→flush wrapper. Every EXISTING caller
//                           (outreach, follow-up, transactional) uses it and stays
//                           synchronous with identical behavior. Only the
//                           negotiation executor opts into the split (reserve now,
//                           enqueue a delayed flush after the OCC commit).

export interface SentResult {
  messageId: string;
  threadId: string;
  /** True when a prior attempt had already sent this exact message (the send was
   *  skipped on this attempt). False on a first, fresh send. */
  alreadySent: boolean;
}

// DB seam — injectable so the reserve→send→finalize sequencing (incl. the P2002
// branch) is unit-testable without a live database. Defaults to the real db.
export interface SendOnceDeps {
  createMessage(data: MessageInsert): Promise<Message>;
  findMessageByIdempotencyKey(key: string): Promise<Message | null>;
  // PLU-111: the optional deferralClassifier lets the flush pass the SENT body +
  // §4.8 deferral vocabulary so the DB resolution can tell answered vs deferred.
  updateMessageSent(
    id: string,
    // PLU-121: emailAccountId attributes the sent row to the mailbox it went out
    // on. Optional so pre-multi-mailbox callers/tests are unchanged.
    data: { externalMessageId: string; threadId: string; emailAccountId?: string },
    deferralClassifier?: DeferralClassifier,
  ): Promise<Message>;
  // E5: resolves the instance's thread state (reply target + canonical subject)
  // so every send threads onto the existing conversation. Injectable for tests;
  // defaults to the real one-read resolver.
  threadContext: ThreadContextResolver;
}

// Extra seams the DELAYED flush needs on top of SendOnceDeps: it receives only a
// messageId and must reload the full send context (§4.1a) — the row, the
// instance→creator (recipient), and the campaign name (label). Plus the per-send
// lock (§4.2a). All injectable so flushOutbound is unit-testable without Redis or
// a live DB; every field defaults to the real implementation.
export interface FlushDeps extends SendOnceDeps {
  findMessageById(id: string): Promise<Message | null>;
  findInstanceById(id: string): Promise<{ id: string; creatorId: string; workflowVersionId: string } | null>;
  findCreatorById(id: string): Promise<Creator | null>;
  /** Resolve the human campaign name for the Gmail label from an instance id,
   *  or undefined when there is no linked campaign. */
  resolveCampaignName(instanceId: string): Promise<string | undefined>;
  acquireSendLock(messageId: string): Promise<string | null>;
  releaseSendLock(messageId: string, token: string): Promise<void>;
  /**
   * PLU-121 (multi-mailbox): resolve the provider bound to the instance's PINNED
   * connected account, plus that account's id (to stamp on the sent Message).
   * Returns null when the run has no pinned account or the deployment isn't Nylas
   * — the caller then falls back to the provider it was handed (the env grant),
   * so single-mailbox behavior and every existing test are unchanged. Injectable
   * for tests; defaults to the real resolver. Optional so a test that injects a
   * full FlushDeps literal without it simply gets single-mailbox behavior.
   */
  resolveInstanceProvider?(
    instanceId: string,
  ): Promise<{ provider: IEmailProvider; accountId: string } | null>;
}

const defaultThreadContext = new DefaultThreadContextResolver();

const defaultDeps: SendOnceDeps = {
  createMessage: createMessageDb,
  findMessageByIdempotencyKey: findByKeyDb,
  updateMessageSent: updateMessageSentDb,
  threadContext: defaultThreadContext,
};

// Default campaign-name resolution for the flush (§4.1a step 4): instance →
// workflowVersion → workflow → campaign.name. Best-effort — any missing link or
// lookup failure degrades to "no label" (undefined), exactly like the runtime's
// own campaign fallback. Never throws.
async function defaultResolveCampaignName(instanceId: string): Promise<string | undefined> {
  try {
    const instance = await findInstanceByIdDb(instanceId);
    if (!instance) return undefined;
    const version = await findVersionById(instance.workflowVersionId);
    if (!version) return undefined;
    const workflow = await findWorkflowById(version.workflowId);
    if (!workflow?.campaignId) return undefined;
    const campaign = await findCampaignById(workflow.campaignId);
    return campaign?.name ?? undefined;
  } catch {
    return undefined;
  }
}

// PLU-121: resolve the run's pinned connected account into a grant-bound provider.
// Engages ONLY for a real Nylas deployment with a pinned, active account; every
// other case (mock provider, no accounts configured, unpinned legacy run) returns
// null so flush keeps using the provider it was handed — preserving single-mailbox
// behavior and leaving all existing tests, which never pin an account, untouched.
async function defaultResolveInstanceProvider(
  instanceId: string,
): Promise<{ provider: IEmailProvider; accountId: string } | null> {
  if ((process.env["EMAIL_PROVIDER"] ?? "").toLowerCase() !== "nylas") return null;
  try {
    const instance = await findInstanceByIdDb(instanceId);
    const accountId = instance?.emailAccountId;
    if (!accountId) return null;
    const account = await findEmailAccountById(accountId);
    if (!account || account.status !== "active") return null;
    return { provider: emailProviderForAccount(account), accountId: account.id };
  } catch (err) {
    // Never let account resolution block a contract-forming send: degrade to the
    // caller-supplied provider (the env grant) and log.
    console.warn(
      `[flushOutbound] account resolve failed for instance ${instanceId}; ` +
        `using default sender. ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

const defaultFlushDeps: FlushDeps = {
  ...defaultDeps,
  findMessageById: findByIdDb,
  findInstanceById: findInstanceByIdDb,
  findCreatorById: findCreatorByIdDb,
  resolveCampaignName: defaultResolveCampaignName,
  acquireSendLock: acquireSendLockDefault,
  releaseSendLock: releaseSendLockDefault,
  resolveInstanceProvider: defaultResolveInstanceProvider,
};

/**
 * Fire-and-forget Gmail thread labeling AFTER a send has completed (Gmail
 * Campaign Labels — §6.4). Best-effort by contract:
 *   - returns void immediately; the caller does NOT await it, so it can never
 *     delay or fail the send,
 *   - no-op unless a campaign name is known, a threadId exists, AND the active
 *     provider implements IThreadLabeler (so it's inert under the mock provider
 *     and for route-driven callers that pass no campaign name),
 *   - swallows every rejection (applyThreadLabel is best-effort and logs its own
 *     failures; the .catch here is belt-and-suspenders against an unexpected
 *     synchronous-in-async throw surfacing as an unhandled rejection).
 *
 * Provider isolation (§6.4): this references ONLY the IThreadLabeler capability
 * and campaignLabelName (a pure string transform) — no Gmail/Nylas concept. All
 * Gmail specifics live inside NylasEmailProvider.applyThreadLabel.
 */
function maybeLabelThreadAsync(
  email: IEmailProvider,
  threadId: string,
  campaignName: string | undefined,
): void {
  if (!campaignName || !threadId || !isThreadLabeler(email)) return;
  const label = campaignLabelName(campaignName);
  // Detached promise: the send has already returned. Any rejection is swallowed
  // (applyThreadLabel logs inside); this .catch guarantees no unhandled rejection.
  void Promise.resolve()
    .then(() => email.applyThreadLabel(threadId, label))
    .catch((err) => {
      console.warn(
        `[labels] apply failed (non-fatal) threadId=${threadId} label=${label}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

// Resolve the thread context ONCE (E5), degrading to empty context on a resolver
// throw (E7) so a threading/DB failure never blocks a contract-forming email.
// Shared by reserve and by flush's context reload.
async function resolveThreadContextSafely(
  threadContext: ThreadContextResolver,
  instanceId: string,
): Promise<ThreadContext> {
  try {
    return await threadContext.resolve(instanceId);
  } catch (err) {
    console.warn(
      `[sendOnce] thread context resolve failed for instance ${instanceId}; ` +
        `sending as a new thread. ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

// Derive the wire subject + EmailSendOptions from a resolved ThreadContext.
// Conditional spread (exactOptionalPropertyTypes): omit replyToExternalId
// entirely when there's no reply target, so options is {} — never
// { replyToExternalId: undefined }. The provider treats an absent key as "open a
// new thread".
function deriveSubjectAndOptions(
  ctx: ThreadContext,
  draftSubject: string,
): { subject: string; options: EmailSendOptions } {
  const subject = buildReplySubject(ctx.canonicalSubject, draftSubject);
  const options: EmailSendOptions = {
    ...(ctx.replyToExternalId ? { replyToExternalId: ctx.replyToExternalId } : {}),
  };
  return { subject, options };
}

// ---------------------------------------------------------------------------
// reserveOutbound — steps 0–1, NEVER sends (§4.1b)
// ---------------------------------------------------------------------------

export interface ReserveResult {
  /** The reserved Message DB row id — STABLE across producer retries (§4.1b), so
   *  the delayed jobId `send|<messageId>` dedupes. */
  messageId: string;
  /** True when a prior attempt already COMPLETED this exact send (P2002 branch a).
   *  The caller MUST skip enqueueing a delayed flush in that case. */
  alreadySent: boolean;
  /** The resolved thread context, carried so the synchronous sendOnce wrapper can
   *  pass it straight into flush and avoid a second resolve. Absent on the P2002
   *  branches (the prior row is already reserved with its subject). */
  threadContext?: ThreadContext;
  /** The threaded subject stored on the reserved row (fresh-reserve only). */
  subject?: string;
  /** On the alreadySent (P2002 case a) branch, the prior row's provider
   *  identifiers, so the synchronous wrapper can surface them without a reload. */
  priorExternalMessageId?: string;
  priorThreadId?: string;
}

/**
 * Reserve an OUTBOUND message row for a later send. Does steps 0–1 of the old
 * sendOnce (resolve thread context, compute the threaded subject, write the row
 * with the idempotencyKey) but NEVER calls email.send() — not even on the P2002
 * reserved-but-unsent branch (that send moves to flushOutbound).
 *
 * P2002 (idempotency-key replay) contract (§4.1b):
 *   (a) prior row has externalMessageId  → { messageId: prior.id, alreadySent: true }
 *       (caller skips enqueue — already delivered)
 *   (b) prior row exists, id NULL         → { messageId: prior.id, alreadySent: false }
 *       (reserved not flushed — caller re-enqueues the SAME jobId → BullMQ dedupes)
 *   (c) unique violation, no row on re-read → safe no-op { messageId:"", alreadySent:true }
 */
export async function reserveOutbound(
  instanceId: string,
  draft: EmailDraft,
  idempotencyKey: string,
  deps: SendOnceDeps = defaultDeps,
): Promise<ReserveResult> {
  // Step 0 — resolve thread context ONCE (E5), degrade to empty on throw (E7).
  const ctx = await resolveThreadContextSafely(deps.threadContext, instanceId);
  const { subject } = deriveSubjectAndOptions(ctx, draft.subject);

  // Step 1 — reserve (with the threaded subject, so the row matches the wire).
  try {
    const reserved = await deps.createMessage({
      instanceId,
      direction: "OUTBOUND",
      subject,
      body: draft.body,
      idempotencyKey,
    });
    return { messageId: reserved.id, alreadySent: false, threadContext: ctx, subject };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A prior attempt already reserved this key. Distinguish (a)/(b)/(c). Unlike
    // the old sendOnce, we NEVER send here — case (b) is delivered by flush.
    const prior = await deps.findMessageByIdempotencyKey(idempotencyKey);
    const priorSent =
      typeof prior?.externalMessageId === "string" && prior.externalMessageId !== "";
    if (prior && priorSent) {
      // (a) already delivered — caller must not enqueue a delayed flush. Carry
      // the prior identifiers so the synchronous wrapper needs no extra reload.
      return {
        messageId: prior.id,
        alreadySent: true,
        priorExternalMessageId: prior.externalMessageId ?? "",
        priorThreadId: prior.threadId ?? "",
      };
    }
    if (prior) {
      // (b) reserved, never flushed — caller re-enqueues the identical delayed
      // jobId (send|<prior.id>); BullMQ dedupes → exactly one delayed job.
      return { messageId: prior.id, alreadySent: false };
    }
    // (c) unique violation but no row on re-read (shouldn't happen) — safe no-op.
    return { messageId: "", alreadySent: true };
  }
}

// ---------------------------------------------------------------------------
// flushOutbound — steps 2–4, under a per-send lock (§4.1a, §4.2a)
// ---------------------------------------------------------------------------

export interface FlushResult {
  messageId: string; // provider external id ("" when skipped)
  threadId: string;
  /** True when this call did NOT send (row already finalized, or another actor
   *  holds the send lock). The delivery either already happened or is another
   *  actor's job. */
  skipped: boolean;
}

/**
 * Flush a reserved OUTBOUND row: provider.send + finalize + label. Receives only
 * the reserved Message.id and rebuilds the full send context (§4.1a).
 *
 * Serialized on a per-send lock (§4.2a): a flush RETRY and the poller safety-net
 * sweep can both target one reserved row, and the unique externalMessageId only
 * dedupes AFTER finalize — so the send→finalize gap is closed by the lock + a
 * post-lock NULL re-check, not by the unique index alone.
 *
 * `preResolved` lets the synchronous sendOnce wrapper hand flush the context
 * reserve already resolved (recipient/campaignName/ctx), avoiding a second thread
 * resolve. The DELAYED path passes nothing → flush reloads everything from the id.
 */
export async function flushOutbound(
  email: IEmailProvider,
  messageId: string,
  deps: FlushDeps = defaultFlushDeps,
  preResolved?: {
    recipient?: EmailRecipient;
    campaignName?: string;
    threadContext?: ThreadContext;
    /** The synchronous sendOnce wrapper's caller-supplied creator, so flush
     *  needn't reload it. Absent on the delayed path → flush loads from the
     *  instance. */
    syncCreator?: Creator;
    /** Out-of-body file attachments (Content Brief PDF). Carried straight from
     *  the caller's draft because the Message row does NOT persist attachments —
     *  so only the SYNCHRONOUS sendOnce path (which has the live draft in hand)
     *  can supply them. The delayed path passes nothing → no attachments, which
     *  is correct: only Content Brief attaches, and it always sends synchronously. */
    attachments?: EmailAttachment[];
  },
): Promise<FlushResult> {
  if (!messageId) return { messageId: "", threadId: "", skipped: true };

  // ── 1. Load the reserved row; short-circuit if already sent ────────────────
  const row = await deps.findMessageById(messageId);
  if (!row) {
    console.warn(`[flushOutbound] message ${messageId} not found — nothing to flush`);
    return { messageId: "", threadId: "", skipped: true };
  }
  if (row.externalMessageId) {
    // Already finalized by a prior flush/sweep. Re-apply the label (cheap,
    // idempotent, self-healing) but do NOT resend.
    maybeLabelThreadAsync(email, row.threadId ?? "", preResolved?.campaignName);
    return { messageId: row.externalMessageId, threadId: row.threadId ?? "", skipped: true };
  }

  const instanceId = row.instanceId;

  // ── PLU-121: select the sending mailbox for this run ──────────────────────
  // Resolve the instance's PINNED connected account into a grant-bound provider.
  // When it resolves, that provider (and its account id) is used for the send,
  // the label, and the Message attribution — so the whole conversation stays on
  // the pinned mailbox. When it doesn't (mock, no accounts, unpinned run), we use
  // the caller-supplied `email` exactly as before.
  const resolvedAccount = deps.resolveInstanceProvider
    ? await deps.resolveInstanceProvider(instanceId)
    : null;
  const activeEmail = resolvedAccount?.provider ?? email;

  // ── 2. Rebuild the send context (§4.1a) ────────────────────────────────────
  // recipient: all in-scope negotiation sends are creator-bound → undefined (the
  // provider addresses the creator). A future brand-outbound delayed send would
  // need the recipient persisted on the row; that's out of scope, flagged here.
  const recipient = preResolved?.recipient;

  // The provider's send() takes a `creator` param even when a recipient overrides
  // addressing. Resolve it in priority order:
  //   1. the synchronous wrapper's caller-supplied creator (no reload), else
  //   2. a minimal object from the explicit recipient (recipient wins addressing), else
  //   3. reload instance → creator from the id (the delayed path).
  // A missing instance/creator on the delayed path means the reservation is
  // orphaned → skip (never send).
  let creator: Creator | null = preResolved?.syncCreator ?? null;
  if (!creator && recipient) {
    creator = { id: "", name: recipient.name, email: recipient.email } as unknown as Creator;
  }
  if (!creator) {
    const instance = await deps.findInstanceById(instanceId);
    if (!instance) {
      console.warn(
        `[flushOutbound] instance ${instanceId} for message ${messageId} not found — skip`,
      );
      return { messageId: "", threadId: "", skipped: true };
    }
    creator = await deps.findCreatorById(instance.creatorId);
    if (!creator) {
      console.warn(
        `[flushOutbound] creator ${instance.creatorId} for message ${messageId} not found — skip`,
      );
      return { messageId: "", threadId: "", skipped: true };
    }
  }

  // reply target: re-resolve unless the wrapper already did (§4.1a step 3). The
  // subject stored on the row was already threaded at reserve time; we only need
  // the reply target here. Degrade to {} on throw (E7 — new-thread send).
  const ctx =
    preResolved?.threadContext ??
    (await resolveThreadContextSafely(deps.threadContext, instanceId));
  const options: EmailSendOptions = {
    ...(ctx.replyToExternalId ? { replyToExternalId: ctx.replyToExternalId } : {}),
  };

  // The wire draft uses the subject STORED on the row (already threaded), so a
  // config/thread change between reserve and flush can't re-thread the subject.
  // Attachments are NOT persisted on the row (no column) — they only exist on the
  // synchronous caller's live draft, carried in via preResolved. Absent on the
  // delayed path, which never attaches. Conditional spread so a draft with no
  // attachments stays byte-identical to before (exactOptionalPropertyTypes).
  const wireDraft: EmailDraft = {
    subject: row.subject ?? draftSubjectFallback(row),
    body: row.body,
    ...(preResolved?.attachments?.length ? { attachments: preResolved.attachments } : {}),
  };

  // campaign name for the label: reload unless pre-resolved (§4.1a step 4).
  const campaignName =
    preResolved?.campaignName ?? (await deps.resolveCampaignName(instanceId));

  // ── 3. Serialize the send→finalize under the per-send lock (§4.2a) ─────────
  const token = await deps.acquireSendLock(messageId);
  if (!token) {
    // Another flush/sweep is mid-send for this row. Skip and let the job retry —
    // NEVER send without the lock.
    console.log(`[flushOutbound] send lock busy — skip ${messageId}`);
    return { messageId: "", threadId: "", skipped: true };
  }
  try {
    // Post-lock NULL re-check: the winner may have finalized between our step-1
    // read and acquiring the lock. Re-read and bail if it's now sent.
    const fresh = await deps.findMessageById(messageId);
    if (!fresh) return { messageId: "", threadId: "", skipped: true };
    if (fresh.externalMessageId) {
      maybeLabelThreadAsync(activeEmail, fresh.threadId ?? "", campaignName);
      return { messageId: fresh.externalMessageId, threadId: fresh.threadId ?? "", skipped: true };
    }

    // Step 2 — send (guarded by the committed reservation + the lock), from the
    // run's pinned mailbox (PLU-121) when one is resolved.
    const { messageId: externalMessageId, threadId } = await activeEmail.send(
      wireDraft,
      creator,
      recipient,
      options,
    );

    // Step 3 — finalize the reserved row with the provider's identifiers.
    // PLU-111 (§4.5 step 2 / §4.8): pass a deferral classifier built from the
    // SENT body so updateMessageSent — which now stamps sentAt AND resolves
    // obligations in one tx — can tell, per open question this send answers,
    // whether the copy ANSWERED it (→ ANSWERED) or DEFERRED it (→ DEFERRED +
    // mint a PLUVUS_COMMITMENT). The body is what actually went on the wire.
    await deps.updateMessageSent(
      messageId,
      {
        externalMessageId,
        threadId,
        // PLU-121: attribute the sent row to the mailbox it went out on.
        ...(resolvedAccount ? { emailAccountId: resolvedAccount.accountId } : {}),
      },
      buildDeferralClassifier(wireDraft.body),
    );

    // Step 4 — label AFTER send + finalize (§6.4): fire-and-forget, best-effort.
    maybeLabelThreadAsync(activeEmail, threadId, campaignName);

    return { messageId: externalMessageId, threadId, skipped: false };
  } finally {
    await deps.releaseSendLock(messageId, token);
  }
}

// Defensive: a reserved OUTBOUND row always has a subject (reserve writes the
// threaded subject). This fallback only fires for a malformed row; use an empty
// subject rather than throw so a stuck reservation can still flush.
function draftSubjectFallback(row: Message): string {
  return row.subject ?? "";
}

// PLU-111 (§4.8): build the DeferralClassifier the DB resolution uses, closing
// over the SENT body. Per open CREATOR_QUESTION this send resolves, it decides
// answered-vs-deferred by scanning the body for a deferral marker near the
// question's topic. Conservative — a false-negative just degrades to ANSWERED
// (today's behavior). The commitment reuses the question's normalizedKey (safe:
// PLUVUS_COMMITMENT is a different `type`, so it never collides with the
// still-open DEFERRED question under the partial-unique index).
function buildDeferralClassifier(sentBody: string): DeferralClassifier {
  return {
    isDeferred: (obligation: ConversationObligation) =>
      isQuestionDeferredBySentBody(obligation, sentBody),
  };
}

// ---------------------------------------------------------------------------
// sendOnce — the synchronous reserve→flush wrapper (unchanged behavior)
// ---------------------------------------------------------------------------

/**
 * Send an outbound email at most once for the given idempotency key.
 *
 * This is the SYNCHRONOUS path used by every non-delayed caller (outreach,
 * follow-up, transactional). It composes reserveOutbound (steps 0–1, no send)
 * with flushOutbound (steps 2–4), reproducing the exact behavior of the old
 * inline sendOnce:
 *   - fresh send: reserve → flush → alreadySent:false
 *   - retry after a completed send: reserve returns alreadySent:true → skip flush
 *     → return the prior identifiers → alreadySent:true, no resend
 *   - BUG-E3 (reserved-but-unsent): reserve returns alreadySent:false with the
 *     prior id → flush re-attempts the send and finalizes the existing row
 *
 * The reserve-resolved thread context is threaded into flush so there is exactly
 * ONE thread resolve per send (no regression from the split).
 */
export async function sendOnce(
  email: IEmailProvider,
  instanceId: string,
  creator: Creator,
  draft: EmailDraft,
  idempotencyKey: string,
  deps: SendOnceDeps = defaultDeps,
  recipient?: EmailRecipient,
  campaignName?: string,
): Promise<SentResult> {
  const flushDeps = toFlushDeps(deps);
  const reserved = await reserveOutbound(instanceId, draft, idempotencyKey, flushDeps);

  if (reserved.alreadySent) {
    // P2002 case (a) or (c): a prior attempt already completed the send. Surface
    // the prior identifiers (carried on the reserve result) and re-apply the
    // label (self-healing) without sending again — identical to the old sendOnce
    // alreadySent branch.
    maybeLabelThreadAsync(email, reserved.priorThreadId ?? "", campaignName);
    return {
      messageId: reserved.priorExternalMessageId ?? "",
      threadId: reserved.priorThreadId ?? "",
      alreadySent: true,
    };
  }

  // Fresh reserve OR reserved-but-unsent (BUG-E3): flush now. Pass the context
  // reserve already resolved so threading is resolved exactly once, and the
  // recipient/campaignName straight through — behavior identical to the old
  // single-call path (recipient overrides addressing; the creator param is only
  // used when recipient is absent, matching the old signature).
  const flush = await flushOutbound(email, reserved.messageId, flushDeps, {
    ...(recipient !== undefined ? { recipient } : {}),
    ...(campaignName !== undefined ? { campaignName } : {}),
    ...(reserved.threadContext !== undefined ? { threadContext: reserved.threadContext } : {}),
    // Address the caller-supplied creator on the synchronous path (the delayed
    // path reloads it from the instance). Carried so flush needn't reload.
    syncCreator: creator,
    // Carry the live draft's attachments (Content Brief PDF) into the flush. The
    // Message row can't persist them, so the synchronous path is the only one that
    // can — it still holds the original draft. Absent → no attachments (unchanged).
    ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
  });

  return {
    messageId: flush.messageId,
    threadId: flush.threadId,
    // A skipped flush here means the row was already finalized by a concurrent
    // sender — surface it as alreadySent (no resend happened on this call).
    alreadySent: flush.skipped,
  };
}

// Fill the flush-only seams (findMessageById, instance/creator loads, campaign
// resolve, send lock) from the defaults when a caller injects a plain
// SendOnceDeps, so flushOutbound always has a complete FlushDeps. A caller that
// injects a full FlushDeps (e.g. a test exercising the split against in-memory
// rows) is used as-is. Real callers pass defaultDeps → defaultFlushDeps.
function toFlushDeps(deps: SendOnceDeps): FlushDeps {
  if (isFlushDeps(deps)) return deps;
  return { ...defaultFlushDeps, ...deps };
}

function isFlushDeps(deps: SendOnceDeps): deps is FlushDeps {
  return (
    typeof (deps as Partial<FlushDeps>).findMessageById === "function" &&
    typeof (deps as Partial<FlushDeps>).acquireSendLock === "function"
  );
}
