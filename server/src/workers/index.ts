import type { Worker } from "bullmq";
import { createNodeExecutionWorker } from "./nodeExecutionWorker.js";
import { createInboundEmailWorker } from "./inboundEmailWorker.js";
import { createDelayedSendWorker } from "./delayedSendWorker.js";
import { createCampaignBriefRenderWorker } from "./campaignBriefRenderWorker.js";
import { closeQueues } from "./queues.js";

export {
  enqueueNodeExecution,
  enqueueInboundEmail,
  enqueueDelayedSend,
  enqueueCampaignBriefRender,
  getNodeExecutionQueue,
  getInboundEmailQueue,
  getDelayedSendQueue,
  getCampaignBriefRenderQueue,
} from "./queues.js";
export type {
  NodeExecutionJobData,
  InboundEmailJobData,
  DelayedSendJobData,
  CampaignBriefRenderJobData,
} from "./jobs.js";

// ---------------------------------------------------------------------------
// Worker registry
// ---------------------------------------------------------------------------

let _workers: Worker[] = [];

/**
 * Start all Phase 4 workers and register SIGTERM/SIGINT handlers for graceful
 * shutdown.  Call once at application startup (e.g., from index.ts).
 */
export function startWorkers(): void {
  if (_workers.length > 0) return; // idempotent

  const nodeExec = createNodeExecutionWorker();
  const inboundEmail = createInboundEmailWorker();
  // Randomized Send Delay (§4.5, §6.6): the delayed-send worker is required even
  // when SEND_DELAY_ENABLED=false — disabled is delay-0, still routed through the
  // queue+worker, not a synchronous bypass. Omitting it strands every AI reply.
  const delayedSend = createDelayedSendWorker();
  const campaignBriefRender = createCampaignBriefRenderWorker();
  _workers = [nodeExec, inboundEmail, delayedSend, campaignBriefRender];

  console.log("[workers] node-execution worker started");
  console.log("[workers] inbound-email worker started");
  console.log("[workers] delayed-send worker started");
  console.log("[workers] campaign-brief-render worker started");
}

/**
 * Stop all workers (useful in tests or programmatic teardown).
 */
export async function stopWorkers(): Promise<void> {
  await Promise.all(_workers.map((w) => w.close()));
  await closeQueues();
  _workers = [];
}
