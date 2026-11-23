-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "removed_at" TIMESTAMPTZ,
ADD COLUMN     "removed_by" TEXT;

-- Hand-written (prisma/schema/tenancy.prisma points here), for removing a member (gamma-p6-030;
-- core/modules/tenancy/docs/data.md): a removed membership keeps its row, so the ids other tables
-- hold stay valid, with when it was removed and by whom, both set or neither.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_removed_together"
  CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL));
