// PLU-139 LIVE route E2E — proves the sectioned public-Draft contract persists
// end-to-end through the REAL API (create → PATCH → GET round-trip → duplicate),
// the Draft-lock guard fires on a nested-group PATCH of a non-Draft campaign, and
// a sender-settings PATCH still succeeds on an ACTIVE campaign (the B2 guard).
//
// Against a running server on API_BASE (default http://localhost:3000) + live Neon.
// There is no activation route (out of scope), so status flips are done by direct
// SQL — the same pattern plu138_e2e_live.mjs uses.
//
// Run (from server/, server + Neon up):  node --import tsx scripts/plu139_e2e_live.mjs

import { pool } from "../src/db/drizzle.js";

const API = process.env.API_BASE || "http://localhost:3000";
const OP_KEY = process.env.OPERATOR_KEY || process.env.X_OPERATOR_KEY || "";
const created = [];
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

async function api(method, path, body) {
  const res = await fetch(`${API}/api/campaigns${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(OP_KEY ? { "X-Operator-Key": OP_KEY } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function setStatus(id, status) {
  await pool.query(`UPDATE "Campaign" SET "status"=$1 WHERE "id"=$2`, [status, id]);
}

async function cleanup() {
  for (const id of created) {
    await pool.query(`DELETE FROM "Campaign" WHERE "id"=$1`, [id]).catch(() => {});
  }
}

async function main() {
  console.log(`\nPLU-139 live route E2E → ${API}\n`);

  // 1. Create a DRAFT campaign per structure, nested groups in one shot.
  const structures = [
    { compensationStructure: "PAID", priceStrategy: "PROPOSE_STARTING_AMOUNT", proposedFeeCents: 250000, feeCurrency: "USD" },
    { compensationStructure: "AFFILIATE", commissionRate: 15, commissionMode: "percent", attributionWindowDays: 30 },
    { compensationStructure: "HYBRID", proposedFeeCents: 100000, commissionRate: 10, priceStrategy: "REQUEST_RATE_CARD" },
    { compensationStructure: "GIFTING", giftDescription: "sample box", giftIsCompensation: true, giftIsPhysical: true },
  ];

  let paidId;
  for (const details of structures) {
    const r = await api("POST", "", {
      name: `PLU139 E2E ${details.compensationStructure}`,
      brand: "PLU139",
      details,
      brandIdentity: { brandName: "Acme", websiteUrl: "https://acme.test" },
      creatorRequirement: { platforms: ["instagram"], minFollowers: 10000 },
    });
    ok(r.status === 201, `create ${details.compensationStructure} → 201`);
    ok(r.json?.status === "DRAFT", `new campaign is DRAFT`);
    ok(
      r.json?.details?.compensationStructure === details.compensationStructure,
      `create echoes compensationStructure`,
    );
    if (r.json?.id) {
      created.push(r.json.id);
      if (details.compensationStructure === "PAID") paidId = r.json.id;
    }
  }

  // 2. GET round-trip: money units + no private keys + all three groups.
  {
    const r = await api("GET", `/${paidId}`);
    ok(r.status === 200, "GET detail → 200");
    ok(r.json?.details?.proposedFeeCents === 250000, "proposedFeeCents round-trips as integer CENTS");
    ok(r.json?.details?.priceStrategy === "PROPOSE_STARTING_AMOUNT", "priceStrategy round-trips");
    ok(r.json?.brandIdentity?.brandName === "Acme", "brandIdentity group present");
    ok(Array.isArray(r.json?.creatorRequirement?.platforms), "creatorRequirement group present");
    // No private-policy keys should ever appear on details.
    const forbidden = ["floor", "ceiling", "minBudget", "maxBudget", "negotiationFloor", "negotiationCeiling", "escalation", "approvalMode", "policy"];
    const keys = Object.keys(r.json?.details ?? {});
    ok(!keys.some((k) => forbidden.includes(k)), `details payload has NO private-policy key (${keys.length} keys)`);
  }

  // 3. PATCH a nested group on the DRAFT → 200 + structure switch clears stale fields.
  {
    const r = await api("PATCH", `/${paidId}`, {
      details: { compensationStructure: "AFFILIATE", commissionRate: 20 },
    });
    ok(r.status === 200, "PATCH nested group on DRAFT → 200");
    ok(r.json?.details?.commissionRate === 20, "commission set");
    ok(r.json?.details?.proposedFeeCents === null, "stale fee CLEARED on structure switch");
    ok(r.json?.details?.priceStrategy === null, "stale strategy CLEARED on structure switch");
  }

  // 4. Duplicate → new DRAFT copying details, NOT workflows.
  {
    const r = await api("POST", `/${paidId}/duplicate`, {});
    ok(r.status === 201, "duplicate → 201");
    ok(r.json?.status === "DRAFT", "duplicate is a DRAFT");
    if (r.json?.id) {
      created.push(r.json.id);
      const g = await api("GET", `/${r.json.id}`);
      ok(g.json?.details?.compensationStructure === "AFFILIATE", "duplicate copied the details group");
      ok((g.json?.workflows ?? []).length === 0, "duplicate copied NO workflows");
    }
  }

  // 5. Flip the PAID campaign to ACTIVE, then:
  //    (a) a nested-group PATCH → 409 (Draft-lock),
  //    (b) a sender-settings PATCH → 200 (B2 regression guard — live edits allowed).
  {
    await setStatus(paidId, "ACTIVE");
    const blocked = await api("PATCH", `/${paidId}`, {
      details: { compensationStructure: "PAID" },
    });
    ok(blocked.status === 409, "nested-group PATCH on ACTIVE → 409 (Draft-lock)");

    const allowed = await api("PATCH", `/${paidId}`, { notifyEmail: "ops@acme.test" });
    ok(allowed.status === 200, "sender-settings PATCH on ACTIVE → 200 (B2 guard)");
    ok(allowed.json?.notifyEmail === "ops@acme.test", "sender-settings edit persisted on ACTIVE");
  }

  // 6. Invalid enum / negative int rejected at the boundary.
  {
    const bad = await api("POST", "", {
      name: "PLU139 bad",
      brand: "PLU139",
      details: { compensationStructure: "FIXED" },
    });
    ok(bad.status === 400, "invalid compensationStructure → 400 (no FIXED|NEGOTIATED)");
    const neg = await api("POST", "", {
      name: "PLU139 neg",
      brand: "PLU139",
      details: { compensationStructure: "PAID", proposedFeeCents: -1 },
    });
    ok(neg.status === 400, "negative proposedFeeCents → 400");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
}

main()
  .catch((err) => {
    console.error(err);
    fail++;
  })
  .finally(async () => {
    await cleanup();
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
  });
