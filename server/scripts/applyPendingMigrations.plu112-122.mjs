// Idempotent apply of the migrations missing from the live Neon DB.
//
// The live DB's _prisma_migrations ledger is known-unreliable here (manual
// applies were never registered). Several recent migrations were never applied
// at all. `prisma migrate deploy` would abort on the first statement whose
// live-vs-ledger state disagrees. Instead we run each migration's REAL SQL
// statement-by-statement in AUTOCOMMIT (required: `ALTER TYPE ... ADD VALUE`
// cannot run inside a transaction) and swallow ONLY idempotency-class errors,
// so already-applied parts are skipped and genuinely new parts apply. Then we
// register the migration in _prisma_migrations.
//
// Run:  node apply-pending-migrations.mjs           (dry run — lists plan)
//       node apply-pending-migrations.mjs --apply   (execute)

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';

// Resolve paths relative to THIS file (server/scripts/) so the script works
// regardless of the caller's cwd. .env lives at the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../../.env') });

neonConfig.webSocketConstructor = ws;

const APPLY = process.argv.includes('--apply');
const MIG_DIR = resolve(__dirname, '../prisma/migrations');

// Dependency order. Each migration is idempotent-by-execution via the swallow
// list below (some are already written with IF NOT EXISTS / DO-EXCEPTION).
// `session` runs BEFORE the migration's statements, in the same autocommit
// connection, so plu121's seed picks up the real grant instead of a placeholder.
const PLAN = [
  { name: '20260722120000_send_delay_redrive_count' },              // redriveCount (already present → all swallowed)
  { name: '20260725120000_brand_approval_gate' },                   // BrandApproval table + enums
  { name: '20260727120000_brand_approval_processing_and_brandname' },// BrandApproval.brandName + PROCESSING enum value
  {
    name: '20260731120000_plu121_connected_email_accounts',         // ConnectedEmailAccount + emailAccountId cols
    session: [
      `SET LOCAL pluvus.nylas_grant_id = '${(process.env.NYLAS_GRANT_ID || '').replace(/'/g, "''")}'`,
      `SET LOCAL pluvus.nylas_email_address = '${(process.env.NYLAS_EMAIL_ADDRESS || process.env.PLUVUS_FROM_EMAIL || '').replace(/'/g, "''")}'`,
    ],
  },
  { name: '20260731120000_plu122_campaign_outreach_limits' },       // Campaign pacing cols + Message.scheduledFor + OUTREACH_QUEUED enum
  { name: '20260803000000_plu113_campaign_creator_memory' },        // creator-memory tables (already IF NOT EXISTS)
  { name: '20260803120000_plu112_conversation_summary' },           // ConversationSummary table (already IF NOT EXISTS)
  { name: '20260807120000_plu110_negotiation_followup_count' },      // ExecutionInstance.negotiationFollowUpCount (IF NOT EXISTS)
];

// Postgres SQLSTATEs that mean "this part is already applied" — safe to skip.
const IDEMPOTENT_CODES = new Set([
  '42701', // duplicate_column
  '42P07', // duplicate_table / duplicate index (relation already exists)
  '42710', // duplicate_object (enum value, type, constraint, index name)
  '42P16', // invalid_table_definition (some ADD CONSTRAINT dupes)
  '42704', // undefined_object (DROP INDEX of already-gone index)
  '23505', // unique_violation (already-present enum value on some PG versions)
]);

// Dollar-quote-aware statement splitter. Handles `DO $$ ... $$` blocks and
// `$tag$ ... $tag$`; ignores `;` inside them and inside line comments.
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let dollarTag = null; // e.g. '$$' or '$foo$'
  while (i < sql.length) {
    const ch = sql[i];
    // line comment
    if (!dollarTag && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // dollar-quote open/close
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        if (!dollarTag) dollarTag = tag;
        else if (dollarTag === tag) dollarTag = null;
        buf += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === ';' && !dollarTag) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function alreadyRegistered(name) {
  const r = await pool.query(
    `SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL LIMIT 1`,
    [name]
  );
  return r.rowCount > 0;
}

async function run() {
  console.log(APPLY ? '=== APPLY MODE ===\n' : '=== DRY RUN (pass --apply to execute) ===\n');

  for (const step of PLAN) {
    const file = join(MIG_DIR, step.name, 'migration.sql');
    const sql = readFileSync(file, 'utf8');
    const statements = splitStatements(sql);
    const registered = await alreadyRegistered(step.name);

    console.log(`\n▶ ${step.name}`);
    console.log(`  statements: ${statements.length}  registered-in-ledger: ${registered ? 'yes' : 'no'}`);

    if (!APPLY) {
      if (step.session) console.log(`  session: ${step.session.map(s => s.replace(/'[^']*'/, "'***'")).join('; ')}`);
      continue;
    }

    // A dedicated client so SET LOCAL / autocommit semantics are isolated.
    const client = await pool.connect();
    let applied = 0, skipped = 0;
    try {
      // session settings for this migration's seed logic. SET LOCAL only lives
      // inside a tx, so open one JUST for the settings+backfill-free statements
      // is wrong for ALTER TYPE. plu121 has no ALTER TYPE, so we CAN wrap it in a
      // single tx to make SET LOCAL apply. Detect that.
      const hasAlterEnum = /ALTER\s+TYPE\s+"[^"]+"\s+ADD\s+VALUE/i.test(sql);

      if (step.session && !hasAlterEnum) {
        // Wrap the whole migration in one tx so SET LOCAL is honored by the seed.
        // Each statement runs inside its own SAVEPOINT so that swallowing an
        // idempotency error (e.g. duplicate_table on a re-run) rolls back ONLY
        // that statement — without a savepoint the first error poisons the whole
        // tx (25P02: "current transaction is aborted").
        await client.query('BEGIN');
        for (const s of step.session) await client.query(s);
        for (const stmt of statements) {
          await client.query('SAVEPOINT s');
          try {
            await client.query(stmt);
            await client.query('RELEASE SAVEPOINT s');
            applied++;
          } catch (e) {
            if (IDEMPOTENT_CODES.has(e.code)) {
              await client.query('ROLLBACK TO SAVEPOINT s');
              skipped++;
            } else { throw e; }
          }
        }
        await client.query('COMMIT');
      } else {
        // Autocommit, statement-by-statement (required for ALTER TYPE ADD VALUE).
        if (step.session) {
          // SET (not SET LOCAL) at session scope so seed statements still see it.
          for (const s of step.session) await client.query(s.replace(/^SET\s+LOCAL/i, 'SET'));
        }
        for (const stmt of statements) {
          try {
            await client.query(stmt);
            applied++;
          } catch (e) {
            if (IDEMPOTENT_CODES.has(e.code)) { skipped++; }
            else {
              console.error(`  ✗ statement failed (code ${e.code}): ${e.message}`);
              console.error(`    ${stmt.slice(0, 120).replace(/\s+/g, ' ')}...`);
              throw e;
            }
          }
        }
      }

      // Register in the ledger (idempotent on migration_name via delete+insert of unfinished dupes).
      if (!registered) {
        const checksum = createHash('sha256').update(sql).digest('hex');
        await client.query(
          `INSERT INTO _prisma_migrations
             (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count)
           VALUES ($1, $2, now(), $3, NULL, now(), $4)`,
          [randomUUID(), checksum, step.name, applied]
        );
      }
      console.log(`  ✓ applied=${applied} skipped(idempotent)=${skipped}${registered ? ' (ledger already had it)' : ' (registered)'}`);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error(`  ✗ ABORTED on ${step.name}: ${e.message}`);
      client.release();
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('\n=== done ===');
}

run().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
