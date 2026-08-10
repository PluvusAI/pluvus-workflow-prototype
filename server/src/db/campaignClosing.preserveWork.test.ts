/**
 * PLU-153 "preserve existing creator work" guarantee.
 *
 * CLOSING only gates NEW intake (enroll / launch / initial-outreach claim). It
 * must NEVER cancel in-flight creator work — negotiation, follow-ups, manual
 * review, post-acceptance. That holds BY CONSTRUCTION: the poller's due-instance
 * query, the reconciliation sweep, and the node-execution worker select on
 * instance state + time only and never read campaign.status/archivedAt. So a
 * NEGOTIATING/AWAITING_REPLY/MANUAL_REVIEW instance under a CLOSING campaign is
 * picked up and stepped exactly as under an ACTIVE one.
 *
 * This is a source invariant, not a stubbed run: it fails the moment someone
 * adds a campaign-status filter to any of these hot paths — the exact regression
 * that would silently strand creators mid-conversation when a campaign closes.
 *
 * Run: node --import tsx --test src/db/campaignClosing.preserveWork.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// (label, file, regex the file body MUST NOT contain in its live code)
const HOT_PATHS: Array<[string, string]> = [
  ["poller due-instance + reconcile query", "../db/instances.ts"],
  ["poller", "../scheduler/poller.ts"],
  ["reconciliation sweep", "../scheduler/reconciliation.ts"],
  ["node-execution worker", "../workers/nodeExecutionWorker.ts"],
];

// Any read of a campaign's lifecycle state inside these files would be a gate on
// existing-creator work. Comments are stripped so a doc-comment mentioning
// "status" doesn't trip it.
const STATUS_READ = /campaign[^\n]*\.\s*(status|archivedAt)\b/i;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

for (const [label, rel] of HOT_PATHS) {
  test(`${label} never gates existing creator work on campaign status`, () => {
    let src: string;
    try {
      src = readFileSync(resolve(__dirname, rel), "utf8");
    } catch {
      // File was renamed/removed — surface loudly rather than silently pass.
      assert.fail(`expected hot-path file ${rel} to exist`);
      return;
    }
    const code = stripComments(src);
    assert.ok(
      !STATUS_READ.test(code),
      `${rel} reads campaign.status/archivedAt in live code — this would cancel ` +
        `in-flight creator work when a campaign is CLOSING. CLOSING must gate ` +
        `only new intake (enroll/launch/outreach-claim), never these hot paths.`,
    );
  });
}
