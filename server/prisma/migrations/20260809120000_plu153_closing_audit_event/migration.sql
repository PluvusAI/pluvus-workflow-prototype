-- PLU-153: add the CLOSING campaign-lifecycle audit event type.
-- Idempotent; inert until the ACTIVE → CLOSING transition writes it.
ALTER TYPE "CampaignAuditEventType" ADD VALUE IF NOT EXISTS 'CLOSING';
