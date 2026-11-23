-- gamma-p5-050: each lead is assessed against the audience of the agent that found it, so a snapshot
-- and an attempt name the audience (icp's id) beside its version. The rows written before audiences
-- were assessed against the workspace's default audience, which every workspace with a snapshot has
-- (an assessment reads it first, and that read creates it).

-- DropIndex
DROP INDEX "score_snapshots_workspace_id_decision_record_id_icp_version_key";

-- AlterTable
ALTER TABLE "score_snapshots" ADD COLUMN     "icp_id" TEXT;

UPDATE "score_snapshots" AS "snapshot" SET "icp_id" = "icp"."id"
  FROM "icps" AS "icp"
  WHERE "icp"."workspace_id" = "snapshot"."workspace_id" AND "icp"."is_default";

-- CreateIndex
CREATE UNIQUE INDEX "score_snapshots_workspace_id_decision_record_id_icp_id_icp__key" ON "score_snapshots"("workspace_id", "decision_record_id", "icp_id", "icp_version", "criteria_hash");

-- The attempt's key gains the audience: added empty, filled with the default's, then required. A row
-- whose workspace has no default (none should) goes: it only counted a lead's attempts under the key
-- of before, which no new reservation uses.
ALTER TABLE "assessment_attempts" ADD COLUMN "icp_id" TEXT;
UPDATE "assessment_attempts" AS "attempt" SET "icp_id" = "icp"."id"
  FROM "icps" AS "icp"
  WHERE "icp"."workspace_id" = "attempt"."workspace_id" AND "icp"."is_default";
DELETE FROM "assessment_attempts" WHERE "icp_id" IS NULL;
ALTER TABLE "assessment_attempts" ALTER COLUMN "icp_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "assessment_attempts" DROP CONSTRAINT "assessment_attempts_pkey",
ADD CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("workspace_id", "person_id", "icp_id", "icp_version");

-- Hand-written (prisma/schema/qualification.prisma points here). The previous release inserts
-- snapshots and attempts without the column while an upgrade runs (architecture §7.6): it knows the
-- default audience only, so the row takes the workspace's default, as the backfill does. A later
-- release drops the triggers once no running release omits the column.
CREATE FUNCTION qualification_default_icp_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.icp_id := (SELECT "id" FROM "icps"
    WHERE "workspace_id" = NEW.workspace_id AND "is_default");
  RETURN NEW;
END
$$;
CREATE TRIGGER "score_snapshots_default_icp_id" BEFORE INSERT ON "score_snapshots"
  FOR EACH ROW WHEN (NEW.icp_id IS NULL) EXECUTE FUNCTION qualification_default_icp_id();
CREATE TRIGGER "assessment_attempts_default_icp_id" BEFORE INSERT ON "assessment_attempts"
  FOR EACH ROW WHEN (NEW.icp_id IS NULL) EXECUTE FUNCTION qualification_default_icp_id();
