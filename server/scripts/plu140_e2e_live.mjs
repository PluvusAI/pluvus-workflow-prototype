// PLU-140 (2b) LIVE e2e — drives the REAL Express app (createApp) + REAL Neon
// over HTTP, exercising exactly the endpoints the intake UI calls:
//   readiness GET · policy PATCH · compensationReviewStatus PATCH · launch POST
//   · duplicate POST · public campaign GET (privacy).
//
// Flow (all real route handlers, no mocks):
//   1. POST /campaigns                          → create a DRAFT campaign
//   2. PATCH /campaigns/:id                     → set a PAID compensation shape
//   3. GET  /campaigns/:id/readiness            → expect NOT ready (no policy)
//   4. PATCH /campaigns/:id/negotiation-policy  → set fee bounds (private)
//   5. GET  /campaigns/:id                       → assert NO policy field leaks (privacy)
//   6. GET  /campaigns/:id/readiness            → still NOT ready (review not confirmed)
//   7. POST /campaigns/:id/launch               → expect 409 (review pending)
//   8. PATCH /campaigns/:id (CONFIRMED)         → the Page-9 approve flip
//   9. GET  /campaigns/:id/readiness            → now READY, no blockers
//  10. POST /campaigns/:id/launch               → 200, returns snapshot id + launchedAt
//  11. POST /campaigns/:id/launch (again)       → idempotent: SAME snapshot id
//  12. PATCH /campaigns/:id/negotiation-policy  → 409 (locked once ACTIVE)
//  13. POST /campaigns/:id/duplicate            → 201, DRAFT, review reset to NEEDS_REVIEW
//  14. cleanup every seeded/duplicated row (FK-safe)
//
// Run:  node --import tsx scripts/plu140_e2e_live.mjs   (from server/)

import { createApp } from "../src/app.js";
import { pool } from "../src/db/drizzle.js";

const OP_KEY = process.env.OPERATOR_API_KEY || "";
const q = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);

let pass = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
  console.log(`  ✓ ${msg}`);
}

let base;
async function api(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (OP_KEY) headers["x-operator-key"] = OP_KEY;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

const createdCampaignIds = [];

async function cleanup() {
  for (const id of createdCampaignIds) {
    // FK-safe: snapshots + audit + details + policy reference campaign.
    await q(`DELETE FROM "NegotiationPolicySnapshot" WHERE "campaignId"=$1`, [id]).catch(() => {});
    await q(`DELETE FROM "CampaignTermsSnapshot" WHERE "campaignId"=$1`, [id]).catch(() => {});
    await q(`DELETE FROM "CampaignAuditEvent" WHERE "campaignId"=$1`, [id]).catch(() => {});
    await q(`DELETE FROM "NegotiationPolicy" WHERE "campaignId"=$1`, [id]).catch(() => {});
    await q(`DELETE FROM "CampaignDetails" WHERE "campaignId"=$1`, [id]).catch(() => {});
    await q(`DELETE FROM "Campaign" WHERE "id"=$1`, [id]).catch(() => {});
  }
}

async function main() {
  console.log("\nPLU-140 live e2e (real Express app + Neon)\n");

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`  (app listening on ${base})`);

  try {
    // 1. create DRAFT campaign -------------------------------------------------
    const created = await api("POST", "/campaigns", {
      name: "PLU140-E2E Campaign",
      brand: "PLU140-E2E Brand",
      campaignType: "PAID",
      priceStrategy: "REQUEST_RATE_CARD",
    });
    ok(created.status === 200 || created.status === 201, `POST /campaigns → ${created.status}`);
    const id = created.body.id;
    ok(typeof id === "string" && id.length > 0, "created campaign has an id");
    createdCampaignIds.push(id);

    // 2. set the PAID compensation shape (also seeds compensationReviewStatus
    //    absent → the intake would set it, but we leave it NEEDS_REVIEW here to
    //    prove the launch gate).
    const patched = await api("PATCH", `/campaigns/${id}`, {
      campaignType: "PAID",
      priceStrategy: "REQUEST_RATE_CARD",
    });
    ok(patched.status === 200, `PATCH /campaigns/:id → ${patched.status}`);

    // 3. readiness BEFORE a policy exists → not ready, hasPolicy false ----------
    let r = await api("GET", `/campaigns/${id}/readiness`);
    ok(r.status === 200, `GET /readiness → ${r.status}`);
    ok(r.body.ready === false, "not ready before a policy exists");
    ok(r.body.hasPolicy === false, "hasPolicy:false with no policy row");
    ok(
      r.body.blockers.some((b) => b.includes("NegotiationPolicy is missing")),
      "blocker names the missing policy",
    );

    // 4. set the PRIVATE fee bounds -------------------------------------------
    const pol = await api("PATCH", `/campaigns/${id}/negotiation-policy`, {
      floorCents: 20000,
      ceilingCents: 50000,
      preferredFeeCents: 30000,
      maxRounds: 3,
    });
    ok(pol.status === 200, `PATCH /negotiation-policy → ${pol.status}`);
    ok(pol.body.ceilingCents === 50000, "policy ceiling persisted");

    // 5. PRIVACY: the public campaign payload must carry NO policy field --------
    const pub = await api("GET", `/campaigns/${id}`);
    ok(pub.status === 200, `GET /campaigns/:id → ${pub.status}`);
    for (const leak of [
      "floorCents",
      "ceilingCents",
      "preferredFeeCents",
      "commissionCeilingRate",
      "giftValueFlexibilityCents",
      "nonNegotiableTerms",
      "negotiationGuidance",
    ]) {
      ok(!(leak in pub.body), `public payload does NOT leak private policy field "${leak}"`);
    }

    // 6. readiness with policy but review still NEEDS_REVIEW → still not ready ---
    r = await api("GET", `/campaigns/${id}/readiness`);
    ok(r.body.hasPolicy === true, "hasPolicy:true after policy set");
    ok(r.body.reviewConfirmed === false, "review not confirmed yet");
    ok(r.body.ready === false, "not ready while review pending");
    ok(
      r.body.blockers.some((b) => b.toLowerCase().includes("review")),
      "blocker names the pending review",
    );

    // 7. launch while NEEDS_REVIEW → 409 (matches readiness) -------------------
    let launch = await api("POST", `/campaigns/${id}/launch`);
    ok(launch.status === 409, `POST /launch while pending → ${launch.status} (409)`);

    // 8. the Page-9 approve flip: compensationReviewStatus = CONFIRMED ----------
    const confirm = await api("PATCH", `/campaigns/${id}`, {
      compensationReviewStatus: "CONFIRMED",
    });
    ok(confirm.status === 200, `PATCH compensationReviewStatus=CONFIRMED → ${confirm.status}`);

    // 9. readiness now clean ---------------------------------------------------
    r = await api("GET", `/campaigns/${id}/readiness`);
    ok(r.body.ready === true, "READY once confirmed + complete");
    ok(r.body.blockers.length === 0, "no blockers when ready");
    ok(r.body.reviewConfirmed === true, "reviewConfirmed:true");

    // 10. launch → 200 with snapshot id + launchedAt --------------------------
    launch = await api("POST", `/campaigns/${id}/launch`);
    ok(launch.status === 200, `POST /launch → ${launch.status}`);
    ok(launch.body.campaignId === id, "launch result carries campaignId");
    ok(
      typeof launch.body.campaignTermsSnapshotId === "string" && launch.body.campaignTermsSnapshotId,
      "launch returns a campaignTermsSnapshotId",
    );
    ok(!Number.isNaN(Date.parse(launch.body.launchedAt)), "launch returns a valid launchedAt");
    const snapId = launch.body.campaignTermsSnapshotId;

    // status is now ACTIVE
    const active = await api("GET", `/campaigns/${id}`);
    ok(active.body.status === "ACTIVE", "campaign is ACTIVE after launch");

    // BOTH snapshots exist in the DB (public + private)
    const [{ ct }] = await q(`SELECT COUNT(*)::int ct FROM "CampaignTermsSnapshot" WHERE "campaignId"=$1`, [id]);
    const [{ np }] = await q(`SELECT COUNT(*)::int np FROM "NegotiationPolicySnapshot" WHERE "campaignId"=$1`, [id]);
    ok(ct === 1, "exactly one CampaignTermsSnapshot (public)");
    ok(np === 1, "exactly one NegotiationPolicySnapshot (private)");
    // the private snapshot froze the fee bounds
    const [snap] = await q(`SELECT "ceilingCents","floorCents" FROM "NegotiationPolicySnapshot" WHERE "campaignId"=$1`, [id]);
    ok(snap.ceilingCents === 50000 && snap.floorCents === 20000, "private snapshot froze the fee bounds");

    // 11. idempotent: launching again returns the SAME snapshot id -------------
    const relaunch = await api("POST", `/campaigns/${id}/launch`);
    ok(relaunch.status === 200, `second POST /launch → ${relaunch.status}`);
    ok(
      relaunch.body.campaignTermsSnapshotId === snapId,
      "idempotent launch returns the SAME snapshot id",
    );
    const [{ ct2 }] = await q(`SELECT COUNT(*)::int ct2 FROM "CampaignTermsSnapshot" WHERE "campaignId"=$1`, [id]);
    ok(ct2 === 1, "still exactly one snapshot after a second launch (no duplicate)");

    // 12. post-launch lock: policy PATCH is rejected 409 -----------------------
    const locked = await api("PATCH", `/campaigns/${id}/negotiation-policy`, { ceilingCents: 99999 });
    ok(locked.status === 409, `PATCH policy once ACTIVE → ${locked.status} (locked)`);

    // 13. duplicate → fresh DRAFT with review reset to NEEDS_REVIEW ------------
    const dup = await api("POST", `/campaigns/${id}/duplicate`);
    ok(dup.status === 201, `POST /duplicate → ${dup.status}`);
    ok(dup.body.status === "DRAFT", "duplicate is a DRAFT");
    ok(
      dup.body.compensationReviewStatus === "NEEDS_REVIEW",
      "duplicate resets compensationReviewStatus to NEEDS_REVIEW",
    );
    ok(dup.body.id !== id, "duplicate is a new campaign id");
    createdCampaignIds.push(dup.body.id);

    console.log(`\n${pass} assertions passed — PLU-140 e2e GREEN\n`);
  } finally {
    await cleanup();
    console.log("  (cleaned up all seeded rows)");
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error("\nPLU-140 e2e FAILED:", err.message);
  try {
    await cleanup();
    console.log("  (cleaned up after failure)");
  } catch {}
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
