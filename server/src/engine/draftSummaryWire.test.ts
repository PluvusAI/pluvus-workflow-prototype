/**
 * PLU-112 — draft-wiring test (Calvin review #5). Proves the summary is DECLARED
 * and FORWARDED on the draft path: a shortened `history` in the extras always
 * travels with its `conversationSummary` in the outgoing DraftRequest, and no
 * summary key appears when none is threaded.
 *
 *   npx tsx src/engine/draftSummaryWire.test.ts
 */

import assert from "node:assert/strict";
import { AgentProviderAdapter } from "./providerFactory.js";
import type { NegotiationProvider } from "../adapters/negotiation/NegotiationProvider.js";
import type { DraftRequest, DraftResponse } from "../adapters/negotiation/types.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import type { Creator } from "../db/schema.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A negotiator that captures the DraftRequest it was handed.
class CapturingNegotiator implements NegotiationProvider {
  last?: DraftRequest;
  async negotiate(): Promise<never> {
    throw new Error("unused");
  }
  async draft(req: DraftRequest): Promise<DraftResponse> {
    this.last = req;
    return { subject: "s", body: "b" };
  }
}

const stubClassifier = {} as ClassificationProvider;
const creator = { name: "Maya" } as Creator;

async function main(): Promise<void> {
  console.log("\ndraftSummaryWire\n");

  await test("shortened history travels WITH its summary in the DraftRequest", async () => {
    const neg = new CapturingNegotiator();
    const adapter = new AgentProviderAdapter(stubClassifier, neg, {});
    await adapter.draftEmail("counter_offer", creator, {}, {
      history: [{ role: "creator", message: "hi", messageId: "m30" }],
      conversationSummary: { text: "the arc so far", version: "summary-v1.0" },
    });
    assert.ok(neg.last, "draft was called");
    assert.deepEqual(neg.last!.conversationSummary, { text: "the arc so far", version: "summary-v1.0" });
    assert.equal(neg.last!.history!.length, 1, "the (shortened) history is forwarded");
  });

  await test("no summary threaded → no conversationSummary key on the request", async () => {
    const neg = new CapturingNegotiator();
    const adapter = new AgentProviderAdapter(stubClassifier, neg, {});
    await adapter.draftEmail("counter_offer", creator, {}, {
      history: [{ role: "creator", message: "hi", messageId: "m1" }],
    });
    assert.ok(neg.last);
    assert.equal(neg.last!.conversationSummary, undefined, "absent when nothing was windowed");
  });

  console.log(`\n${n} passed\n`);
}

await main();
