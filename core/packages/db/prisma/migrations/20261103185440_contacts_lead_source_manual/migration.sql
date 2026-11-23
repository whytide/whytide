-- A member adds a lead by hand (lead-manual-create; contacts' docs/data.md): the lead's source kind
-- `manual`. Expand only: a new enum value, which the previous release never writes or reads.

-- AlterEnum
ALTER TYPE "lead_source_kind" ADD VALUE 'manual';
