/**
 * Values made available to SQL migrations through PostgreSQL custom settings.
 *
 * They are applied with parameterized `set_config` calls, so values containing
 * quotes can never alter the migration query. Production runners request
 * transaction-local settings after BEGIN, which also works through PgBouncer's
 * transaction pooling; PGlite tests may use the default session scope. An empty
 * value deliberately remains empty: PLU-121 converts it (and its explicit
 * sentinel) to a disabled, non-default placeholder.
 */

export const UNCONFIGURED_NYLAS_GRANT_ID = "UNCONFIGURED_DEFAULT_GRANT";

export type MigrationEnvironment = {
  NYLAS_GRANT_ID?: string | undefined;
  NYLAS_EMAIL_ADDRESS?: string | undefined;
};

export type MigrationSessionConfig = {
  nylasGrantId: string;
  nylasEmailAddress: string;
  hasConfiguredNylasGrant: boolean;
};

type QueryClient = {
  query(queryText: string, values?: unknown[]): Promise<unknown>;
};

export function migrationSessionConfig(
  env: MigrationEnvironment = process.env,
): MigrationSessionConfig {
  const nylasGrantId = env.NYLAS_GRANT_ID?.trim() ?? "";
  const nylasEmailAddress = env.NYLAS_EMAIL_ADDRESS?.trim() ?? "";

  return {
    nylasGrantId,
    nylasEmailAddress,
    hasConfiguredNylasGrant:
      nylasGrantId !== "" && nylasGrantId !== UNCONFIGURED_NYLAS_GRANT_ID,
  };
}

export async function configureMigrationSession(
  client: QueryClient,
  config: MigrationSessionConfig = migrationSessionConfig(),
  transactionLocal = false,
): Promise<void> {
  await client.query(
    `SELECT
       set_config('pluvus.nylas_grant_id', $1, $3::boolean),
       set_config('pluvus.nylas_email_address', $2, $3::boolean)`,
    [config.nylasGrantId, config.nylasEmailAddress, transactionLocal],
  );
}
