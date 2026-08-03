import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { verifyNylasSignature } from "../providers/nylas/verifySignature.js";
import {
  extractDeliveryTime,
  isFreshDelivery,
  resolveMaxAgeSeconds,
  SeenDeliveryIds,
} from "../providers/nylas/replayGuard.js";
import { findMessagesByThreadId } from "../db/index.js";
import { findEmailAccountByGrantId } from "../db/emailAccounts.js";
import { enqueueInboundEmail } from "../workers/queues.js";

// ---------------------------------------------------------------------------
// Nylas webhook intake — POST/GET /webhooks/nylas
// ---------------------------------------------------------------------------
// Responsibilities (and only these):
//   1. GET  — echo the `challenge` query param so Nylas can verify the endpoint.
//   2. POST — verify the X-Nylas-Signature over the RAW body, extract the
//      inbound message, correlate it to an ExecutionInstance by threadId, and
//      enqueue an inbound-email job. Then ack 200 fast.
//
// What it deliberately does NOT do (preserves existing invariants):
//   - No classification, no state transition. Workers remain the only writers
//     of execution-instance state; the webhook is just a queue producer.
//   - No heavy work before the ack. Nylas requires a 200 within ~10s.
//
// Idempotency for duplicate deliveries is handled downstream:
//   - enqueueInboundEmail builds an accountId + externalMessageId jobId, so
//     BullMQ drops a duplicate enqueue within one grant without cross-grant loss.
//   - inboundEmailWorker re-checks the same account-scoped DB key.
//   - Message has account-scoped + legacy-null unique indexes as the backstop.
//
// IMPORTANT: this router must be mounted with a RAW body parser (express.raw),
// not express.json — signature verification needs the exact bytes Nylas sent.

export interface WebhookDependencies {
  findMessagesByThreadId: typeof findMessagesByThreadId;
  findEmailAccountByGrantId: typeof findEmailAccountByGrantId;
  enqueueInboundEmail: typeof enqueueInboundEmail;
}

const defaultWebhookDependencies: WebhookDependencies = {
  findMessagesByThreadId,
  findEmailAccountByGrantId,
  enqueueInboundEmail,
};

const router = Router();

// BUG-SEC4: per-process replay guard for recently-seen delivery ids. A repeat of
// the same signed delivery within the retention window is rejected as a replay
// (the durable backstop is Message's account-scoped unique key downstream).
const seenDeliveries = new SeenDeliveryIds();

// ── Extracted, normalized inbound message ──────────────────────────────────
interface InboundMessage {
  messageId: string;
  threadId: string | undefined;
  subject: string;
  body: string;
  /** The From: address. Carried for audit/correlation of the inbound reply.
   *  Undefined if unparseable. */
  senderEmail: string | undefined;
}

// Tolerate both snake_case (raw Nylas webhook JSON) and camelCase (SDK-shaped).
function pick<T = unknown>(
  obj: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

/**
 * Pull the fields we need out of a Nylas webhook payload.
 * Returns null if this isn't a message-bearing event we can act on.
 */
function extractInboundMessage(payload: unknown): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object") return null;

  const object = (data as Record<string, unknown>)["object"];
  if (!object || typeof object !== "object") return null;
  const msg = object as Record<string, unknown>;

  const messageId = pick<string>(msg, "id", "message_id", "messageId");
  if (!messageId) return null;

  return {
    messageId,
    threadId: pick<string>(msg, "thread_id", "threadId"),
    subject: pick<string>(msg, "subject") ?? "",
    body: pick<string>(msg, "body", "snippet") ?? "",
    senderEmail: extractFromEmail(msg),
  };
}

// PLU-121 (multi-mailbox): pull the Nylas GRANT id an event belongs to. In v3 the
// grant id sits on the notification envelope (`data.grant_id`) and is echoed on the
// message object; tolerate both shapes + snake/camel case. Undefined when the
// payload carries none (older single-grant deliveries) → the handler falls back to
// an unscoped correlation, exactly as before multi-mailbox.
function extractGrantId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as Record<string, unknown>)["data"];
  if (data && typeof data === "object") {
    const onData = pick<string>(data as Record<string, unknown>, "grant_id", "grantId");
    if (onData) return onData;
    const object = (data as Record<string, unknown>)["object"];
    if (object && typeof object === "object") {
      const onObject = pick<string>(
        object as Record<string, unknown>,
        "grant_id",
        "grantId",
      );
      if (onObject) return onObject;
    }
  }
  return undefined;
}

// Nylas identifies the notification delivery itself on the top-level envelope.
// This is the replay key: `data.object.id` identifies the email message and can
// legitimately appear in more than one notification (and in another grant).
function extractNotificationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return pick<string>(
    payload as Record<string, unknown>,
    "id",
    "notification_id",
    "notificationId",
  );
}

// The From: address in a Nylas message is `from: [{ email, name }]` (or, on some
// SDK/webhook shapes, a bare object). Pull the first email we can find, lowercased
// for a case-insensitive compare downstream. Undefined if absent.
function extractFromEmail(msg: Record<string, unknown>): string | undefined {
  const from = pick<unknown>(msg, "from", "sender");
  const first = Array.isArray(from) ? from[0] : from;
  if (first && typeof first === "object") {
    const email = (first as Record<string, unknown>)["email"];
    if (typeof email === "string" && email.trim()) return email.trim().toLowerCase();
  }
  if (typeof from === "string" && from.trim()) return from.trim().toLowerCase();
  return undefined;
}

// ── GET/HEAD: endpoint verification challenge ──────────────────────────────
// Nylas Dashboard probes the endpoint with HEAD (no challenge param) to confirm
// reachability before saving. It must return 200. It then sends GET ?challenge=xxx
// and expects the exact challenge value as the plain-text body.
router.get("/nylas", (req: Request, res: Response) => {
  const challenge = req.query["challenge"];
  if (typeof challenge === "string") {
    // Plain text, exact value, no quotes — per Nylas verification contract.
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  // No challenge param — this is a plain reachability probe (e.g. HEAD promoted to GET,
  // or Nylas connectivity check). Return 200 with empty body so creation succeeds.
  res.status(200).end();
});

router.head("/nylas", (_req: Request, res: Response) => {
  res.status(200).end();
});

// ── POST: inbound event ────────────────────────────────────────────────────
// Note: the raw parser leaves req.body as a Buffer. We verify over it, then
// JSON.parse it ourselves.
export async function handleNylasWebhook(
  req: Request,
  res: Response,
  dependencies: WebhookDependencies = defaultWebhookDependencies,
): Promise<void> {
  const secret = process.env["NYLAS_WEBHOOK_SECRET"];
  const signature = req.header("x-nylas-signature");

  // req.body is a Buffer when mounted with express.raw(). Be defensive in case
  // a parser changed it.
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

  // ── Verify authenticity ──────────────────────────────────────────────────
  if (!verifyNylasSignature(rawBody, signature, secret)) {
    console.warn("[webhook/nylas] rejected — invalid or missing signature");
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid JSON" });
    return;
  }

  // ── Replay protection — freshness (BUG-SEC4) ─────────────────────────────
  // A valid signature proves authenticity, not freshness. Reject a delivery whose
  // Nylas `time` is older than WEBHOOK_MAX_AGE_SECONDS. Absent `time` fails open
  // here (the seen-id guard below is the backstop). 401 (not 200) so a replay is
  // not silently acked as processed.
  if (!isFreshDelivery(extractDeliveryTime(payload), Date.now(), resolveMaxAgeSeconds())) {
    console.warn("[webhook/nylas] rejected — stale delivery (replay window exceeded)");
    res.status(401).json({ error: "stale delivery" });
    return;
  }

  const inbound = extractInboundMessage(payload);
  if (!inbound) {
    // Not a message event we can act on (e.g. a non-message notification type).
    // Ack so Nylas doesn't retry; nothing to do. Commit its envelope id as a
    // deliberate terminal ignore, so the same signed non-message notification
    // cannot be replayed repeatedly at the edge.
    const ignoredNotificationId = extractNotificationId(payload);
    if (ignoredNotificationId) {
      const ignoredGrantId = extractGrantId(payload);
      const ignoredReplayKey = ignoredGrantId
        ? `${ignoredGrantId.length}|${ignoredGrantId}|${ignoredNotificationId}`
        : ignoredNotificationId;
      if (seenDeliveries.has(ignoredReplayKey)) {
        res.status(200).json({ status: "ignored", reason: "duplicate delivery" });
        return;
      }
      seenDeliveries.add(ignoredReplayKey);
    }
    res.status(200).json({ status: "ignored", reason: "no actionable message" });
    return;
  }

  const grantId = extractGrantId(payload);

  // ── Replay protection — seen delivery id (BUG-SEC4) ──────────────────────
  // Drop a repeat of the same delivery id (a replay, or a Nylas re-delivery of
  // one we already took). Ack 200 (idempotent no-op) so a legitimate Nylas retry
  // isn't triggered into a loop; the enqueue below is skipped. The durable
  // backstop remains the account-scoped Message unique key in the worker.
  // Nylas ids are grant-local, so the in-memory guard must use the same namespace
  // or account B can be dropped just because account A used the same id.
  const notificationId = extractNotificationId(payload) ?? inbound.messageId;
  const replayKey = grantId
    ? `${grantId.length}|${grantId}|${notificationId}`
    : notificationId;
  if (seenDeliveries.has(replayKey)) {
    console.log(
      `[webhook/nylas] dropping duplicate/replayed delivery (msg ${inbound.messageId})`,
    );
    res.status(200).json({ status: "ignored", reason: "duplicate delivery" });
    return;
  }

  // ── Correlate to an instance by threadId ─────────────────────────────────
  // All messages in a conversation share the Nylas thread_id. The outbound
  // send persisted that thread_id on a Message row, so we look it up here.
  if (!inbound.threadId) {
    seenDeliveries.add(replayKey);
    res.status(200).json({ status: "ignored", reason: "no threadId to correlate" });
    return;
  }

  // PLU-121 (multi-mailbox): resolve WHICH connected account this event is for
  // from its grant id, and scope the thread correlation to that account. Nylas
  // thread ids are unique only within a grant, so once several grants are
  // connected an unscoped match could attach grant A's reply to grant B's thread
  // (cross-account leakage). Only a truly grant-less legacy payload degrades to
  // the previous unscoped correlation; an explicit unknown grant is rejected.
  const account = grantId
    ? await dependencies.findEmailAccountByGrantId(grantId)
    : null;

  if (grantId && !account) {
    // A modern delivery identified a grant that this deployment does not know.
    // Do not guess by thread id: the same id may belong to a different connected
    // mailbox. Grant-less payloads below retain the legacy single-mailbox path.
    console.log(
      `[webhook/nylas] unregistered grant ${grantId} — dropping ${inbound.messageId}`,
    );
    seenDeliveries.add(replayKey);
    res.status(200).json({ status: "ignored", reason: "grant not registered" });
    return;
  }

  // Once a grant resolves to an account, correlation MUST remain scoped to that
  // account. Nylas thread ids are grant-local; retrying an unscoped lookup when
  // the scoped one is empty could attach this reply to another mailbox that
  // happens to use the same thread id. The unscoped branch exists only for
  // legacy deliveries that carry no grant id at all.
  //
  // Account status is deliberately not an inbound gate. Disabling/revoking a
  // mailbox stops new sends, but a late reply to an existing conversation is
  // still durable business input and must reach the inbound worker.
  const threadMessages = account
    ? await dependencies.findMessagesByThreadId(inbound.threadId, account.id)
    : await dependencies.findMessagesByThreadId(inbound.threadId);
  if (threadMessages.length === 0) {
    // A reply to a thread we never sent (or not ours). Drop, ack.
    console.log(
      `[webhook/nylas] no instance for thread ${inbound.threadId} — dropping ${inbound.messageId}`,
    );
    seenDeliveries.add(replayKey);
    res.status(200).json({ status: "ignored", reason: "thread not found" });
    return;
  }

  // ── Outbound-echo guard ──────────────────────────────────────────────────
  // Nylas fires a webhook for messages we SEND, not just ones we receive. The
  // sent message shares the thread_id (so it correlates) and carries the SAME
  // externalMessageId we persisted on the outbound Message row. Without this
  // guard the handler treats our own outreach as a creator reply and drives the
  // instance AWAITING_REPLY → REPLY_RECEIVED with no human in the loop (the
  // "phantom reply"). The inbound worker's idempotency check does NOT catch it:
  // it only skips a row whose processedAt is set, and an outbound row is never
  // "processed" as inbound. So drop here, at the source: if this exact
  // externalMessageId is already an OUTBOUND message we own, it's our own echo.
  const ownEcho = threadMessages.find(
    (m) => m.externalMessageId === inbound.messageId && m.direction === "OUTBOUND",
  );
  if (ownEcho) {
    console.log(
      `[webhook/nylas] dropping own outbound echo (msg ${inbound.messageId}, thread ${inbound.threadId})`,
    );
    seenDeliveries.add(replayKey);
    res.status(200).json({ status: "ignored", reason: "outbound echo" });
    return;
  }

  // Every message in the thread belongs to the same instance; take any.
  const instanceId = threadMessages[0]!.instanceId;

  // ── Enqueue (the only side effect) ───────────────────────────────────────
  // No mockIntent — Phase 7 classifies the real reply in the worker.
  await dependencies.enqueueInboundEmail({
    instanceId,
    externalMessageId: inbound.messageId,
    ...(account ? { emailAccountId: account.id } : {}),
    threadId: inbound.threadId,
    subject: inbound.subject,
    body: inbound.body,
    // CRITICAL-1: carry the From: address so the brand-decision handler can verify
    // a decision reply came from the brand, not the creator.
    ...(inbound.senderEmail !== undefined ? { senderEmail: inbound.senderEmail } : {}),
  });

  // Commit the in-memory replay marker only after Redis accepted the durable
  // handoff. A transient DB/Redis throw before this line must remain retryable;
  // marking earlier would poison the next Nylas delivery into a false duplicate.
  seenDeliveries.add(replayKey);

  console.log(
    `[webhook/nylas] enqueued inbound-email for instance ${instanceId} (msg ${inbound.messageId}, thread ${inbound.threadId})`,
  );

  // ── Ack fast ─────────────────────────────────────────────────────────────
  res.status(200).json({ status: "accepted", instanceId });
}

export function wrapNylasWebhookHandler(
  handler: (req: Request, res: Response) => Promise<void> = handleNylasWebhook,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Express 4 does not automatically forward rejected async-handler promises.
    // Send DB/Redis failures to the central error handler so Nylas receives a 5xx
    // and retries; never leave a floating rejection or accidental 200.
    void handler(req, res).catch(next);
  };
}

router.post("/nylas", wrapNylasWebhookHandler());

export default router;
