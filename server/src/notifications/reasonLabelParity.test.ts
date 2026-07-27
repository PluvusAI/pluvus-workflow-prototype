/**
 * PLU-82 §8-h — the two REASON_LABELS maps must agree.
 * Run with:  npx tsx src/notifications/reasonLabelParity.test.ts
 *
 * There is no shared REASON_LABELS constant (out of scope to extract). The
 * escalation reason `material_knowledge_conflict` must appear in BOTH maps —
 * routes/manualQueue.ts (the Manual Queue label) AND notifications/escalation.ts
 * (the brand FYI email). Adding it to only one leaves either the queue or the
 * email showing a generic fallback. This test reads both source files and asserts
 * the key is present in each, so a future edit that touches only one map fails
 * here (the drift hazard §8-h names). The escalation-side RENDER is separately
 * covered in escalation.test.ts via buildEscalationEmail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const REASON = "material_knowledge_conflict";

// The two files that carry a REASON_LABELS map (kept in sync by hand — §8-h).
const MAP_FILES = [
  join(here, "escalation.ts"),
  join(here, "..", "routes", "manualQueue.ts"),
];

console.log("\nREASON_LABELS parity (§8-h)\n");

for (const file of MAP_FILES) {
  test(`${file.replace(here, ".")} contains a REASON_LABELS map`, () => {
    const src = readFileSync(file, "utf8");
    assert.ok(
      /const REASON_LABELS[\s:]/.test(src),
      "expected a REASON_LABELS declaration",
    );
  });

  test(`${file.replace(here, ".")} maps the ${REASON} key`, () => {
    const src = readFileSync(file, "utf8");
    // Match `material_knowledge_conflict:` as a map KEY (not merely mentioned in a
    // comment), i.e. followed by a colon and a string value.
    const keyed = new RegExp(`\\b${REASON}\\s*:\\s*\\n?\\s*["'\`]`);
    assert.ok(keyed.test(src), `expected a ${REASON}: "…" entry in the map`);
  });
}

console.log(`\n${n} passed\n`);
