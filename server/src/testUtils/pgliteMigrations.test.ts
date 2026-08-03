import assert from "node:assert/strict";
import { test } from "node:test";
import { splitPostgresStatements } from "./pgliteMigrations.js";

test("splitPostgresStatements preserves dollar-quoted bodies and quoted semicolons", () => {
  const statements = splitPostgresStatements(`
    -- prose; is not a statement
    CREATE TABLE "odd;name" (value TEXT DEFAULT 'semi;colon');
    DO $body$
    BEGIN
      PERFORM 'inside;body';
      /* outer; /* nested; */ still comment; */
      PERFORM 1;
    END
    $body$;
    DO $$ BEGIN PERFORM 2; END $$;
  `);

  assert.equal(statements.length, 3);
  assert.match(statements[0]!, /CREATE TABLE "odd;name"/);
  assert.match(statements[1]!, /PERFORM 'inside;body';/);
  assert.match(statements[2]!, /DO \$\$ BEGIN PERFORM 2; END \$\$/);
});

test("splitPostgresStatements rejects an unterminated dollar quote", () => {
  assert.throws(
    () => splitPostgresStatements("DO $migration$ BEGIN PERFORM 1;"),
    /Unterminated PostgreSQL dollar quote \$migration\$/,
  );
});
