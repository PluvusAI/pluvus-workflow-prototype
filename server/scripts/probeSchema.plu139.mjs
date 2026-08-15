// One-shot LIVE-schema probe: confirms the DB behind DATABASE_URL has the
// PLU-135→139 shape (lifecycle status enum, CampaignDetails/NegotiationPolicy/
// BrandIdentity/CreatorRequirement tables + the columns the routes read/write).
// Read-only. Run: node server/scripts/probeSchema.plu139.mjs
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../../.env") });
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL unset"); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// table -> columns that MUST exist for the current routes/DB modules to work.
const EXPECTED = {
  Campaign: ["id", "status"],
  CampaignDetails: ["id", "campaignId", "campaignType", "priceStrategy", "publicStartingFeeCents", "publicCommissionRate", "includesGifting", "giftDisposition", "compensationReviewStatus"],
  NegotiationPolicy: ["id", "campaignId", "floorCents", "ceilingCents", "nonNegotiableTerms"],
  BrandIdentity: ["id", "campaignId", "logoRef", "primaryColor", "secondaryColor", "typography", "extractionSource", "extractedAt"],
  // PLU-139 (B) dropped niches/languages/audienceNotes/contentStyle/brandSafety —
  // only the worksheet-backed criteria remain.
  CreatorRequirement: ["id", "campaignId", "platforms", "geography", "minFollowers"],
};
const EXPECTED_ENUMS = {
  CampaignStatus: ["DRAFT", "ACTIVE"],       // CLOSING/ARCHIVED optional across branches
  CampaignType: ["PAID", "AFFILIATE", "HYBRID", "GIFT_ONLY"],
  PriceStrategy: ["REQUEST_RATE_CARD", "PROPOSE_STARTING_FEE"],
};

let bad = 0;
const { rows: cols } = await pool.query(
  `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`
);
const have = new Map();
for (const r of cols) {
  if (!have.has(r.table_name)) have.set(r.table_name, new Set());
  have.get(r.table_name).add(r.column_name);
}
console.log("=== TABLES / COLUMNS ===");
for (const [t, wanted] of Object.entries(EXPECTED)) {
  if (!have.has(t)) { console.log(`  ✗ TABLE MISSING: ${t}`); bad++; continue; }
  const missing = wanted.filter((c) => !have.get(t).has(c));
  if (missing.length) { console.log(`  ✗ ${t}: missing ${missing.join(", ")}`); bad++; }
  else console.log(`  ✓ ${t} (${wanted.length} cols present)`);
}

console.log("=== ENUMS ===");
const { rows: enums } = await pool.query(
  `SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid`
);
const enumHave = new Map();
for (const r of enums) {
  if (!enumHave.has(r.typname)) enumHave.set(r.typname, new Set());
  enumHave.get(r.typname).add(r.enumlabel);
}
for (const [name, wanted] of Object.entries(EXPECTED_ENUMS)) {
  if (!enumHave.has(name)) { console.log(`  ✗ ENUM MISSING: ${name}`); bad++; continue; }
  const missing = wanted.filter((v) => !enumHave.get(name).has(v));
  if (missing.length) { console.log(`  ✗ ${name}: missing values ${missing.join(", ")} (has: ${[...enumHave.get(name)].join(", ")})`); bad++; }
  else console.log(`  ✓ ${name} [${[...enumHave.get(name)].join(", ")}]`);
}

console.log(bad === 0 ? "\n✅ live schema is up to date (PLU-135→139)" : `\n❌ ${bad} schema gap(s) — live DB is behind`);
await pool.end();
process.exit(bad === 0 ? 0 : 2);
