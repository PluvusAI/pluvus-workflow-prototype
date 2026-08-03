-- PLU-121: multi-mailbox support for the Nylas integration.
--
-- Introduces a first-class connected-email-account entity so the deployment can
-- send from, and receive on, more than one Nylas grant instead of the single
-- process-wide NYLAS_GRANT_ID. The shared campaign / workflow / negotiation /
-- follow-up logic is untouched — an account reference is threaded UNDER it:
--   * Campaign.emailAccountId          — the brand's chosen default sender.
--   * ExecutionInstance.emailAccountId — the account this run is PINNED to
--                                        (stamped once at enrollment, like
--                                        postAcceptanceMode), so an entire
--                                        conversation stays on one mailbox.
--   * Message.emailAccountId           — which mailbox the message was sent
--                                        from / received on (attribution).
--
-- Backfill: every existing campaign, execution instance, and message references
-- one seed row. A deployment may supply its current grant through the custom
-- PostgreSQL setting `pluvus.nylas_grant_id`; the bundled migration runners set
-- it from NYLAS_GRANT_ID before executing this file. That produces an active
-- default account and keeps every existing conversation on its legacy mailbox.
-- When the setting is absent (for example, a mock-provider dev DB), the seed is a
-- disabled, non-default placeholder. No existing row is left dangling.
--
-- No raw credentials are stored: only the Nylas GRANT id (an opaque per-mailbox
-- handle) and the mailbox address live here. The application API key stays an
-- env value shared across grants (single Nylas application, many grants).

-- CreateTable
CREATE TABLE "ConnectedEmailAccount" (
    "id" TEXT NOT NULL,
    "nylasGrantId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'nylas',
    "status" TEXT NOT NULL DEFAULT 'active',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedEmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedEmailAccount_nylasGrantId_key" ON "ConnectedEmailAccount"("nylasGrantId");

-- CreateIndex
CREATE INDEX "ConnectedEmailAccount_status_idx" ON "ConnectedEmailAccount"("status");

-- At most one default account (partial unique index over the default rows).
CREATE UNIQUE INDEX "ConnectedEmailAccount_isDefault_key" ON "ConnectedEmailAccount"("isDefault") WHERE "isDefault" = true;

-- AlterTable — add the (nullable) account references.
ALTER TABLE "Campaign" ADD COLUMN "emailAccountId" TEXT;
ALTER TABLE "ExecutionInstance" ADD COLUMN "emailAccountId" TEXT;
ALTER TABLE "Message" ADD COLUMN "emailAccountId" TEXT;

-- Seed from the optional migration-session settings and backfill every existing
-- row to the result, so multi-account is purely additive for existing data.
-- current_setting(..., true) returns NULL rather than erroring when unset. A
-- missing grant produces a reconcilable placeholder row, but it must NOT become
-- an active/default sender: doing so would route production mail through a fake
-- grant until the seed was explicitly reconciled.
WITH migration_config AS (
    SELECT
        NULLIF(
            NULLIF(BTRIM(current_setting('pluvus.nylas_grant_id', true)), ''),
            'UNCONFIGURED_DEFAULT_GRANT'
        ) AS grant_id,
        NULLIF(BTRIM(current_setting('pluvus.nylas_email_address', true)), '') AS email_address
)
INSERT INTO "ConnectedEmailAccount" ("id", "nylasGrantId", "emailAddress", "displayName", "provider", "status", "isDefault", "updatedAt")
SELECT
    'seed_default_email_account',
    COALESCE(grant_id, 'UNCONFIGURED_DEFAULT_GRANT'),
    COALESCE(email_address, 'default@pluvus.local'),
    'Default mailbox',
    'nylas',
    CASE WHEN grant_id IS NULL THEN 'disabled' ELSE 'active' END,
    grant_id IS NOT NULL,
    CURRENT_TIMESTAMP
FROM migration_config;

UPDATE "Campaign" SET "emailAccountId" = 'seed_default_email_account' WHERE "emailAccountId" IS NULL;
UPDATE "ExecutionInstance" SET "emailAccountId" = 'seed_default_email_account' WHERE "emailAccountId" IS NULL;
UPDATE "Message" SET "emailAccountId" = 'seed_default_email_account' WHERE "emailAccountId" IS NULL;

-- CreateIndex
CREATE INDEX "Campaign_emailAccountId_idx" ON "Campaign"("emailAccountId");
CREATE INDEX "ExecutionInstance_emailAccountId_idx" ON "ExecutionInstance"("emailAccountId");
CREATE INDEX "Message_emailAccountId_idx" ON "Message"("emailAccountId");

-- Nylas message ids are scoped to a grant. The original single-mailbox schema
-- enforced global uniqueness, which makes account B's message collide with an
-- unrelated account A message carrying the same provider-local id. Replace it
-- with one namespace per account. Account-less legacy/mock rows retain their
-- original dedupe guarantee in a dedicated partial unique namespace.
DROP INDEX "Message_externalMessageId_key";
CREATE UNIQUE INDEX "Message_emailAccountId_externalMessageId_key"
    ON "Message"("emailAccountId", "externalMessageId");
CREATE UNIQUE INDEX "Message_legacyExternalMessageId_key"
    ON "Message"("externalMessageId")
    WHERE "emailAccountId" IS NULL AND "externalMessageId" IS NOT NULL;

-- AddForeignKey. Campaign/run selections may clear when an unused account is
-- deleted. Message attribution is RESTRICTED: collapsing account-scoped provider
-- ids into the legacy NULL namespace can collide and would erase the durable
-- mailbox audit trail. Connected accounts with history are disabled/revoked,
-- never deleted.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "ConnectedEmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionInstance" ADD CONSTRAINT "ExecutionInstance_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "ConnectedEmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "ConnectedEmailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
