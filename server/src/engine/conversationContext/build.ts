// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: ASYNC I/O SHELL (§4.2, §4.5)
// ---------------------------------------------------------------------------
// The one place per turn that does I/O: the DB reads (under a read tx — §6.5), the
// single /parse-brief HTTP call, and the two injectable optional-slot loaders. It
// merges the campaign fallback ONCE (§6.2) and hands everything to the pure
// assembleContext core; callers then project with the PURE toDecisionContext/
// toDraftContext (never calling this builder twice per turn — §4.2 build-once).

import { db, type Db, type DbTx } from "../../db/drizzle.js";
import {
  listMessagesByInstance,
  listEventsByInstance,
  listOpenObligationsByInstance,
} from "../../db/index.js";
import type { Campaign, Creator, ExecutionInstance } from "../../db/schema.js";
import type { NodeSnapshot } from "../types.js";
import { resolveBriefKnowledge } from "../executors/briefKnowledge.js";
import { mergeCampaignFallback } from "../campaignContext.js";
import { assembleContext } from "./assemble.js";
import type {
  AssembledContext,
  ContextDeps,
  ContextPurpose,
  ConversationSummary,
  CreatorMemoryPayload,
} from "./types.js";

/**
 * Build the band-FULL internal read-model for a turn. Does ALL the reads ONCE:
 * the DB reads (messages, events, obligations), the single /parse-brief HTTP call,
 * and the two injectable optional-slot loaders. Returns a rich AssembledContext;
 * the callers project it with the PURE toDecisionContext/toDraftContext — never
 * calling this builder twice per turn (§4.2 build-once).
 *
 * The executor already holds `instance`/`creator`/`campaign`/`node`/`nodeGraph`
 * (from ExecutionContext) — they're passed in to avoid re-reading.
 *
 * `client` is injectable (defaults to `db`) so the reads can enlist a test tx. When
 * it's the default `db`, the three DB reads run under one read transaction for a
 * consistent snapshot (§6.5); when a caller injects its own tx, that tx already
 * provides the single snapshot and no nested tx is opened.
 */
export async function buildConversationContext(
  args: {
    instanceId: string;
    purpose: ContextPurpose;
    nodeGraph: NodeSnapshot[];
    node: NodeSnapshot;
    campaign?: Campaign | null | undefined;
    instance: ExecutionInstance;
    creator: Creator;
    latestMessageId?: string | undefined;
    client?: Db | DbTx | undefined;
  },
  deps: ContextDeps = {},
): Promise<AssembledContext> {
  const client = args.client ?? db;
  const resolveBrief = deps.resolveBrief ?? resolveBriefKnowledge;
  // §9.1 — the default loaders are undefined-returning stubs. The unbuilt PLU-112/
  // 113 flag checks live INSIDE their loader impls, never referenced here — so the
  // builder compiles with those modules absent from the tree.
  const loadCreatorMemory =
    deps.loadCreatorMemory ?? (async (): Promise<CreatorMemoryPayload | undefined> => undefined);
  const loadConversationSummary =
    deps.loadConversationSummary ??
    (async (): Promise<ConversationSummary | undefined> => undefined);

  // §5.1 / §6.2 — merge the node config with the campaign fallback EXACTLY ONCE per
  // turn (node wins). This single merged object feeds BOTH the brief resolver's
  // conflict-detection campaignFields (below) AND assembleContext (threaded in as
  // inputs.mergedConfig), so the merge has one change point and cannot drift.
  const mergedConfig = mergeCampaignFallback(args.node.config, args.campaign);

  // §6.5 — the THREE DB reads (messages, events, obligations) run under ONE read
  // transaction so they observe a single consistent snapshot, rather than three
  // independently-timed snapshots that a concurrent write could interleave. Drizzle
  // runs the callback's statements over one connection inside a real BEGIN/COMMIT;
  // the reads inside still fan out via Promise.all but share that snapshot. The brief
  // /parse HTTP call and the optional PLU-112/113 loaders are NOT database reads on
  // this instance's mutable rows, so they run OUTSIDE the tx (concurrently with it) —
  // keeping the tx short and never holding a DB connection across a network call.
  //
  // When a caller injects its own tx `client` (e.g. a test enlisting the reads in an
  // outer transaction), we do NOT open a nested tx — that client already provides a
  // single snapshot. `db` (the default) is the only value that owns `.transaction`.
  const readRows =
    "transaction" in client
      ? client.transaction(async (tx) =>
          Promise.all([
            listMessagesByInstance(args.instanceId, tx),
            listEventsByInstance(args.instanceId, undefined, tx),
            listOpenObligationsByInstance(args.instanceId, tx),
          ]),
        )
      : Promise.all([
          listMessagesByInstance(args.instanceId, client),
          listEventsByInstance(args.instanceId, undefined, client),
          listOpenObligationsByInstance(args.instanceId, client),
        ]);

  // The reads — ONCE. The 3 DB reads (snapshot-consistent, above) run concurrently
  // with the brief resolve (best-effort, never throws — §5.5) and the optional
  // loaders (default to undefined stubs).
  const [[messages, events, obligationRows], resolvedBrief, creatorMemory, conversationSummary] =
    await Promise.all([
      readRows,
      resolveBrief(args.nodeGraph, {
        usageRights:
          typeof mergedConfig["usageRights"] === "string"
            ? (mergedConfig["usageRights"] as string)
            : undefined,
        exclusivity:
          typeof mergedConfig["exclusivity"] === "string"
            ? (mergedConfig["exclusivity"] as string)
            : undefined,
        paymentTerms:
          typeof mergedConfig["paymentTerms"] === "string"
            ? (mergedConfig["paymentTerms"] as string)
            : undefined,
        attributionWindow:
          typeof mergedConfig["attributionWindow"] === "string"
            ? (mergedConfig["attributionWindow"] as string)
            : undefined,
      }),
      loadCreatorMemory(args.instanceId),
      loadConversationSummary(args.instanceId, args.purpose),
    ]);

  return assembleContext({
    purpose: args.purpose,
    instance: args.instance,
    creator: args.creator,
    campaign: args.campaign,
    node: args.node,
    nodeGraph: args.nodeGraph,
    messages,
    events,
    obligationRows,
    resolvedBrief,
    creatorMemory,
    conversationSummary,
    latestMessageId: args.latestMessageId,
    // §6.2 — thread the single merged object into the pure core (no re-merge).
    mergedConfig,
  });
}
