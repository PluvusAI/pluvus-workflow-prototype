/**
 * Unit tests for the randomized send delay math + config bounds (§4.5, §8).
 * No DB, no Redis — randomSendDelayMs takes an explicit config so we can probe
 * every window shape deterministically.
 *
 * Run with:  npx tsx src/engine/sendDelay.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  negotiationReplyDelayMs,
  randomSendDelayMs,
  type SendDelayConfig,
} from "./sendDelay.js";

function cfg(over: Partial<SendDelayConfig> = {}): SendDelayConfig {
  return {
    enabled: true,
    minMs: 30_000,
    maxMs: 300_000,
    sweepGraceMs: 120_000,
    maxSweepAgeMs: 86_400_000,
    maxRedrives: 3,
    ...over,
  };
}

test("randomSendDelayMs: always within [MIN, MAX] over many draws", () => {
  const c = cfg({ minMs: 30_000, maxMs: 300_000 });
  for (let i = 0; i < 5_000; i++) {
    const d = randomSendDelayMs(c);
    assert.ok(d >= c.minMs, `draw ${d} below min`);
    assert.ok(d <= c.maxMs, `draw ${d} above max`);
  }
});

test("randomSendDelayMs: inclusive endpoints are reachable", () => {
  // A tiny window makes both endpoints likely across enough draws.
  const c = cfg({ minMs: 0, maxMs: 2 });
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(randomSendDelayMs(c));
  assert.ok(seen.has(0), "min endpoint reachable");
  assert.ok(seen.has(2), "max endpoint reachable");
  // Never outside the window.
  for (const v of seen) assert.ok(v >= 0 && v <= 2);
});

test("randomSendDelayMs: disabled → 0", () => {
  assert.equal(randomSendDelayMs(cfg({ enabled: false })), 0);
});

test("randomSendDelayMs: degenerate window MIN==MAX → 0", () => {
  // max <= min → 0 (send now). Both equal and inverted.
  assert.equal(randomSendDelayMs(cfg({ minMs: 60_000, maxMs: 60_000 })), 0);
});

test("randomSendDelayMs: inverted window MIN>MAX → 0", () => {
  assert.equal(randomSendDelayMs(cfg({ minMs: 300_000, maxMs: 30_000 })), 0);
});

test("randomSendDelayMs: never returns a fractional or NaN value", () => {
  const c = cfg({ minMs: 1_000, maxMs: 9_999 });
  for (let i = 0; i < 1_000; i++) {
    const d = randomSendDelayMs(c);
    assert.ok(Number.isInteger(d), `non-integer draw ${d}`);
    assert.ok(!Number.isNaN(d));
  }
});

test("negotiationReplyDelayMs: campaign minute window overrides global config", () => {
  const campaign = {
    negotiationReplyPacingMinMinutes: 1,
    negotiationReplyPacingMaxMinutes: 5,
  };
  assert.equal(negotiationReplyDelayMs(campaign, cfg(), () => 0), 60_000);
  assert.equal(
    negotiationReplyDelayMs(campaign, cfg(), () => 1 - Number.EPSILON),
    300_000,
  );
});

test("negotiationReplyDelayMs: fixed campaign window is honored", () => {
  assert.equal(
    negotiationReplyDelayMs(
      { negotiationReplyPacingMinMinutes: 4, negotiationReplyPacingMaxMinutes: 4 },
      cfg(),
    ),
    240_000,
  );
});

test("negotiationReplyDelayMs: legacy null campaign retains global delay", () => {
  const legacy = {
    negotiationReplyPacingMinMinutes: null,
    negotiationReplyPacingMaxMinutes: null,
  };
  assert.equal(
    negotiationReplyDelayMs(legacy, cfg({ minMs: 42_000, maxMs: 43_000 }), () => 0),
    42_000,
  );
  assert.equal(negotiationReplyDelayMs(legacy, cfg({ enabled: false })), 0);
});
