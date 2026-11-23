-- CreateEnum
CREATE TYPE "playbook_paused_reason" AS ENUM ('user', 'member_removed');

-- AlterTable
ALTER TABLE "playbooks" ADD COLUMN     "paused_reason" "playbook_paused_reason";


-- Hand-written (playbooks' docs/data.md, gamma-p6-075). An agent paused before this migration was
-- paused by a member, through the PATCH: it keeps that pause as the member's.
UPDATE "playbooks" SET "paused_reason" = 'user' WHERE "status" = 'paused';

-- paused_reason is set exactly while the agent is paused: a member's pause, or its owner's removal
-- from the workspace, which only that owner, a member again, resumes.
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_paused_reason" CHECK (
  ("paused_reason" IS NOT NULL) = ("status" = 'paused')
);
