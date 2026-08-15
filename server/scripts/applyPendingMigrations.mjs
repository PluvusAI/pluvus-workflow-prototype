// One-shot applier for the three migrations missing from the live Neon DB:
//   1. 20260721160000_plu70_operator_handoff        (NOT idempotent: raw ADD VALUE/ADD COLUMN)
//   2. 20260722120000_send_delay_redrive_count      (idempotent: ADD COLUMN IF NOT EXISTS)
//   3. 20260722140000_plu111_conversation_obligations (idempotent: DO $$ / IF NOT EXISTS)
//
// The repo has no migration runner and no _migrations_applied table — SQL is
// applied directly to Neon (see memory). This script splits each file into
// statements, correctly treating $$-dollar-quoted DO blocks as single
// statements, then executes them in order against DATABASE_URL.
//
// Postgres forbids ALTER TYPE ... ADD VALUE inside a multi-statement
// transaction that also USES the value, and neon()'s tagged template auto-wraps
// nothing here — we send each statement as its own round-trip via sql.query,
// so each ADD VALUE commits on its own. That is exactly what the PLU-70
// migration needs.

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
// The HTTP neon() helper only takes tagged templates; DDL needs the WS Pool
// driver, whose .query() accepts an arbitrary SQL string (incl. $$ blocks).
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const migDir = resolve(__dirname, "../prisma/migrations");
const FILES = [
  // 2026-08-14: the three PLU-139 migrations that drifted out of sync with the
  // Drizzle schema — `select()` in getCampaignDetailsByCampaignIds 42703'd on
  // each new column in turn. All idempotent (ADD/DROP COLUMN IF [NOT] EXISTS),
  // listed in order, so re-running an already-applied one is harmless.
  "20260814120000_plu139_worksheet_stage1_fields/migration.sql", // +20 Stage-1 cols
  "20260814130000_plu139_drop_offworksheet_fields/migration.sql", // -6 off-worksheet cols
  "20260814140000_plu139_product_name/migration.sql", // +productName (S2.3)
  "20260814150000_plu139_page5_page6_fields/migration.sql", // +5 Page-5/6 cols (S5.2/4/5/6, S6.3)
  "20260814160000_plu139_pricing_ranges_mode/migration.sql", // +3 cols (S7.P1 pricing, S3.11 ranges, S7.A1 mode)
];

// Split SQL into top-level statements. Tracks $$...$$ dollar-quoting so the
// DO $$ ... END $$ blocks (which contain their own semicolons) stay whole.
// Line comments (-- ...) are stripped so they don't get sent as statements.
function splitStatements(text) {
  const noBlockComments = text; // no /* */ blocks in these files
  const stmts = [];
  let buf = "";
  let inDollar = false;
  const lines = noBlockComments.split(/\r?\n/);
  for (const line of lines) {
    // strip a full-line comment; keep inline SQL before a trailing -- only if
    // not inside a dollar block (our files never put -- inside $$)
    let l = line;
    if (!inDollar) {
      const idx = l.indexOf("--");
      if (idx >= 0) l = l.slice(0, idx);
    }
    // toggle dollar-quote state on each $$ occurrence in this line
    const dollarCount = (line.match(/\$\$/g) || []).length;
    buf += l + "\n";
    if (dollarCount % 2 === 1) inDollar = !inDollar;

    if (!inDollar) {
      // flush completed statements ending in ; at line end
      let rest = buf;
      // Only split on a semicolon that ends a statement when NOT in a dollar block.
      // Simple approach: if the trimmed accumulated buffer ends with ';', flush.
      const trimmed = rest.trim();
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
    const full = resolve(migDir, rel);
    const raw = readFileSync(full, "utf8");
    const stmts = splitStatements(raw);
    console.log(`\n=== ${rel} (${stmts.length} statements) ===`);
    for (const s of stmts) {
      const first = s.split("\n").find((l) => l.trim())?.slice(0, 72) ?? "";
      process.stdout.write(`  RUN: ${first} ... `);
      try {
        await client.query(s);
        console.log("OK");
      } catch (e) {
        console.log("ERR");
        console.error(`  >> ${e.message}`);
        process.exit(1);
      }
    }
  }
  console.log("\nALL MIGRATIONS APPLIED.");
} finally {
  client.release();
  await pool.end();
}
