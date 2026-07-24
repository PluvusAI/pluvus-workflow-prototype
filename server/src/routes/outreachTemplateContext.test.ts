/**
 * Unit tests for buildOutreachTemplateContext — the server-side assembly of the
 * brand/campaign/deal context sent to the agent's template route (PLU-117 §4.2).
 *
 * This is the TRUST BOUNDARY: the client never supplies brand facts, so the tests
 * assert that (a) context comes from the campaign row + NEGOTIATION node only,
 * (b) empty/absent fields are omitted (never sent as "" facts), and (c) the
 * allow-list of placeholders is the server's own set. Pure — no DB, no agent.
 *
 * Run with:  npx tsx src/routes/outreachTemplateContext.test.ts
 */

import assert from "node:assert/strict";
import { buildOutreachTemplateContext } from "./workflows.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const negNode = (config: Record<string, unknown>) => [
  { id: "neg", type: "NEGOTIATION", order: 0, config },
  { id: "out", type: "INITIAL_OUTREACH", order: 1, config: {} },
];

console.log("\noutreach template context assembly\n");

test("allowedPlaceholders is AVAILABILITY-filtered — no campaign → only always-vars", () => {
  // PLU-117: with no campaign facts, the AI only gets the always-available
  // placeholders (creator vars + collaborationType), NOT the config-sourced ones
  // (brandName/senderName/campaignName/offerSummary/... which would render blank).
  const { allowedPlaceholders } = buildOutreachTemplateContext(null, []);
  assert.deepEqual(
    allowedPlaceholders.sort(),
    [
      "{{collaborationType}}",
      "{{creatorFirstName}}",
      "{{creatorName}}",
      "{{niche}}",
      "{{platform}}",
    ].sort(),
  );
  // Config-sourced placeholders the brand didn't supply must NOT be offered —
  // including brandName/senderName (they come from the campaign brand).
  for (const bad of ["{{brandName}}", "{{senderName}}", "{{campaignName}}", "{{offerSummary}}", "{{deliverables}}", "{{rewardDescription}}"]) {
    assert.ok(!allowedPlaceholders.includes(bad), `${bad} must not be offered with no campaign`);
  }
});

test("brandName/senderName ARE offered once the campaign brand is present", () => {
  const { allowedPlaceholders } = buildOutreachTemplateContext({ brand: "Acme" }, []);
  assert.ok(allowedPlaceholders.includes("{{brandName}}"));
  assert.ok(allowedPlaceholders.includes("{{senderName}}"));
});

test("allowedPlaceholders grows as the brand supplies fields", () => {
  const { allowedPlaceholders } = buildOutreachTemplateContext(
    { brand: "Acme", name: "Spring Launch", deliverables: "2 Reels" },
    negNode({ maxBudget: 500, commissionRate: 15 }),
  );
  // Now campaignName + deliverables + the deal-shape offerSummary are available.
  assert.ok(allowedPlaceholders.includes("{{campaignName}}"));
  assert.ok(allowedPlaceholders.includes("{{deliverables}}"));
  assert.ok(allowedPlaceholders.includes("{{offerSummary}}"));
  // timeline / rewardDescription / brandDescription still absent → not offered.
  assert.ok(!allowedPlaceholders.includes("{{timeline}}"));
  assert.ok(!allowedPlaceholders.includes("{{rewardDescription}}"));
  assert.ok(!allowedPlaceholders.includes("{{brandDescription}}"));
});

test("brand facts come from the campaign row", () => {
  const { brandContext } = buildOutreachTemplateContext(
    {
      brand: "Acme",
      brandDescription: "eco footwear",
      name: "Spring Launch",
      deliverables: "2 Reels",
      timeline: "by Sept 15",
      rewardDescription: "free shoes",
    },
    [],
  );
  assert.equal(brandContext["brandName"], "Acme");
  assert.equal(brandContext["senderName"], "Acme");
  assert.equal(brandContext["brandDescription"], "eco footwear");
  assert.equal(brandContext["campaignName"], "Spring Launch");
  assert.equal(brandContext["deliverables"], "2 Reels");
  assert.equal(brandContext["timeline"], "by Sept 15");
  assert.equal(brandContext["rewardDescription"], "free shoes");
});

test("empty / whitespace / null campaign fields are OMITTED (not sent as facts)", () => {
  const { brandContext } = buildOutreachTemplateContext(
    { brand: "Acme", brandDescription: "   ", name: null, deliverables: "" },
    [],
  );
  assert.equal(brandContext["brandName"], "Acme");
  assert.ok(!("brandDescription" in brandContext), "blank description must be omitted");
  assert.ok(!("campaignName" in brandContext), "null name must be omitted");
  assert.ok(!("deliverables" in brandContext), "empty deliverables must be omitted");
});

test("deal shape (fixed-fee) is derived from the NEGOTIATION node", () => {
  const { brandContext } = buildOutreachTemplateContext(
    { brand: "Acme" },
    negNode({ minBudget: 200, maxBudget: 500 }),
  );
  assert.equal(brandContext["collaborationType"], "fixed-fee collaboration");
  assert.match(brandContext["offerSummary"] as string, /fixed-fee collaboration/);
  // Price-free: no dollar amounts leak into the context.
  assert.ok(!/\$|\b200\b|\b500\b/.test(brandContext["offerSummary"] as string));
});

test("deal shape (hybrid) includes commission but no dollar figure", () => {
  const { brandContext } = buildOutreachTemplateContext(
    { brand: "Acme" },
    negNode({ minBudget: 200, maxBudget: 500, commissionRate: 15 }),
  );
  assert.equal(brandContext["collaborationType"], "hybrid partnership");
  assert.match(brandContext["offerSummary"] as string, /15% commission/);
});

test("no discernible deal shape → collaborationType/offerSummary omitted", () => {
  const { brandContext } = buildOutreachTemplateContext({ brand: "Acme" }, negNode({}));
  assert.ok(!("collaborationType" in brandContext));
  assert.ok(!("offerSummary" in brandContext));
});

test("null campaign yields an empty brand context (no crash)", () => {
  const { brandContext } = buildOutreachTemplateContext(null, negNode({ maxBudget: 500 }));
  assert.ok(!("brandName" in brandContext));
  // Deal shape still resolves from the node even with no campaign.
  assert.equal(brandContext["collaborationType"], "fixed-fee collaboration");
});

test("non-array draftNodes is tolerated", () => {
  const { brandContext } = buildOutreachTemplateContext({ brand: "Acme" }, undefined);
  assert.equal(brandContext["brandName"], "Acme");
  assert.ok(!("collaborationType" in brandContext));
});

console.log(`\n✓ outreachTemplateContext: all ${n} tests passed\n`);
