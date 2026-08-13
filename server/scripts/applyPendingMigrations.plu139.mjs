// PLU-139 one-shot applier — applies the campaign-sections migration to live Neon.
//   20260813120000_plu139_campaign_sections
//     (idempotent: enums use DO $$/EXCEPTION, ADD COLUMN/CREATE TABLE/CREATE INDEX
//      use IF NOT EXISTS; the ADD CONSTRAINT ...fkey steps are the only non-
//      idempotent statements — run this ONCE, like the other appliers.)
//
// Mirrors applyPendingMigrations.mjs: splits each file into statements (treating
// $$-dollar-quoted DO blocks as single statements) and executes them in order
// against DATABASE_URL via the WS Pool driver.

import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { config as dotenvConfig } from "dotenv";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../../.env") });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set (repo-root .env)");
  process.exit(1);
}
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migDir = resolve(__dirname, "../prisma/migrations");
const FILES = ["20260813120000_plu139_campaign_sections/migration.sql"];

// Split SQL into top-level statements, tracking $$...$$ so DO blocks stay whole.
function splitStatements(text) {
  const stmts = [];
  let buf = "";
  let inDollar = false;
  for (const line of text.split(/\r?\n/)) {
    let l = line;
    if (!inDollar) {
      const idx = l.indexOf("--");
      if (idx >= 0) l = l.slice(0, idx);
    }
    const dollarCount = (line.match(/\$\$/g) || []).length;
    buf += l + "\n";
    if (dollarCount % 2 === 1) inDollar = !inDollar;
    if (!inDollar) {
      const trimmed = buf.trim();
      if (trimmed.endsWith(";")) {
        const body = trimmed.slice(0, -1).trim();
        if (body) stmts.push(body);
        buf = "";
      }
    }
  }
  const tail = buf.trim();
  if (tail) stmts.push(tail.replace(/;$/, "").trim());
  return stmts.filter(Boolean);
}

const client = await pool.connect();
try {
  for (const rel of FILES) {
    const raw = readFileSync(resolve(migDir, rel), "utf8");
    const stmts = splitStatements(raw);
    console.log(`\n=== ${rel} (${stmts.length} statements) ===`);
    for (const s of stmts) {
      const first = s.split("\n").find((l) => l.trim())?.slice(0, 72) ?? "";
      process.stdout.write(`  RUN: ${first} ... `);
      try {
        await client.query(s);
        console.log("OK");
      } catch (e) {
        // The ADD CONSTRAINT ...fkey steps throw "already exists" on a re-run —
        // treat a duplicate-object as OK so a second run is non-fatal.
        if (/already exists/i.test(e.message)) {
          console.log("SKIP (already exists)");
          continue;
        }
        console.log("ERR");
        console.error(`  >> ${e.message}`);
        process.exit(1);
      }
    }
  }
  console.log("\nPLU-139 MIGRATION APPLIED.");
} finally {
  client.release();
  await pool.end();
}
