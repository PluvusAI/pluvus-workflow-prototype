// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: PUBLIC BARREL
// ---------------------------------------------------------------------------
// §6.3 (Calvin review #5): the builder was split into a folder (types / assemble /
// projections / observability / build) so PLU-112 and PLU-113 have small, scoped
// files to edit. This barrel re-exports the EXACT public surface the old
// single-file module exposed, so no import site changes — `negotiation.ts` and the
// tests keep importing `{ buildConversationContext, toDecisionContext, … }` from
// "./conversationContext.js" unchanged.
//
// The seven load-bearing design decisions (settled by three adversarial reviews —
// see .claude/spec/plu-81-.../REVIEW.md):
//
//  1. TWO compiler-separated projection types. DecisionContext carries the secret
//     band (via campaignConstraints); DraftContext STRUCTURALLY lacks any band
//     field — the compiler, not a runtime getter, prevents the draft path from
//     ever reading a bound (§4.2, §4.3). See projections.ts.
//  2. Build-once async + PURE synchronous projections. buildConversationContext
//     (build.ts) does the DB reads + the single /parse-brief HTTP call ONCE per
//     turn; toDecisionContext/toDraftContext (projections.ts) are pure (§4.2, §4.5).
//  3. Pure assembleContext(inputs) core + thin I/O shell + injectable resolveBrief.
//     The pure core (assemble.ts) is the unit-test target (§8).
//  4. Injectable async LOADERS for creatorMemory (PLU-113) and conversationSummary
//     (PLU-112), defaulting to stubs that return undefined (build.ts, §9).
//  5. buildNegotiationRequest stays the final conditional-spread shaper. The builder
//     FEEDS it a PriorNegotiationContext. Byte-identical request shapes are
//     protected by a golden matrix (§5.7, §10).
//  6. Observability = fold a sanitized contextRecord onto the NEGOTIATION_TURN
//     payload (observability.ts). Band VALUES never enter debug/logs (§7).
//  7. Pure-config preconditions + post-decision derivations stay in the executor,
//     OUTSIDE the builder (§5.2, §5.6).
//
// This is a pure REFACTOR: nothing changes behaviorally. The optional slots stay
// undefined until their owning issues (PLU-112/113) land.

// Public types + the typed latest-message consistency error.
export type {
  ContextPurpose,
  CreatorMemoryConflict,
  CreatorMemoryPayload,
  ConversationSummary,
  CampaignConstraints,
  AssembledContext,
  ContextDebug,
  ContextRecord,
  DecisionContext,
  DraftContext,
  ContextDeps,
  AssembleInputs,
} from "./types.js";
export { LatestMessageMismatchError } from "./types.js";

// Pure assemble core (§8).
export { assembleContext } from "./assemble.js";

// Pure projections (§4.2).
export { toDecisionContext, toDraftContext } from "./projections.js";

// Observability record (§7.2).
export { buildContextRecord } from "./observability.js";

// Async I/O shell (§4.2, §4.5).
export { buildConversationContext } from "./build.js";
