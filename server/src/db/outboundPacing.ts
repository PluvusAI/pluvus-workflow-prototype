import { and, eq, sql } from "drizzle-orm";
import { db } from "./drizzle.js";
import type { Db, DbTx } from "./drizzle.js";
import {
  campaigns,
  campaignOutreachDays,
  events,
  executionInstances,
  messages,
  workflowVersions,
  workflows,
} from "./schema.js";

/** Set a reservation's first schedule once. Producer retries reuse the original draw. */
export async function ensureMessageScheduledFor(
  messageId: string,
  proposed: Date,
  client: Db | DbTx = db,
): Promise<Date> {
  const rows = await client
    .update(messages)
    .set({ scheduledFor: sql`COALESCE(${messages.scheduledFor}, ${proposed})` })
    .where(eq(messages.id, messageId))
    .returning({ scheduledFor: messages.scheduledFor });
  return rows[0]?.scheduledFor ?? proposed;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function nextUtcDay(dayStart: Date): Date {
  return new Date(dayStart.getTime() + 24 * 60 * 60 * 1_000);
}

function randomSpacingMs(minMinutes: number, maxMinutes: number, random: () => number): number {
  const minMs = minMinutes * 60_000;
  const maxMs = maxMinutes * 60_000;
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}

export type InitialOutreachClaim =
  | { status: "send"; quotaDay: Date | null; nextEligibleAt: Date | null }
  | { status: "defer"; reason: "daily_cap" | "pacing"; retryAt: Date }
  // PLU-153: a CLOSING/ARCHIVED campaign suppresses NEW initial outreach.
  // Terminal-drop (NOT defer/retry): the message stays reserved-unsent.
  | { status: "suppress"; reason: "campaign_closing" };

/**
 * Atomically claim one campaign initial-outreach dispatch.
 *
 * A row lock on Campaign serializes all workers for the same campaign. The
 * Message claim marker makes the operation idempotent across provider retries:
 * once a message consumes a slot, it can retry without incrementing again.
 */
export async function claimInitialOutreachSlot(
  messageId: string,
  now: Date = new Date(),
  random: () => number = Math.random,
  client: Db = db,
): Promise<InitialOutreachClaim> {
  return client.transaction(async (tx): Promise<InitialOutreachClaim> => {
    const contextRows = await tx
      .select({
        message: messages,
        campaign: campaigns,
      })
      .from(messages)
      .innerJoin(executionInstances, eq(messages.instanceId, executionInstances.id))
      .innerJoin(
        workflowVersions,
        eq(executionInstances.workflowVersionId, workflowVersions.id),
      )
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .innerJoin(campaigns, eq(workflows.campaignId, campaigns.id))
      .where(eq(messages.id, messageId))
      .limit(1);
    const context = contextRows[0];

    // Orphaned/legacy workflows have no campaign policy, so preserve the old
    // immediate/unlimited behavior rather than strand the message.
    if (!context) return { status: "send", quotaDay: null, nextEligibleAt: null };

    if (context.message.initialOutreachQuotaDay) {
      return {
        status: "send",
        quotaDay: context.message.initialOutreachQuotaDay,
        nextEligibleAt: null,
      };
    }

    // Serialize all day-row reads/updates for this campaign. This is the race-
    // safety boundary across any number of worker processes. Re-read settings
    // after acquiring it so a just-committed campaign edit applies to this next
    // unclaimed email.
    await tx.execute(
      sql`SELECT "id" FROM "Campaign" WHERE "id" = ${context.campaign.id} FOR UPDATE`,
    );
    const campaignRows = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, context.campaign.id))
      .limit(1);
    const campaign = campaignRows[0];
    if (!campaign) return { status: "send", quotaDay: null, nextEligibleAt: null };

    // PLU-153: suppress NEW initial outreach for a Closing/Archived campaign.
    // This is the single send-time chokepoint — every send path (primary
    // delayed-send job, stranded-sweep re-drive, reconcile-driven ENROLLED
    // re-run) converges here — so blocking the claim blocks the send on all of
    // them. It MUST sit before the all-null-legacy early return below, or a
    // legacy campaign with null pacing/cap would still send. A message that
    // already claimed a slot on a prior day (early-return above) is in-flight,
    // not new intake, and is deliberately left alone.
    if (campaign.status === "CLOSING" || campaign.status === "ARCHIVED") {
      return { status: "suppress", reason: "campaign_closing" };
    }

    const hasCap = campaign.dailyInitialOutreachLimit !== null;
    const hasPacing =
      campaign.outreachPacingMinMinutes !== null &&
      campaign.outreachPacingMaxMinutes !== null;

    // All-null is the legacy policy: do not write quota state and send now.
    if (!hasCap && !hasPacing) {
      return { status: "send", quotaDay: null, nextEligibleAt: null };
    }

    // Re-read the message after waiting for the campaign lock. Another worker
    // may have claimed this exact message while we were blocked.
    const freshMessages = await tx
      .select({ quotaDay: messages.initialOutreachQuotaDay })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (freshMessages[0]?.quotaDay) {
      return { status: "send", quotaDay: freshMessages[0].quotaDay, nextEligibleAt: null };
    }

    const dayStart = utcDayStart(now);
    const dayRows = await tx
      .select()
      .from(campaignOutreachDays)
      .where(
        and(
          eq(campaignOutreachDays.campaignId, campaign.id),
          eq(campaignOutreachDays.dayStart, dayStart),
        ),
      )
      .limit(1);
    const day = dayRows[0];
    const startedCount = day?.startedCount ?? 0;

    if (hasCap && startedCount >= campaign.dailyInitialOutreachLimit!) {
      const retryAt = nextUtcDay(dayStart);
      await tx.update(messages).set({ scheduledFor: retryAt }).where(eq(messages.id, messageId));
      return { status: "defer", reason: "daily_cap", retryAt };
    }

    if (hasPacing && day?.nextEligibleAt && day.nextEligibleAt.getTime() > now.getTime()) {
      await tx
        .update(messages)
        .set({ scheduledFor: day.nextEligibleAt })
        .where(eq(messages.id, messageId));
      return { status: "defer", reason: "pacing", retryAt: day.nextEligibleAt };
    }

    const nextEligibleAt = hasPacing
      ? new Date(
          now.getTime() +
            randomSpacingMs(
              campaign.outreachPacingMinMinutes!,
              campaign.outreachPacingMaxMinutes!,
              random,
            ),
        )
      : null;

    if (day) {
      await tx
        .update(campaignOutreachDays)
        .set({
          startedCount: sql`${campaignOutreachDays.startedCount} + 1`,
          nextEligibleAt,
        })
        .where(eq(campaignOutreachDays.id, day.id));
    } else {
      await tx.insert(campaignOutreachDays).values({
        campaignId: campaign.id,
        dayStart,
        startedCount: 1,
        nextEligibleAt,
      });
    }

    await tx
      .update(messages)
      .set({ initialOutreachQuotaDay: dayStart, scheduledFor: now })
      .where(eq(messages.id, messageId));

    return { status: "send", quotaDay: dayStart, nextEligibleAt };
  });
}

export type CompleteQueuedOutreachResult =
  | "completed"
  | "already_completed"
  | "not_sent"
  | "not_queued";

/**
 * Move OUTREACH_QUEUED → OUTREACH_SENT only after Message.sentAt exists.
 * The state write and audit event are atomic; retries are harmless.
 */
export async function completeQueuedInitialOutreach(
  messageId: string,
  now: Date = new Date(),
  client: Db = db,
): Promise<CompleteQueuedOutreachResult> {
  return client.transaction(async (tx): Promise<CompleteQueuedOutreachResult> => {
    const rows = await tx
      .select({ message: messages, instance: executionInstances })
      .from(messages)
      .innerJoin(executionInstances, eq(messages.instanceId, executionInstances.id))
      .where(eq(messages.id, messageId))
      .limit(1);
    const row = rows[0];
    if (!row?.message.sentAt) return "not_sent";
    if (row.instance.currentState === "OUTREACH_SENT") return "already_completed";
    if (row.instance.currentState !== "OUTREACH_QUEUED") return "not_queued";

    const updated = await tx
      .update(executionInstances)
      .set({
        currentState: "OUTREACH_SENT",
        version: sql`${executionInstances.version} + 1`,
      })
      .where(
        and(
          eq(executionInstances.id, row.instance.id),
          eq(executionInstances.currentState, "OUTREACH_QUEUED"),
          eq(executionInstances.version, row.instance.version),
        ),
      )
      .returning({ id: executionInstances.id });
    if (!updated[0]) return "not_queued";

    await tx.insert(events).values({
      instanceId: row.instance.id,
      type: "STATE_TRANSITION",
      nodeId: row.instance.currentNodeId,
      payload: {
        from: "OUTREACH_QUEUED",
        to: "OUTREACH_SENT",
        source: "delayed-send-worker",
        worker: "delayed-send",
        messageId,
      },
      occurredAt: now,
    });
    return "completed";
  });
}
