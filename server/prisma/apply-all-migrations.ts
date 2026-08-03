// Apply ALL migrations in order — the go-live path (see DEPLOYMENT.md §4).
//
//   npx tsx prisma/apply-all-migrations.ts            # apply every pending file
//   npx tsx prisma/apply-all-migrations.ts --dry-run  # list the plan, touch nothing
//
// Why this exists: there are 20+ migration dirs under prisma/migrations/, and the
// single-file runner (apply-migration.ts) wraps each file in ONE transaction. A file
// that contains `ALTER TYPE ... ADD VALUE` (enum growth) cannot always run inside a
// transaction. This runner handles that automatically:
//
//   • Files WITHOUT `ALTER TYPE ... ADD VALUE` → wrapped in BEGIN/COMMIT (atomic).
//   • Files WITH it → sent as a single un-wrapped query. node-postgres runs a
//     multi-statement string via the simple-query protocol WITHOUT an implicit
//     transaction, so `ALTER TYPE ... ADD VALUE` is permitted. (We deliberately do
//     NOT hand-split the SQL into statements — a naive splitter silently drops
//     lines; sending the whole file verbatim is both simpler and correct.)
//
// Idempotency: applied files are recorded in a _migrations_applied table; re-running
// skips them. DDL only — do not route JS Date params through this (see drizzle.ts).
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/drizzle.js";
import {
  configureMigrationSession,
  migrationSessionConfig,
} from "../src/db/migrationSession.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "migrations");
const CONNECTED_EMAIL_ACCOUNTS_MIGRATION =
  "20260731120000_plu121_connected_email_accounts";
const dryRun = process.argv.includes("--dry-run");

// Migration dirs are named <timestamp>_<slug>; sorting the names sorts by time.
const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const client = await pool.connect();
try {
  const sessionConfig = migrationSessionConfig();
  console.log(
    sessionConfig.hasConfiguredNylasGrant
      ? "[migration config] Legacy Nylas grant will seed the active default email account."
      : "[migration config] NYLAS_GRANT_ID is absent/placeholder; PLU-121 will seed a disabled non-default account.",
  );
  if (!dryRun) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS "_migrations_applied" (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    // Bootstrap: when _migrations_applied is empty but _prisma_migrations exists
    // (e.g. Replit copied dev DB to prod, which tracks via Prisma's own table),
    // pre-populate our tracking table so we don't re-run already-applied migrations.
    const countRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM "_migrations_applied"`,
    );
    if (countRes.rows[0]?.c === "0") {
      const prismaTableExists = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name   = '_prisma_migrations'
         ) AS exists`,
      );
      if (prismaTableExists.rows[0]?.exists) {
        // Pull every successfully-applied migration name from Prisma's table
        const prismaApplied = await client.query<{ migration_name: string }>(
          `SELECT migration_name FROM "_prisma_migrations"
           WHERE finished_at IS NOT NULL
             AND rolled_back_at IS NULL`,
        );
        // Insert only the names that match dirs we know about
        const dirSet = new Set(dirs);
        for (const row of prismaApplied.rows) {
          if (dirSet.has(row.migration_name)) {
            await client.query(
              `INSERT INTO "_migrations_applied" (name) VALUES ($1) ON CONFLICT DO NOTHING`,
              [row.migration_name],
            );
          }
        }
        if (prismaApplied.rows.length > 0) {
          console.log(
            `[bootstrap] Imported ${prismaApplied.rows.length} migration(s) from _prisma_migrations into _migrations_applied.`,
          );
        }
      }
    }
  }

  const appliedRes = dryRun
    ? { rows: [] as { name: string }[] }
    : await client.query<{ name: string }>(`SELECT name FROM "_migrations_applied"`);
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  let count = 0;
  for (const name of dirs) {
    if (applied.has(name)) {
      console.log(`skip (already applied): ${name}`);
      continue;
    }
    const file = resolve(MIGRATIONS_DIR, name, "migration.sql");
    let sql: string;
    try {
      sql = readFileSync(file, "utf8");
    } catch {
      console.log(`skip (no migration.sql): ${name}`);
      continue;
    }

    // Run the file WITHOUT our own transaction wrapper when either:
    //  (a) it adds an enum value (ALTER TYPE ... ADD VALUE) — can't run in a txn, or
    //  (b) it manages its OWN transaction (contains a bare BEGIN) — wrapping it would
    //      nest/close transactions out of order.
    // In both cases node-postgres sends the file as one simple-query batch and lets
    // Postgres handle statement sequencing / the file's own BEGIN…COMMIT.
    const addsEnumValue = /ALTER\s+TYPE[\s\S]*?ADD\s+VALUE/i.test(sql);
    const managesOwnTxn = /^\s*BEGIN\s*;/im.test(sql);
    const needsAutocommit = addsEnumValue || managesOwnTxn;
    const mode = addsEnumValue
      ? "no-wrap (enum add)"
      : managesOwnTxn
        ? "no-wrap (self-managed txn)"
        : "transaction";
    console.log(`${dryRun ? "PLAN" : "apply"}: ${name}  [${mode}]`);
    if (dryRun) {
      count++;
      continue;
    }

    if (needsAutocommit) {
      if (name === CONNECTED_EMAIL_ACCOUNTS_MIGRATION) {
        throw new Error(
          `${name} must run transactionally so its Nylas seed configuration cannot be lost by a pooled connection`,
        );
      }
      // No wrapping transaction: node-postgres sends the whole file via the simple
      // query protocol. Enum-add files autocommit each statement; self-managed-txn
      // files run their own BEGIN…COMMIT. If such a file half-applies on error it is
      // NOT recorded as applied, so a fixed re-run resumes from it (may need manual
      // cleanup of the partially-applied statements first — rare, first-deploy only).
      await client.query(sql);
    } else {
      await client.query("BEGIN");
      try {
        if (name === CONNECTED_EMAIL_ACCOUNTS_MIGRATION) {
          // Neon pooled URLs use transaction-mode PgBouncer. Configure the seed
          // only after BEGIN, on the backend reserved for this exact migration,
          // and make it transaction-local so it cannot leak into a pooled session.
          await configureMigrationSession(client, sessionConfig, true);
        }
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
    await client.query(`INSERT INTO "_migrations_applied" (name) VALUES ($1)`, [name]);
    count++;
  }

  console.log(
    dryRun
      ? `\nDRY RUN — ${count} migration(s) would be applied (of ${dirs.length} total).`
      : `\nDone — ${count} migration(s) applied (of ${dirs.length} total).`,
  );
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
  throw err;
} finally {
  client.release();
  await pool.end();
}
