// ---------------------------------------------------------------------------
// PLU-81 — Centralized AI conversation-context builder: COMPAT RE-EXPORT
// ---------------------------------------------------------------------------
// §6.3 (Calvin review #5): the 788-line module was split into the
// `conversationContext/` folder (types / assemble / projections / observability /
// build + an index barrel). Under NodeNext resolution a `./conversationContext.js`
// specifier resolves to THIS file, not the folder's index — so this thin re-export
// keeps every existing import site (`negotiation.ts`, the golden + unit tests)
// resolving unchanged, exactly as before the split. The public surface lives in
// ./conversationContext/index.ts; this file only forwards it.
export * from "./conversationContext/index.js";
