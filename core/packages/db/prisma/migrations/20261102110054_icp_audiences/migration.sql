-- DropIndex
DROP INDEX "icps_workspace_id_key";

-- AlterTable
ALTER TABLE "icps" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "icps_workspace_id_updated_at_idx" ON "icps"("workspace_id", "updated_at");

-- Hand-written (gamma-p3-020): one default audience per workspace, a partial unique key that Prisma's
-- schema cannot say. Every row here is its workspace's only one and true by the column's default, so
-- the index holds from the start. A first read inserts the default with ON CONFLICT DO NOTHING: of
-- two at once, the second waits on this index for the first's commit, skips its insert and reads that
-- row; so does the insert of the release before this one, which leaves is_default to its default.
CREATE UNIQUE INDEX "icps_default" ON "icps"("workspace_id") WHERE "is_default";
