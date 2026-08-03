import { randomUUID } from "crypto";
import type { RequestHandler } from "express";
import { Router } from "express";
import {
  getNodeExecutionQueue,
  getInboundEmailQueue,
  enqueueNodeExecution,
  enqueueInboundEmail,
} from "../workers/queues.js";
import { findInstanceById } from "../db/index.js";

const router = Router();

// ---------------------------------------------------------------------------
// W-4: gate the injection (mutation) endpoints.
// ---------------------------------------------------------------------------
// The POST routes below enqueue REAL node-execution / inbound-email jobs that
// drive the live state machine — including `mockIntent`, which can fabricate a
// creator's "acceptance" and forge money-path inputs. Unlike the read-only GET
// diagnostics on this router, these must NOT be reachable on an exposed prod
// port. They are compiled to a 404 unless the process is running tests OR an
// operator has explicitly opted in with ENABLE_QUEUE_INJECTION=true (for a
// trusted local dev / harness box). A 404 (not 403) keeps the surface
// undiscoverable in production.
// Pure so it can be unit-tested without touching a live process.env / HTTP.
export function queueInjectionAllowed(
  nodeEnv: string | undefined,
  enableFlag: string | undefined,
): boolean {
  if ((nodeEnv ?? "").toLowerCase() === "test") return true;
  return (enableFlag ?? "").toLowerCase() === "true";
}

function queueInjectionEnabled(): boolean {
  return queueInjectionAllowed(
    process.env["NODE_ENV"],
    process.env["ENABLE_QUEUE_INJECTION"],
  );
}

const requireInjectionEnabled: RequestHandler = (_req, res, next) => {
  if (!queueInjectionEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

// ---------------------------------------------------------------------------
// GET /queues/health
// ---------------------------------------------------------------------------
// Returns live counts for both queues: waiting, active, completed, failed,
// delayed.  Useful for at-a-glance operational status.

router.get("/health", async (_req, res) => {
  try {
    const [nodeQ, inboundQ] = [getNodeExecutionQueue(), getInboundEmailQueue()];

    const [nodeCounts, inboundCounts] = await Promise.all([
      nodeQ.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
      inboundQ.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
    ]);

    res.json({
      status: "ok",
      queues: {
        "node-execution": nodeCounts,
        "inbound-email": inboundCounts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ status: "error", message });
  }
});

// ---------------------------------------------------------------------------
// GET /queues/jobs
// ---------------------------------------------------------------------------
// Returns the most recent waiting + active + failed jobs for diagnostics.

router.get("/jobs", async (req, res) => {
  // Clamp to [1, 100]: limit-1 is passed as the Redis end index, so 0 would
  // become -1 which returns all jobs (Redis LRANGE 0 -1 semantics).
  const limit = Math.max(1, Math.min(Number(req.query["limit"] ?? 20), 100));

  try {
    const [nodeQ, inboundQ] = [getNodeExecutionQueue(), getInboundEmailQueue()];

    const [nodeWaiting, nodeActive, nodeFailed, inboundWaiting, inboundActive, inboundFailed] =
      await Promise.all([
        nodeQ.getWaiting(0, limit - 1),
        nodeQ.getActive(0, limit - 1),
        nodeQ.getFailed(0, limit - 1),
        inboundQ.getWaiting(0, limit - 1),
        inboundQ.getActive(0, limit - 1),
        inboundQ.getFailed(0, limit - 1),
      ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialize = (jobs: any[]) =>
      jobs.map((j) => ({
        id: j.id as string | undefined,
        name: j.name as string,
        data: j.data as unknown,
        attemptsMade: j.attemptsMade as number,
        processedOn: j.processedOn as number | undefined,
        finishedOn: j.finishedOn as number | undefined,
        failedReason: j.failedReason as string | undefined,
        timestamp: j.timestamp as number,
      }));

    res.json({
      "node-execution": {
        waiting: serialize(nodeWaiting),
        active: serialize(nodeActive),
        failed: serialize(nodeFailed),
      },
      "inbound-email": {
        waiting: serialize(inboundWaiting),
        active: serialize(inboundActive),
        failed: serialize(inboundFailed),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ status: "error", message });
  }
});

// ---------------------------------------------------------------------------
// POST /queues/node-execution
// ---------------------------------------------------------------------------
// Manually enqueue a node-execution job (for testing / harness use).
//
// Body: { instanceId: string, triggerRef?: string }
// W-4: injection endpoint — gated to test / opt-in dev (see requireInjectionEnabled).

router.post("/node-execution", requireInjectionEnabled, async (req, res) => {
  const { instanceId, triggerRef } = req.body as {
    instanceId?: string;
    triggerRef?: string;
  };

  if (!instanceId) {
    res.status(400).json({ error: "instanceId is required" });
    return;
  }

  const instance = await findInstanceById(instanceId);
  if (!instance) {
    res.status(404).json({ error: `Instance not found: ${instanceId}` });
    return;
  }

  const ref = triggerRef ?? randomUUID();

  await enqueueNodeExecution({
    instanceId,
    expectedState: instance.currentState,
    triggerRef: ref,
  });

  res.status(202).json({
    queued: true,
    instanceId,
    expectedState: instance.currentState,
    triggerRef: ref,
  });
});

// ---------------------------------------------------------------------------
// POST /queues/inbound-email
// ---------------------------------------------------------------------------
// Inject a mocked inbound email event (Phase 4 / 5 testing).
//
// Body: {
//   instanceId: string,
//   subject?: string,
//   body?: string,
//   mockIntent?: "POSITIVE" | "NEGATIVE" | "QUESTION" | "OPT_OUT",
//   threadId?: string,
// }
// W-4: injection endpoint — this one can force a `mockIntent` (a fabricated
// creator acceptance), so it is the highest-risk surface. Gated to test / opt-in
// dev (see requireInjectionEnabled).

router.post("/inbound-email", requireInjectionEnabled, async (req, res) => {
  const {
    instanceId,
    subject = "Re: Collaboration opportunity",
    body = "Yes, I'm interested!",
    mockIntent,
    threadId,
  } = req.body as {
    instanceId?: string;
    subject?: string;
    body?: string;
    mockIntent?: string;
    threadId?: string;
  };

  if (!instanceId) {
    res.status(400).json({ error: "instanceId is required" });
    return;
  }

  const instance = await findInstanceById(instanceId);
  if (!instance) {
    res.status(404).json({ error: `Instance not found: ${instanceId}` });
    return;
  }

  const externalMessageId = `mock-inbound-${randomUUID()}`;
  const resolvedThreadId = threadId ?? `mock-thread-${instance.creatorId}`;

  await enqueueInboundEmail({
    instanceId,
    externalMessageId,
    ...(instance.emailAccountId ? { emailAccountId: instance.emailAccountId } : {}),
    threadId: resolvedThreadId,
    subject,
    body,
    // Only include mockIntent when actually provided — under exactOptionalProperty
    // Types an explicit `undefined` is not assignable to the optional string field.
    ...(mockIntent !== undefined ? { mockIntent } : {}),
  });

  res.status(202).json({
    queued: true,
    instanceId,
    externalMessageId,
    mockIntent,
  });
});

export default router;
