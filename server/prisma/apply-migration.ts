// One-off migration runner for the Drizzle era (the Prisma CLI is no longer a
// dependency, but the live Neon schema is still owned by the SQL files in
// prisma/migrations). Executes a single migration.sql inside a transaction:
//
//   npx tsx prisma/apply-migration.ts prisma/migrations/<dir>/migration.sql
//
// DDL only — do not pass JS Date parameters through this path (see the
// timestamp caveat in src/db/drizzle.ts).
//
// Note: a migration whose SQL cannot run in a transaction (e.g. ALTER TYPE ...
// ADD VALUE on older Postgres) should be applied statement-by-statement by
// hand instead.
import { readFileSync } from "node:fs";
import { pool } from "../src/db/drizzle.js";
import {
  configureMigrationSession,
  migrationSessionConfig,
} from "../src/db/migrationSession.js";

const target = process.argv[2];
if (!target) {
  console.error("usage: npx tsx prisma/apply-migration.ts <path-to-migration.sql>");
  process.exit(1);
}

const sql = readFileSync(target, "utf8");
const client = await pool.connect();
try {
  const sessionConfig = migrationSessionConfig();
  console.log(
    sessionConfig.hasConfiguredNylasGrant
      ? "[migration config] Legacy Nylas grant will seed the active default email account."
      : "[migration config] NYLAS_GRANT_ID is absent/placeholder; PLU-121 will seed a disabled non-default account.",
  );
  await client.query("BEGIN");
  // This must happen after BEGIN: a transaction-mode pooled URL can switch
  // backend sessions between standalone statements. Transaction-local settings
  // are guaranteed to be visible to the migration query that follows.
  await configureMigrationSession(client, sessionConfig, true);
  await client.query(sql);
  await client.query("COMMIT");
  console.log(`applied: ${target}`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`FAILED (rolled back): ${target}`);
  throw err;
} finally {
  client.release();
  await pool.end();
}
