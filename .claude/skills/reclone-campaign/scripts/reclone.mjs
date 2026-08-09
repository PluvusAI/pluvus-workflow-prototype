#!/usr/bin/env node
// Reclone the latest campaign in the local Pluvus dev DB, then set it up for a
// fresh run: attach a HYBRID workflow, patch the negotiation band, attach a
// Content Brief PDF, publish, enroll one creator, and launch. Every clone is
// stamped postAcceptanceMode=operator_handoff ("After a creator accepts → send to
// operator for onboarding").
//
// Default flow: GET /campaigns -> clone latest campaign's fields via POST (forcing
// notifyEmail=escalation inbox and postAcceptanceMode=operator_handoff) -> DELETE
// the original -> attach a hybrid workflow -> patch the NEGOTIATION band (floor
// 200 / ceiling 500 / maxRounds 2) -> upload the newest Desktop PDF into the
// CONTENT_BRIEF node -> PUT the patched draft -> publish -> upsert + enroll the
// creator -> launch. Talks only to the running dev server's REST API (no DB
// access), so the server's validation and cascade-delete logic applies.
//
// Pass --no-workflow to create the campaign ONLY (clone + delete + stop).
//
// Usage:
//   node reclone.mjs [templateKey] [--keep] [--no-workflow] [--no-launch]
//     templateKey    affiliate | hybrid | fixed_fee   (default: hybrid)
//     --keep         do not delete the original campaign
//     --no-workflow  create the campaign only; skip workflow + band + brief + enroll + launch
//     --no-launch    publish + enroll but do NOT launch (leave enrolled)
//
// Env overrides:
//   PORT                  server port (default 3001)
//   ESCALATION_EMAIL      brand-decision notify inbox (default gadeayush23@gmail.com)
//   POST_ACCEPTANCE_MODE  after-accept mode (default operator_handoff; or local_payment)
//   CREATOR_EMAIL         creator to enroll (default ayushgade23@gmail.com)
//   CREATOR_NAME          creator display name (default "Ayush Gade")
//   CREATOR_PLATFORM      creator platform (default "Instagram")
//   DESKTOP_DIR           where to find the brief PDF (default the Windows Desktop)
//   MIN_BUDGET            negotiation floor (default 200)
//   MAX_BUDGET            negotiation ceiling (default 500)
//   MAX_ROUNDS            negotiation max rounds (default 2)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = process.env.PORT || "3001";
const BASE = `http://localhost:${PORT}`;

// Operator-route gate (P2 single-operator go-live): the server requires an
// X-Operator-Key header on the operator routers (/campaigns, /workflows, ...).
// Read it from the environment, or fall back to reading the repo-root .env so a
// bare `node reclone.mjs` still authenticates in local dev. Mirrors the
// add-conversion skill helper.
function readEnvFile() {
  try {
    const text = readFileSync(join(process.cwd(), ".env"), "utf8");
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
const _envFile = readEnvFile();
const OPERATOR_KEY = process.env.OPERATOR_API_KEY || _envFile.OPERATOR_API_KEY || "";
const operatorHeaders = OPERATOR_KEY ? { "X-Operator-Key": OPERATOR_KEY } : {};

// Default escalation / brand-decision notify address. Forced onto every clone so
// manual-escalation emails (AWAITING_BRAND_DECISION) land in an inbox we watch —
// deliberately DIFFERENT from the creator inbox and the Nylas sender mailbox
// (notbaka2303@gmail.com) so self-addressed mail doesn't skip the Inbox.
// Override per-run with ESCALATION_EMAIL.
const ESCALATION_EMAIL = process.env.ESCALATION_EMAIL || "gadeayush23@gmail.com";

// The single creator this run enrols + launches with.
const CREATOR_EMAIL = process.env.CREATOR_EMAIL || "ayushgade23@gmail.com";
const CREATOR_NAME = process.env.CREATOR_NAME || "Ayush Gade";
const CREATOR_PLATFORM = process.env.CREATOR_PLATFORM || "Instagram";

// Negotiation band + rounds stamped onto the NEGOTIATION node.
const MIN_BUDGET = Number(process.env.MIN_BUDGET ?? 200);
const MAX_BUDGET = Number(process.env.MAX_BUDGET ?? 500);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 2);

// Where to find the Campaign Brief PDF — the Windows Desktop by default.
const DESKTOP_DIR = process.env.DESKTOP_DIR || join(homedir(), "Desktop");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const templateKey = args.find((a) => !a.startsWith("--")) || "hybrid";
const keepOriginal = flags.has("--keep");
// DEFAULT is the full run-setup pipeline: clone -> attach a HYBRID workflow ->
// negotiation band -> brief PDF -> publish -> enroll + launch one creator. Every
// clone still gets postAcceptanceMode=operator_handoff. Pass --no-workflow to
// create the campaign only (clone + delete + stop). --with-workflow / --workflow
// are accepted as explicit opt-ins (no-ops now that workflow is the default).
const skipWorkflow = flags.has("--no-workflow");
const skipLaunch = flags.has("--no-launch");

// Optional overrides from env.
const TARGET_URL = process.env.TARGET_URL || null;
const COMMISSION_RATE = process.env.COMMISSION_RATE ? Number(process.env.COMMISSION_RATE) : 10;

// Fields the campaign POST endpoint accepts / that define a campaign.
const CAMPAIGN_FIELDS = [
  "name",
  "brand",
  "objective",
  "notes",
  "notifyEmail",
  "brandDescription",
  "deliverables",
  "timeline",
  "rewardDescription",
  "shipsPhysicalProduct",
  "targetUrl",
  "hiddenParamKey",
  // PLU-70: "After a creator accepts" mode. The clone forces this to
  // operator_handoff below ("send to operator for onboarding"), so cloning the
  // source value is only a fallback if the force is ever disabled.
  "postAcceptanceMode",
];

// "After a creator accepts" behaviour stamped onto every clone. operator_handoff
// = "send to operator for onboarding": once a creator accepts, the deal is handed
// to the human operator's inbox to finalize/onboard rather than running the local
// payment flow. Override with POST_ACCEPTANCE_MODE (local_payment | operator_handoff).
const POST_ACCEPTANCE_MODE = process.env.POST_ACCEPTANCE_MODE || "operator_handoff";

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...operatorHeaders,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Cannot reach dev server at ${BASE} (${err.code || err.message}). ` +
        `Start it with \`npm run dev\` in server/, or set PORT.`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

// Find the newest *.pdf on the Desktop. Returns { path, name } or throws with a
// clear message so the caller knows to drop a PDF there.
function newestDesktopPdf() {
  let entries;
  try {
    entries = readdirSync(DESKTOP_DIR);
  } catch (err) {
    throw new Error(`Cannot read Desktop dir ${DESKTOP_DIR} (${err.code || err.message}). Set DESKTOP_DIR.`);
  }
  const pdfs = entries
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => {
      const p = join(DESKTOP_DIR, f);
      return { path: p, name: f, mtime: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (pdfs.length === 0) {
    throw new Error(`No *.pdf found on the Desktop (${DESKTOP_DIR}). Drop the Campaign Brief PDF there and re-run.`);
  }
  return pdfs[0];
}

// Upload a PDF via multipart POST /uploads and return its stored reference.
// Uses Node's built-in FormData/Blob (Node 18+) so there are no dependencies.
async function uploadPdf(pdf) {
  const bytes = readFileSync(pdf.path);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), pdf.name);
  let res;
  try {
    res = await fetch(BASE + "/uploads", { method: "POST", headers: operatorHeaders, body: form });
  } catch (err) {
    throw new Error(`Upload failed to reach ${BASE}/uploads (${err.code || err.message}).`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /uploads -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text); // { reference, originalName, size }
}

// Read the workflow's draftNodes array (the builder-editable graph).
async function draftNodesOf(workflowId) {
  const wf = await req("GET", `/workflows/${workflowId}`);
  const nodes = Array.isArray(wf.draftNodes) ? wf.draftNodes : [];
  return nodes;
}

function nodeType(n) {
  return (n && (n.type || n.kind)) || "";
}

async function main() {
  console.log(`> Using server ${BASE}`);

  // 1. Latest campaign = first item (server orders by createdAt desc).
  const campaigns = await req("GET", "/campaigns");
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    console.error("No campaigns found — nothing to reclone.");
    process.exit(1);
  }
  const original = campaigns[0];
  console.log(`> Latest campaign: "${original.name}" (${original.id})`);

  // 2. Clone the campaign fields. Force notifyEmail to the escalation inbox so
  //    manual-escalation / brand-decision emails always reach an inbox we watch,
  //    regardless of what the source campaign carried. Force postAcceptanceMode
  //    to operator_handoff ("send to operator for onboarding") so an accepted
  //    creator is handed to the operator inbox to finalize.
  const cloneFields = {
    ...pick(original, CAMPAIGN_FIELDS),
    notifyEmail: ESCALATION_EMAIL,
    postAcceptanceMode: POST_ACCEPTANCE_MODE,
  };
  // Override targetUrl from env if provided (campaign POST accepts it; PATCH does not).
  if (TARGET_URL) cloneFields.targetUrl = TARGET_URL;
  const clone = await req("POST", "/campaigns", cloneFields);
  console.log(
    `> Cloned -> new campaign id ${clone.id} ` +
      `(notifyEmail=${ESCALATION_EMAIL}, postAcceptanceMode=${POST_ACCEPTANCE_MODE})`,
  );

  // 3. Delete the original (unless --keep).
  if (keepOriginal) {
    console.log("> Skipping delete (--keep): original left in place.");
  } else {
    // PLU-153: a launched campaign 409s on a plain DELETE — dev-reset forces it.
    await req("DELETE", `/campaigns/${original.id}?force=true`);
    console.log(`> Deleted original ${original.id}`);
  }

  // 4. Attach a workflow — the default. Pass --no-workflow to create the campaign
  //    only (clone + delete + stop; no band / brief / enroll / launch).
  if (skipWorkflow) {
    console.log("> Campaign created only (--no-workflow). Omit it to attach a hybrid workflow + launch.");
    const after = await req("GET", "/campaigns");
    console.log(`> Campaigns now: ${after.length}`);
    console.log("\nDone.");
    console.log(JSON.stringify(
      {
        originalId: original.id,
        cloneId: clone.id,
        originalDeleted: !keepOriginal,
        postAcceptanceMode: POST_ACCEPTANCE_MODE,
        workflowId: null,
      },
      null, 2,
    ));
    return;
  }

  const workflow = await req("POST", `/campaigns/${clone.id}/workflows`, {
    name: `${clone.name} Outreach`,
    templateKey,
  });
  const nodeCount = Array.isArray(workflow.draftNodes) ? workflow.draftNodes.length : "?";
  console.log(
    `> Created ${templateKey} workflow "${workflow.name}" (${workflow.id}), ` +
      `status ${workflow.status}, ${nodeCount} nodes`,
  );

  // 5. Patch the graph: set the negotiation band + rounds, and attach the brief
  //    PDF to the Content Brief node. Then PUT the full draftNodes back.
  const nodes = await draftNodesOf(workflow.id);

  const negNode = nodes.find((n) => nodeType(n) === "NEGOTIATION");
  if (negNode) {
    negNode.config = {
      ...(negNode.config || {}),
      minBudget: MIN_BUDGET,
      maxBudget: MAX_BUDGET,
      maxRounds: MAX_ROUNDS,
      commissionRate: COMMISSION_RATE,
    };
    console.log(`> NEGOTIATION band set to ${MIN_BUDGET}-${MAX_BUDGET}, maxRounds=${MAX_ROUNDS}, commissionRate=${COMMISSION_RATE}%`);
  } else {
    console.log("> WARNING: no NEGOTIATION node found — band not set.");
  }

  const briefNode = nodes.find((n) => nodeType(n) === "CONTENT_BRIEF");
  let briefRef = null;
  if (briefNode) {
    const pdf = newestDesktopPdf();
    console.log(`> Uploading brief PDF: ${pdf.name}`);
    const uploaded = await uploadPdf(pdf);
    briefRef = uploaded.reference;
    briefNode.config = {
      ...(briefNode.config || {}),
      briefFileRef: uploaded.reference,
      briefFileName: uploaded.originalName || pdf.name,
    };
    console.log(`> CONTENT_BRIEF brief attached (ref ${uploaded.reference})`);
  } else {
    console.log("> No CONTENT_BRIEF node — skipping PDF upload.");
  }

  // Persist the patched graph.
  const saved = await req("PUT", `/workflows/${workflow.id}/draft`, { nodes });
  if (saved.valid === false) {
    console.log(
      `> NOTE: draft saved but validation flagged: ${JSON.stringify(saved.validationErrors)}`,
    );
  }

  // 6. Publish (validates the graph; requires the brief PDF to be present).
  const version = await req("POST", `/workflows/${workflow.id}/publish`, {});
  console.log(`> Published workflow version ${version.version} (${version.versionId})`);

  // 7. Upsert the creator (reuse if the email already exists) and get its id.
  //    POST /creators upserts a SINGLE creator by email and returns { creator }.
  //    (The bulk /creators/imports path is a multipart CSV flow — not what we want
  //    for one row.)
  const created = await req("POST", "/creators", {
    email: CREATOR_EMAIL,
    name: CREATOR_NAME,
    platform: CREATOR_PLATFORM,
  });
  const creator = created.creator;
  if (!creator) throw new Error(`creator upsert returned no creator for ${CREATOR_EMAIL}`);
  console.log(`> Creator ready: ${creator.email} (${creator.id})`);

  // 8. Enroll the one creator onto the published version.
  const enroll = await req("POST", `/workflows/${workflow.id}/enroll`, {
    creatorIds: [creator.id],
  });
  console.log(`> Enrolled: ${enroll.enrolled}, skipped: ${enroll.skipped}`);

  // 9. Launch (fires outreach for ENROLLED instances) unless --no-launch.
  let launched = null;
  if (skipLaunch) {
    console.log("> Skipping launch (--no-launch): instance left ENROLLED.");
  } else {
    launched = await req("POST", `/workflows/${workflow.id}/launch`, {});
    console.log(`> Launched ${launched.launched} instance(s) — outreach sending.`);
  }

  console.log("\nDone.");
  console.log(JSON.stringify(
    {
      originalId: original.id,
      cloneId: clone.id,
      originalDeleted: !keepOriginal,
      workflowId: workflow.id,
      versionId: version.versionId,
      band: { minBudget: MIN_BUDGET, maxBudget: MAX_BUDGET, maxRounds: MAX_ROUNDS, commissionRate: COMMISSION_RATE },
      targetUrl: cloneFields.targetUrl || null,
      briefFileRef: briefRef,
      creatorId: creator.id,
      creatorEmail: creator.email,
      enrolled: enroll.enrolled,
      launched: launched ? launched.launched : 0,
      templateKey,
    },
    null,
    2,
  ));
}

main().catch((err) => {
  console.error("\nReclone failed:", err.message);
  process.exit(1);
});
