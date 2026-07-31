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
-- Backfill: every existing campaign, execution instance, and message is pinned
-- to a single seeded "default" ConnectedEmailAccount created from the current
-- NYLAS_GRANT_ID, so all in-flight runs keep sending/receiving on exactly the
-- mailbox they already used. When NYLAS_GRANT_ID is unset at migration time
-- (e.g. a mock-provider dev DB) the seed row uses a placeholder grant id that an
-- operator can later reconcile; no existing row is left dangling.
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
    "webhookSecret" TEXT,
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

-- Seed the default account from the current single grant and backfill every
-- existing row to it, so multi-account is purely additive for existing data.
-- current_setting(..., true) returns NULL rather than erroring when unset; the
-- COALESCE falls back to a reconcilable placeholder grant id.
INSERT INTO "ConnectedEmailAccount" ("id", "nylasGrantId", "emailAddress", "displayName", "provider", "status", "isDefault", "updatedAt")
VALUES (
    'seed_default_email_account',
    COALESCE(NULLIF(current_setting('pluvus.nylas_grant_id', true), ''), 'UNCONFIGURED_DEFAULT_GRANT'),
    COALESCE(NULLIF(current_setting('pluvus.nylas_email_address', true), ''), 'default@pluvus.local'),
    'Default mailbox',
    'nylas',
    'active',
    true,
    CURRENT_TIMESTAMP
);

UPDATE "Campaign" SET "emailAccountId" = 'seed_default_email_account' WHERE "emailAccountId" IS NULL;
UPDATE "ExecutionInstance" SET "emailAccountId" = 'seed_default_email_account' WHERE "emailAccountId" IS NULL;
UPDATE "Message" SET "emailAccountId" = 'seed_default_email_account' WHERE "emailAccountId" IS NULL;

-- CreateIndex
CREATE INDEX "Campaign_emailAccountId_idx" ON "Campaign"("emailAccountId");
CREATE INDEX "ExecutionInstance_emailAccountId_idx" ON "ExecutionInstance"("emailAccountId");
CREATE INDEX "Message_emailAccountId_idx" ON "Message"("emailAccountId");

-- AddForeignKey — ON DELETE SET NULL so disconnecting an account never destroys
-- historical campaigns/runs/messages; they simply lose the (now-stale) pointer.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "ConnectedEmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionInstance" ADD CONSTRAINT "ExecutionInstance_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "ConnectedEmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "ConnectedEmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
