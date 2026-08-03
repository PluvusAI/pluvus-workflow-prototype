-- Content submission & manual review: add the two vocabulary values for the
-- post-payout content-links flow.
--
--   InstanceState += CONTENT_LINKS_PENDING   -- non-terminal waiting state the
--       merged Content Brief node parks on after the payout form, awaiting the
--       creator's in-thread content-links reply.
--   EventType += CONTENT_LINKS_SUBMITTED      -- append-only record carrying the
--       extracted content URLs; drives the escalation to MANUAL_REVIEW.
--
-- Pure additive enum changes (ALTER TYPE ... ADD VALUE) — appended last so the
-- physical order matches the schema, and no data migration is needed (no existing
-- row can already hold either value). Applied to the live DB out-of-band via
-- scripts/add-content-links-enums.ts (idempotent); recorded here so the Prisma
-- migration history and the PGlite-backed tests build the same enum.
--
-- Idempotent: IF NOT EXISTS so a partial prior run does not fail a re-run.

-- AlterEnum
ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'CONTENT_LINKS_PENDING';

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'CONTENT_LINKS_SUBMITTED';
