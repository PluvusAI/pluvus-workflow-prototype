import { and, asc, eq, isNull, gt, lt, sql } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { messages, type Message, type MessageInsert } from "./schema.js";
import {
  resolveObligationsByResolutionMessage,
  type DeferralClassifier,
} from "./conversationObligations.js";

export async function createMessage(data: MessageInsert): Promise<Message> {
  const rows = await db.insert(messages).values(data).returning();
  return rows[0]!;
}

/** Load a single message by its DB row id. Used by the delayed-send flush
 *  (Randomized Send Delay §4.1a), which receives only the reserved Message.id
 *  and must reload subject/body/instance to reconstruct the send context. */
export async function findMessageById(id: string): Promise<Message | null> {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findMessageByExternalId(
  externalMessageId: string,
): Promise<Message | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.externalMessageId, externalMessageId))
    .limit(1);
  return rows[0] ?? null;
}

/** Find an outbound message by its deterministic pre-send idempotency key
 *  (FIX-11). Used to detect a send that already happened before a crash, so the
 *  retry does not double-send. */
export async function findMessageByIdempotencyKey(
  idempotencyKey: string,
): Promise<Message | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] ?? null;
}

/** Finalize a reserved outbound message after the email actually sent (FIX-11):
 *  attach the provider's message/thread id and stamp sentAt.
 *
 *  PLU-111 (§4.5 step 2, THE crux): the SENT gate for conversation obligations.
 *  Stamping sentAt is the exact moment "the answer was actually sent" becomes
 *  true, so we resolve every non-terminal obligation pointing at this message IN
 *  THE SAME TRANSACTION — an ANSWERED/COMPLETED can therefore never accompany a
 *  row without a real sentAt (never on draft generation, invariant #2). Idempotent:
 *  resolveObligationsByResolutionMessage only flips non-terminal rows, so a BullMQ
 *  retry of the flush finds them already terminal and no-ops.
 *
 *  `deferralClassifier` is injected by the flush path (idempotentSend) — it holds
 *  the sent body and the §4.8 deferral vocabulary to decide, per open question,
 *  answered-vs-deferred. Absent → every open question resolves to ANSWERED (still
 *  correct; just without the deferral→commitment refinement). Kept OUT of this DB
 *  module so messages.ts stays free of engine-layer imports. */
export async function updateMessageSent(
  id: string,
  data: { externalMessageId: string; threadId: string },
  deferralClassifier?: DeferralClassifier,
): Promise<Message> {
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(messages)
      .set({
        externalMessageId: data.externalMessageId,
        threadId: data.threadId,
        sentAt: new Date(),
      })
      .where(eq(messages.id, id))
      .returning();
    const row = rows[0];
    if (!row) {
      // Prisma threw P2025 here; a reserved row must exist.
      throw new Error(`Message ${id} not found`);
    }
    // Now that sentAt is set, resolve obligations this send answers/completes
    // (§4.5). In the SAME tx so the two can never diverge (sentAt without the
    // resolution, or vice versa).
    await resolveObligationsByResolutionMessage(id, tx, deferralClassifier);
    return row;
  });
  return updated;
}

/**
 * Mark an INBOUND reply as fully processed (CRITICAL-6). Called once the inbound
 * handler completes (persist → transition → step). The idempotency short-circuit
 * checks processedAt, so a row that was persisted but not processed (a crash
 * mid-handler) is re-processed on retry rather than skipped. Best-effort by
 * externalMessageId; a no-op if the row is already gone.
 */
export async function markMessageProcessed(externalMessageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ processedAt: new Date() })
    .where(eq(messages.externalMessageId, externalMessageId));
}

/** Find all messages in a thread. Used by Nylas webhook handler (Phase 6)
 *  to correlate an inbound reply to the right ExecutionInstance. */
export async function findMessagesByThreadId(threadId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
}

// PLU-81 §8: `client` is injectable (defaults to the top-level `db`) so the
// centralized context builder's I/O shell can be exercised against a test
// transaction if desired. Backward-compatible — every existing caller passes no
// client and reads through the default `db`.
export async function listMessagesByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<Message[]> {
  return client
    .select()
    .from(messages)
    .where(eq(messages.instanceId, instanceId))
    .orderBy(asc(messages.createdAt));
}

// ---------------------------------------------------------------------------
// Randomized Send Delay — safety-net sweep support (§4.4)
// ---------------------------------------------------------------------------

/**
 * Reserved-but-unsent OUTBOUND rows that the poller safety-net sweep should
 * reclaim: a delayed-send job was lost from Redis (flush, eviction, or it
 * dead-lettered) but the reserved row is still `externalMessageId IS NULL`.
 *
 * Bounded on BOTH sides (§4.4):
 *   - createdAt <= now − lowerBoundMs  (MAX window + grace): don't race a legit
 *     delayed job that is still pending.
 *   - createdAt >  now − maxAgeMs      (poison upper bound): a row older than
 *     this is a permanent-failure poison message, left for manual inspection.
 *   - redriveCount < maxRedrives       (poison-loop bound): a row swept a few
 *     times without success is abandoned.
 *
 * NOTE: this does NOT enforce the §4.3a orphan guard (owning turn committed).
 * Under enqueue-after-commit (§4.3a option A) a rolled-back turn never gets a
 * delayed job, so its reserved row would also match here — the CALLER applies
 * the commit guard per candidate (it needs the event log, not a Message-table
 * predicate). Kept out of SQL so the DB layer stays a plain query.
 *
 * `now` is passed in so the caller controls the clock (testable without
 * monkeypatching Date). Rows are ordered oldest-first so the most-stranded are
 * reclaimed first.
 */
export async function listStrandedOutboundReservations(args: {
  now: Date;
  lowerBoundMs: number;
  maxAgeMs: number;
  maxRedrives: number;
  limit?: number;
}): Promise<Message[]> {
  const lowerBound = new Date(args.now.getTime() - args.lowerBoundMs);
  const upperBound = new Date(args.now.getTime() - args.maxAgeMs);
  const q = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.direction, "OUTBOUND"),
        isNull(messages.externalMessageId),
        lt(messages.createdAt, lowerBound),
        gt(messages.createdAt, upperBound),
        lt(messages.redriveCount, args.maxRedrives),
      ),
    )
    .orderBy(asc(messages.createdAt));
  return args.limit ? q.limit(args.limit) : q;
}

/**
 * Atomically bump a reservation's redriveCount and return the new value. Called
 * by the sweep just before (or as it) re-enqueues, so the poison-loop bound
 * advances even across overlapping polls. Uses `redriveCount + 1` in SQL so two
 * concurrent bumps can't both read-then-write the same value.
 */
export async function incrementRedriveCount(id: string): Promise<number> {
  const rows = await db
    .update(messages)
    .set({ redriveCount: sql`${messages.redriveCount} + 1` })
    .where(eq(messages.id, id))
    .returning({ redriveCount: messages.redriveCount });
  return rows[0]?.redriveCount ?? 0;
}
