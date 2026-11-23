-- CreateEnum
CREATE TYPE "erasure_reason" AS ENUM ('request', 'retention_never_contacted');

-- AlterTable
ALTER TABLE "erasure_log" ADD COLUMN     "reason" "erasure_reason" NOT NULL DEFAULT 'request',
ALTER COLUMN "person_hash" DROP NOT NULL;

-- A request's row keeps the person's erased hash; a deletion of the 30-day rule keeps none (privacy's
-- docs/data.md). The grants stay: app reads and inserts, and never changes or removes a row.
ALTER TABLE "erasure_log" ADD CONSTRAINT "erasure_log_reason_hash" CHECK (("reason" = 'request') = ("person_hash" IS NOT NULL));
