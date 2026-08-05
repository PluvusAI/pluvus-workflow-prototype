/**
 * Unit tests for the outbound output guard (FIX-4).
 * Pure function — run with:  npx tsx src/engine/guards/outputGuard.test.ts
 */

import assert from "node:assert/strict";
import { scanOutboundDraft, guardConstraintsFromConfig } from "./outputGuard.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\noutputGuard.scanOutboundDraft\n");

const C = { floor: 500, ceiling: 2000 };

test("clean draft passes", () => {
  const r = scanOutboundDraft(
    { subject: "Partnership", body: "We'd love to work with you on this campaign." },
    C,
  );
  assert.equal(r.ok, true);
});

test("blocks when floor number leaks (bare)", () => {
  const r = scanOutboundDraft({ body: "Our minimum is 500 for this." }, C);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.hits[0]!.kind, "floor");
});

test("blocks when ceiling leaks with $ and comma", () => {
  const r = scanOutboundDraft({ body: "We can go up to $2,000 max." }, C);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "ceiling"));
});

test("blocks ceiling written plainly as 2000", () => {
  const r = scanOutboundDraft({ body: "absolute max 2000 dollars" }, C);
  assert.equal(r.ok, false);
});

test("does NOT match a bound as a substring of a larger number", () => {
  // 500 must not match inside 2500; 2000 must not match inside 12000.
  const r = scanOutboundDraft({ body: "How about 2500? Or even 12000 views." }, C);
  assert.equal(r.ok, true);
});

test("allowlisted rate equal to a bound is not blocked", () => {
  // We intentionally present 500 this turn → not a leak.
  const r = scanOutboundDraft({ body: "Our offer is $500." }, { ...C, allowedRate: 500 });
  assert.equal(r.ok, true);
});

test("a different number than the allowlisted one still blocks", () => {
  const r = scanOutboundDraft({ body: "Offer $600, but our max is 2000." }, { ...C, allowedRate: 600 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "ceiling"));
});

test("creator's ask equal to a bound (in allowedRates) is not blocked", () => {
  // Ceiling is 2000 and the creator asked for 2000; echoing their number back
  // is not a leak — they said it first. We counter at 1800 (allowedRate).
  const r = scanOutboundDraft(
    { body: "We hear you'd like $2,000 — we can offer $1,800 for this collaboration." },
    { ...C, allowedRate: 1800, allowedRates: [2000] },
  );
  assert.equal(r.ok, true);
});

test("a bound the creator never mentioned still blocks even with allowedRates set", () => {
  // The floor (500) appears but was NOT the creator's ask (their ask was 2000).
  const r = scanOutboundDraft(
    { body: "Our floor is 500 internally, but you asked $2000." },
    { ...C, allowedRate: 1800, allowedRates: [2000] },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "floor"));
});

test("allowedRate and allowedRates are both honored", () => {
  // floor 500 == allowedRate, ceiling 2000 == an allowedRates entry → both pass.
  const r = scanOutboundDraft(
    { body: "Offer $500. You mentioned $2000." },
    { ...C, allowedRate: 500, allowedRates: [2000] },
  );
  assert.equal(r.ok, true);
});

test("scans subject too", () => {
  const r = scanOutboundDraft({ subject: "Re: 500 floor", body: "clean body" }, C);
  assert.equal(r.ok, false);
});

test("flags configured internal terms case-insensitively", () => {
  const r = scanOutboundDraft(
    { body: "This is our INTERNAL MAX, do not share." },
    { internalTerms: ["internal max"] },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.hits[0]!.kind, "term");
});

test("matches floor with decimals (500.00)", () => {
  const r = scanOutboundDraft({ body: "exactly 500.00 please" }, C);
  assert.equal(r.ok, false);
});

test("no constraints → always ok", () => {
  const r = scanOutboundDraft({ body: "anything 500 2000 goes" }, {});
  assert.equal(r.ok, true);
});

console.log("\ncommission guard (non-negotiable %)\n");

const CC = { commissionRate: 10 };

test("the configured commission % passes", () => {
  const r = scanOutboundDraft(
    { body: "This is a hybrid partnership with a 10% commission on sales you drive." },
    CC,
  );
  assert.equal(r.ok, true);
});

test("a DIFFERENT commission % is blocked", () => {
  const r = scanOutboundDraft(
    { body: "Happy to bump you to a 15% commission on all sales." },
    CC,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "commission" && h.value.startsWith("15%")));
});

test("commission % written as 'percent' is caught", () => {
  const r = scanOutboundDraft({ body: "We can offer 20 percent commission this time." }, CC);
  assert.equal(r.ok, false);
});

test("an unrelated percentage is NOT a commission hit", () => {
  // 30-day usage rights / 'grew 15%' must not trip the commission check.
  const r = scanOutboundDraft(
    { body: "You keep the 10% commission, with 30-day usage rights; your reach grew 40% last year." },
    CC,
  );
  assert.equal(r.ok, true);
});

test("commission check skipped when no rate configured", () => {
  const r = scanOutboundDraft({ body: "We can do a 25% commission structure." }, {});
  assert.equal(r.ok, true);
});

test("decimal commission % matches the configured decimal", () => {
  const r = scanOutboundDraft(
    { body: "a 12.5% commission on the sales you drive" },
    { commissionRate: 12.5 },
  );
  assert.equal(r.ok, true);
});

console.log("\nguardConstraintsFromConfig\n");

test("extracts floor/ceiling rates from node config", () => {
  const c = guardConstraintsFromConfig({
    termFloor: { rate: 500 },
    termCeiling: { rate: 2000 },
  });
  assert.equal(c.floor, 500);
  assert.equal(c.ceiling, 2000);
});

test("threads allowedRate and internalTerms", () => {
  const c = guardConstraintsFromConfig(
    { termFloor: { rate: 100 }, internalTerms: ["budget cap", 42] },
    250,
  );
  assert.equal(c.allowedRate, 250);
  assert.deepEqual(c.internalTerms, ["budget cap"]); // non-strings filtered
});

test("threads the creator's ask into allowedRates", () => {
  const c = guardConstraintsFromConfig(
    { termFloor: { rate: 200 }, termCeiling: { rate: 500 } },
    475, // our counter
    500, // creator's ask (== ceiling)
  );
  assert.equal(c.allowedRate, 475);
  assert.deepEqual(c.allowedRates, [500]);
});

test("omits allowedRates when no creator ask is given", () => {
  const c = guardConstraintsFromConfig({ termCeiling: { rate: 500 } }, 475);
  assert.equal(c.allowedRates, undefined);
});

test("threads commissionRate from config", () => {
  const c = guardConstraintsFromConfig({ commissionRate: 10, termCeiling: { rate: 500 } });
  assert.equal(c.commissionRate, 10);
  // and end-to-end: a 15% draft with this config blocks.
  const r = scanOutboundDraft({ body: "15% commission works!" }, c);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "commission"));
});

test("missing terms yield undefined bounds (no false block)", () => {
  const c = guardConstraintsFromConfig({});
  assert.equal(c.floor, undefined);
  assert.equal(c.ceiling, undefined);
  const r = scanOutboundDraft({ body: "500 2000" }, c);
  assert.equal(r.ok, true);
});

console.log("\nPLU-128 — trusted public-copy $ allowlist (4th arg)\n");

// A1: a $ amount the brand wrote into its PUBLIC copy (passed as the 4th
// publicCopyConfig arg) is authorized — added to allowedRates. The negotiation
// config as the 1st arg carries only the band.
test("public-copy config contributes its $ amounts to allowedRates", () => {
  const c = guardConstraintsFromConfig(
    { minBudget: 200, maxBudget: 500 }, // negotiation config → band only
    undefined,
    undefined,
    { rewardDescription: "a $200 gift box for every creator" }, // trusted public copy
  );
  assert.deepEqual(c.allowedRates, [200]);
  // and the band is still sourced from the 1st arg, not the public copy.
  assert.equal(c.floor, 200);
  assert.equal(c.ceiling, 500);
});

// A2: default-param byte-identity. Omitting the 4th arg reads the four public
// fields from the 1st config — a negotiation-only config has none, so no
// allowedRates are produced (unchanged behavior for followUp/negotiation/reward).
test("omitting publicCopyConfig is unchanged for a negotiation-only config", () => {
  const c = guardConstraintsFromConfig({ minBudget: 200, maxBudget: 500 });
  assert.equal(c.allowedRates, undefined);
  assert.equal(c.floor, 200);
  assert.equal(c.ceiling, 500);
});

// A3: end-to-end through scanOutboundDraft — an authorized public $200 passes;
// an unauthorized $250 in the same body blocks (kind:"amount").
test("authorized public $200 passes; unauthorized $250 blocks", () => {
  const c = guardConstraintsFromConfig(
    { minBudget: 200, maxBudget: 500 },
    undefined,
    undefined,
    { rewardDescription: "a $200 gift box" },
  );
  assert.equal(scanOutboundDraft({ body: "You'll receive a $200 gift box." }, c).ok, true);
  const blocked = scanOutboundDraft({ body: "Here's a $250 bonus." }, c);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.hits.some((h) => h.kind === "amount"));
});

// A4: the public-copy config contributes ONLY $ → allowedRates. It can NOT inject
// a commissionRate / internalTerms / band — those come only from the 1st config.
test("public-copy config cannot inject commission / terms / band", () => {
  const c = guardConstraintsFromConfig(
    { commissionRate: 10, minBudget: 200, maxBudget: 500, internalTerms: ["do not share"] },
    undefined,
    undefined,
    // A malicious/garbage public config: none of these keys are read for
    // commission/terms/band, only rewardDescription's $ is harvested.
    { commissionRate: 99, internalTerms: ["leak me"], minBudget: 1, rewardDescription: "$200 box" } as Record<string, unknown>,
  );
  assert.equal(c.commissionRate, 10); // from the 1st config, not 99
  assert.deepEqual(c.internalTerms, ["do not share"]); // from the 1st config
  assert.equal(c.floor, 200); // band from the 1st config, not 1
  assert.deepEqual(c.allowedRates, [200]); // only the $ was taken from public copy
});

// A5: AC4 both directions (pure). With ceiling 500 in the band, a $500 in the
// body with NO authorizing field blocks; the same $500 authorized in public copy
// passes. "Genuinely authorized in trusted public copy" is the exact discriminator.
test("ceiling $500 blocks unless it is genuinely in trusted public copy", () => {
  const unauthorized = guardConstraintsFromConfig({ minBudget: 200, maxBudget: 500 });
  const blocked = scanOutboundDraft({ body: "We can go up to $500." }, unauthorized);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.hits.some((h) => h.kind === "ceiling" || h.kind === "amount"));

  const authorized = guardConstraintsFromConfig(
    { minBudget: 200, maxBudget: 500 },
    undefined,
    undefined,
    { rewardDescription: "a $500 product bundle" },
  );
  assert.equal(scanOutboundDraft({ body: "You'll get a $500 product bundle." }, authorized).ok, true);
});

console.log(`\n✓ outputGuard: all ${n} tests passed\n`);
