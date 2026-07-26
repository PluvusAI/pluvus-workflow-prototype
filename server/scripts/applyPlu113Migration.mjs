// One-shot applier + prober for the PLU-113 campaign-creator-memory migration.
//
// ⚠ This project has shipped a table/index/column that silently never landed on
// Neon TWICE (PLU-109, PLU-70) because `migrate deploy` skipped the file and
// _prisma_migrations is unreliable. So we apply the DDL DIRECTLY to Neon here and
// then PROBE the live schema to confirm the table, both enums, the three FKs, and
// both indexes actually exist (§5.1). A green local DB-test run does NOT prove the
// prod schema — the two are applied by different paths.
//
// Mirrors scripts/applyPendingMigrations.mjs: WS Pool driver (DDL needs .query()
// with $$ blocks), statement splitter that keeps DO $$ ... END $$ whole. The
// migration is idempotent (DO/EXCEPTION + IF NOT EXISTS) so a re-run is safe.

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

const migFile = resolve(
  __dirname,
  "../prisma/migrations/20260726120000_plu113_campaign_creator_memory/migration.sql",
);

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
  // --- Apply ---
  const raw = readFileSync(migFile, "utf8");
  const stmts = splitStatements(raw);
  console.log(`=== APPLY plu113 (${stmts.length} statements) ===`);
  for (const s of stmts) {
    const first = s.split("\n").find((l) => l.trim())?.slice(0, 72) ?? "";
    process.stdout.write(`  RUN: ${first} ... `);
    await client.query(s);
    console.log("OK");
  }

  // --- Probe ---
  console.log("\n=== PROBE live schema ===");
  const checks = [];

  const table = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'CampaignCreatorMemory'`,
  );
  checks.push(["table CampaignCreatorMemory", table.rowCount === 1]);

  for (const enumName of ["MemoryFactKey", "MemoryFactStatus"]) {
    const e = await client.query(
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [enumName],
    );
    checks.push([
      `enum ${enumName} (${e.rows.map((r) => r.enumlabel).join(",")})`,
      e.rowCount > 0,
    ]);
  }

  for (const idx of [
    "CampaignCreatorMemory_instanceId_status_idx",
    "CampaignCreatorMemory_live_key",
  ]) {
    const i = await client.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [idx],
    );
    checks.push([`index ${idx}`, i.rowCount === 1]);
  }

  for (const fk of [
    "CampaignCreatorMemory_instanceId_fkey",
    "CampaignCreatorMemory_sourceMessageId_fkey",
    "CampaignCreatorMemory_priorSourceMessageId_fkey",
  ]) {
    const c = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1`,
      [fk],
    );
    checks.push([`fk ${fk}`, c.rowCount === 1]);
  }

  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗ MISSING"}  ${label}`);
    if (!ok) allOk = false;
  }

  console.log(
    allOk
      ? "\nALL PLU-113 SCHEMA OBJECTS CONFIRMED ON NEON."
      : "\n✗ SOME OBJECTS MISSING — investigate before shipping.",
  );
  process.exit(allOk ? 0 : 1);
} catch (e) {
  console.log("ERR");
  console.error(`  >> ${e.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
