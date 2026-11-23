-- A lead deleted so that the person can be added again (lead-delete-script; privacy's docs/data.md):
-- the erasure reason `lead_deleted`, whose row keeps no hash, as the CHECK erasure_log_reason_hash
-- already holds for every reason but `request`. Expand only: a new enum value, which the previous
-- release never writes or reads.

-- AlterEnum
ALTER TYPE "erasure_reason" ADD VALUE 'lead_deleted';
