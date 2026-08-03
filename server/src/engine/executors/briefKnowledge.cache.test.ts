/**
 * PLU-82 review §3 (Calvin) — parser-version + parse-mode cache invalidation.
 * Run with:
 *   node --import tsx --test src/engine/executors/briefKnowledge.cache.test.ts
 *
 * Regression target: the read path used to scan for ANY cached entry whose key
 * began with the file ref (`${ref}::…`) and return the first match, so a result
 * cached under parser version A kept being served after the parser bumped to B.
 * The read now keys on expectedParserVersion() + expectedBriefParseMode(), known
 * BEFORE the parse, so a version bump or mode toggle invalidates stale entries.
 *
 * Also covers §4 through the REAL resolve path (not just the pure projection):
 * a blank/malformed parse must not survive as usable content.
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  resolveBriefKnowledge,
  deriveBriefAvailability,
  expectedBriefParseMode,
  expectedParserVersion,
  _clearBriefCache,
  type BriefParseMode,
  type BriefResolveDeps,
} from "./briefKnowledge.js";
import type { NodeSnapshot } from "../types.js";

// A minimal graph carrying a CONTENT_BRIEF node with a file ref, so the resolver
// has something to key the cache on.
const REF = "upload-abc-123";
const graph: NodeSnapshot[] = [
  { id: "n1", type: "CONTENT_BRIEF", config: { briefFileRef: REF } } as unknown as NodeSnapshot,
];

// A deps double that returns a parse payload stamped with a chosen version and
// counts how many times the parser was actually invoked (cache hit ⇒ 0 new calls).
function depsReturning(payload: Record<string, unknown>): {
  deps: BriefResolveDeps;
  calls: () => number;
  modes: () => BriefParseMode[];
} {
  let calls = 0;
  const modes: BriefParseMode[] = [];
  const deps: BriefResolveDeps = {
    readFile: async () => Buffer.from("%PDF-1.4 fake"),
    parse: async (_pdfBase64, parseMode) => {
      calls += 1;
      modes.push(parseMode);
      return payload;
    },
  };
  return { deps, calls: () => calls, modes: () => modes };
}

let savedVersion: string | undefined;
let savedStructuredFlag: string | undefined;
beforeEach(() => {
  savedVersion = process.env["BRIEF_PARSER_VERSION"];
  savedStructuredFlag = process.env["STRUCTURED_BRIEF_PARSING_ENABLED"];
  delete process.env["STRUCTURED_BRIEF_PARSING_ENABLED"];
  _clearBriefCache();
});
afterEach(() => {
  if (savedVersion === undefined) delete process.env["BRIEF_PARSER_VERSION"];
  else process.env["BRIEF_PARSER_VERSION"] = savedVersion;
  if (savedStructuredFlag === undefined) delete process.env["STRUCTURED_BRIEF_PARSING_ENABLED"];
  else process.env["STRUCTURED_BRIEF_PARSING_ENABLED"] = savedStructuredFlag;
  _clearBriefCache();
});

test("expectedParserVersion honors the env override and falls back to the default", () => {
  delete process.env["BRIEF_PARSER_VERSION"];
  assert.equal(expectedParserVersion(), "brief-parser-v1.1");
  process.env["BRIEF_PARSER_VERSION"] = "brief-parser-v9.9";
  assert.equal(expectedParserVersion(), "brief-parser-v9.9");
});

test("expectedBriefParseMode maps the shared flag to an explicit request capability", () => {
  delete process.env["STRUCTURED_BRIEF_PARSING_ENABLED"];
  assert.equal(expectedBriefParseMode(), "flat");
  process.env["STRUCTURED_BRIEF_PARSING_ENABLED"] = " true ";
  assert.equal(expectedBriefParseMode(), "structured");
});

test("a version-A result is NOT reused after the expected version bumps to B (§3)", async () => {
  // 1. Parse and cache with parser version A.
  process.env["BRIEF_PARSER_VERSION"] = "A";
  const a = depsReturning({ status: "ok", text: "brief A", parserVersion: "A" });
  const first = await resolveBriefKnowledge(graph, undefined, a.deps);
  assert.equal(first.flatText, "brief A");
  assert.equal(a.calls(), 1, "first turn parses");

  // Same version → cache HIT, parser not called again.
  const cached = await resolveBriefKnowledge(graph, undefined, a.deps);
  assert.equal(cached.flatText, "brief A");
  assert.equal(a.calls(), 1, "repeat turn at same version must hit the cache");

  // 2. Change the expected parser version to B.
  process.env["BRIEF_PARSER_VERSION"] = "B";
  const b = depsReturning({ status: "ok", text: "brief B", parserVersion: "B" });

  // 3. Verify the version-A result is NOT reused — a fresh parse runs and the new
  //    (version-B) content is returned.
  const afterBump = await resolveBriefKnowledge(graph, undefined, b.deps);
  assert.equal(b.calls(), 1, "a version bump must force a re-parse, not reuse version A");
  assert.equal(afterBump.flatText, "brief B", "must serve the version-B content, not stale A");
});

test("an agent that returns a version other than expected does not get served from cache", async () => {
  // Operator expects v1.1 but a stale peer/agent returns v1.0 — the entry caches
  // under v1.0 (provenance) but the v1.1 read must miss and re-parse.
  process.env["BRIEF_PARSER_VERSION"] = "brief-parser-v1.1";
  const stale = depsReturning({ status: "ok", text: "old", parserVersion: "brief-parser-v1.0" });
  await resolveBriefKnowledge(graph, undefined, stale.deps);
  assert.equal(stale.calls(), 1);

  // Next turn still expects v1.1 → the v1.0 entry is not a match → re-parse.
  await resolveBriefKnowledge(graph, undefined, stale.deps);
  assert.equal(stale.calls(), 2, "an off-version cache entry must never satisfy the expected-version read");
});

test("a parse_failed is not cached (a transient failure never poisons the brief)", async () => {
  process.env["BRIEF_PARSER_VERSION"] = "A";
  const failing = depsReturning({ status: "parse_failed", text: "", parserVersion: "A" });
  const r1 = await resolveBriefKnowledge(graph, undefined, failing.deps);
  assert.equal(r1.status, "parse_failed");
  const r2 = await resolveBriefKnowledge(graph, undefined, failing.deps);
  assert.equal(failing.calls(), 2, "a parse_failed must be retried next turn, not cached");
  assert.equal(r2.status, "parse_failed");
});

test("§4 — a blank/malformed parse resolves to PARSE_FAILED, never AVAILABLE", async () => {
  // Missing status + blank text + no sections: the resolver normalizes the status
  // for legacy compatibility, then promotes an unusable response to parse_failed
  // before caching so the next turn gets a clean retry.
  process.env["BRIEF_PARSER_VERSION"] = "A";
  const blank = depsReturning({ text: "", parserVersion: "A" }); // no `status` key
  const resolved = await resolveBriefKnowledge(graph, undefined, blank.deps);
  assert.equal(resolved.status, "parse_failed");
  const availability = deriveBriefAvailability(resolved, []);
  assert.notEqual(availability.status, "AVAILABLE", "a blank/malformed parse must not read AVAILABLE");
  assert.equal(availability.status, "PARSE_FAILED");
  await resolveBriefKnowledge(graph, undefined, blank.deps);
  assert.equal(blank.calls(), 2, "a malformed blank response must not poison the cache");
});

test("flat and structured results use separate cache identities when the flag toggles", async () => {
  process.env["BRIEF_PARSER_VERSION"] = "A";
  delete process.env["STRUCTURED_BRIEF_PARSING_ENABLED"];
  const flat = depsReturning({
    status: "ok",
    text: "flat result",
    parserVersion: "A",
    parseMode: "flat",
  });
  const flatResult = await resolveBriefKnowledge(graph, undefined, flat.deps);
  assert.equal(flatResult.flatText, "flat result");
  assert.deepEqual(flat.modes(), ["flat"], "server must explicitly request flat mode");

  process.env["STRUCTURED_BRIEF_PARSING_ENABLED"] = "true";
  const structured = depsReturning({
    status: "ok",
    text: "structured result",
    parserVersion: "A",
    parseMode: "structured",
    sections: { usageRights: { type: "usageRights", text: "90 days" } },
  });
  const structuredResult = await resolveBriefKnowledge(graph, undefined, structured.deps);
  assert.equal(structuredResult.flatText, "structured result");
  assert.deepEqual(
    structured.modes(),
    ["structured"],
    "mode toggle must miss the flat cache and request a structured parse",
  );

  delete process.env["STRUCTURED_BRIEF_PARSING_ENABLED"];
  const flatAgain = await resolveBriefKnowledge(graph, undefined, flat.deps);
  assert.equal(flatAgain.flatText, "flat result");
  assert.equal(flat.calls(), 1, "switching back may reuse only the matching flat-mode cache");
});

test("a legacy text-only agent response is inferred as flat and never becomes false PARTIAL", async () => {
  process.env["BRIEF_PARSER_VERSION"] = "A";
  process.env["STRUCTURED_BRIEF_PARSING_ENABLED"] = "true";
  const legacy = depsReturning({ status: "ok", text: "legacy flat text", parserVersion: "A" });
  const resolved = await resolveBriefKnowledge(graph, undefined, legacy.deps);
  assert.equal(resolved.parseMode, "flat");
  assert.equal(deriveBriefAvailability(resolved, ["usageRights"]).status, "AVAILABLE");
});
