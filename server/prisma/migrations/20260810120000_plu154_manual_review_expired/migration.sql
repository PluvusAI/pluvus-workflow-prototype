-- PLU-154: resolve + time out MANUAL_REVIEW creator cases.
-- Idempotent; inert until the timeout sweep / resolution routes write these values.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction on real Postgres/Neon,
-- so this file contains only ADD VALUE statements (no BEGIN/COMMIT) — same shape as
-- 20260809120000_plu153_closing_audit_event.
ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW_RESOLVED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW_EXPIRED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW_NUDGED';
