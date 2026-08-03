// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: ASYNC I/O SHELL (§4.2, §4.5)
// ---------------------------------------------------------------------------
// The one place per turn that does I/O: the DB reads (under a read tx — §6.5), the
// single /parse-brief HTTP call, and the two injectable optional-slot loaders. It
// receives the executor's one campaign-fallback merge (§6.2) and hands everything
// to the pure assembleContext core; callers then project with the PURE toDecisionContext/
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
 * `mergedConfig` is the executor's single mergeCampaignFallback result, so
 * preconditions, brief conflict detection, and both projections share one object.
 *
 * `client` is injectable for tests or callers already inside a transaction. When
 * omitted, the three DB reads run in one REPEATABLE READ, READ ONLY transaction
 * for a consistent snapshot (§6.5). A supplied client is used directly: its caller
 * owns any surrounding transaction and we never create a nested savepoint.
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
    mergedConfig: Record<string, unknown>;
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

  // §5.1 / §6.2 — the executor merged node + campaign EXACTLY ONCE before its
  // pure-config preconditions. Reuse that same object for brief conflict detection
  // and both projections; the builder must not introduce a second merge point.
  const mergedConfig = args.mergedConfig;

  // §6.5 — the THREE DB reads (messages, events, obligations) run under ONE read
  // REPEATABLE READ, READ ONLY transaction so they observe one transaction snapshot,
  // rather than three independently-timed READ COMMITTED statement snapshots that a
  // concurrent write could interleave. The reads still fan out via Promise.all but
  // share that snapshot. The brief
  // /parse HTTP call and the optional PLU-112/113 loaders are NOT database reads on
  // this instance's mutable rows, so they run OUTSIDE the tx (concurrently with it) —
  // keeping the tx short and never holding a DB connection across a network call.
  //
  // When a caller supplies `client`, use it directly. DbTx also exposes
  // `.transaction()` (nested savepoints), so capability detection would
  // accidentally nest; presence of args.client is the authoritative distinction.
  const readRows = args.client
    ? Promise.all([
        listMessagesByInstance(args.instanceId, client),
        listEventsByInstance(args.instanceId, undefined, client),
        listOpenObligationsByInstance(args.instanceId, client),
      ])
    : db.transaction(
        async (tx) =>
          Promise.all([
            listMessagesByInstance(args.instanceId, tx),
            listEventsByInstance(args.instanceId, undefined, tx),
            listOpenObligationsByInstance(args.instanceId, tx),
          ]),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );

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
