// Live-DB drift fix for PLU-136.
//
// PLU-136's migration adds the CampaignType value GIFT_ONLY via a guarded
//   DO $$ BEGIN CREATE TYPE "CampaignType" AS ENUM (...,'GIFT_ONLY');
//         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
// On a DB that ALREADY had a CampaignType enum (the old GIFT/PAID/AFFILIATE/
// HYBRID shape), that CREATE TYPE hits duplicate_object and silently no-ops —
// so GIFT_ONLY is never added and the stale value GIFT remains. Every other
// (column-level) change in that migration applied fine; only the enum drifted.
//
// Fix: rename the stale value in place. RENAME VALUE (pg 10+) preserves any
// rows using it and can't be left half-applied the way ADD VALUE can. This app
// uses GIFT_ONLY everywhere (schema.prisma / drizzle / routes); no code refs
// GIFT. Idempotent + safe to re-run.
//
// Run: node server/scripts/fixGiftEnum.plu136.mjs
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../../.env") });
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set (repo-root .env)");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const has = async (v) =>
  (
    await pool.query(
      `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'CampaignType' AND e.enumlabel = $1`,
      [v],
    )
  ).rowCount > 0;

try {
  if (await has("GIFT_ONLY")) {
    console.log("✓ GIFT_ONLY already present — nothing to do.");
  } else if (await has("GIFT")) {
    await pool.query(`ALTER TYPE "CampaignType" RENAME VALUE 'GIFT' TO 'GIFT_ONLY'`);
    console.log("✓ Renamed CampaignType value GIFT → GIFT_ONLY.");
  } else {
    await pool.query(`ALTER TYPE "CampaignType" ADD VALUE IF NOT EXISTS 'GIFT_ONLY'`);
    console.log("✓ Added CampaignType value GIFT_ONLY.");
  }
  const { rows } = await pool.query(
    `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'CampaignType' ORDER BY e.enumsortorder`,
  );
  console.log("CampaignType now:", rows.map((r) => r.v).join(", "));
} finally {
  await pool.end();
}
