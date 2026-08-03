import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");

export type PGliteMigrationContext = {
  name: string;
  pg: PGlite;
  sql: string;
};

export type PGliteMigrationOptions = {
  beforeMigration?:
    | ((context: PGliteMigrationContext) => Promise<void> | void)
    | undefined;
  migrationsDir?: string | undefined;
};

/**
 * Split PostgreSQL SQL on top-level semicolons.
 *
 * Migration files must be executed statement-by-statement because an
 * `ALTER TYPE ... ADD VALUE` cannot share an implicit transaction with a later
 * statement that uses the value on older PostgreSQL versions. A plain
 * `sql.split(";")`, however, corrupts DO/function bodies. This scanner protects
 * quoted strings and identifiers, tagged or untagged dollar-quoted bodies, and
 * removes line/nested-block comments without treating their semicolons as SQL.
 */
export function splitPostgresStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let dollarDelimiter: string | null = null;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let blockCommentDepth = 0;

  const pushStatement = (): void => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = "";
  };

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (dollarDelimiter !== null) {
      if (sql.startsWith(dollarDelimiter, index)) {
        current += dollarDelimiter;
        index += dollarDelimiter.length - 1;
        dollarDelimiter = null;
      } else {
        current += char;
      }
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index++;
      } else if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        index++;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inLineComment) {
      if (char === "\n") {
        current += "\n";
        inLineComment = false;
      }
      continue;
    }

    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth++;
        index++;
      } else if (char === "*" && next === "/") {
        blockCommentDepth--;
        index++;
        if (blockCommentDepth === 0) current += " ";
      }
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      index++;
      continue;
    }
    if (char === "'") {
      current += char;
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inDoubleQuote = true;
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        current += delimiter;
        index += delimiter.length - 1;
        dollarDelimiter = delimiter;
        continue;
      }
    }
    if (char === ";") {
      pushStatement();
      continue;
    }
    current += char;
  }

  if (dollarDelimiter !== null) {
    throw new Error(`Unterminated PostgreSQL dollar quote ${dollarDelimiter}`);
  }
  if (inSingleQuote) throw new Error("Unterminated PostgreSQL string literal");
  if (inDoubleQuote) throw new Error("Unterminated PostgreSQL quoted identifier");
  if (blockCommentDepth > 0) throw new Error("Unterminated PostgreSQL block comment");

  pushStatement();
  return statements;
}

/** Apply every migration directory in lexical order to an isolated PGlite DB. */
export async function applyPGliteMigrations(
  pg: PGlite,
  options: PGliteMigrationOptions = {},
): Promise<number> {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const folders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of folders) {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
    await options.beforeMigration?.({ name, pg, sql });
    for (const statement of splitPostgresStatements(sql)) {
      await pg.exec(statement);
    }
  }

  return folders.length;
}
