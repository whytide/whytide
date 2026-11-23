-- CreateEnum
CREATE TYPE "playbook_status" AS ENUM ('active', 'paused', 'archived');

-- CreateTable
CREATE TABLE "playbooks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icp_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "status" "playbook_status" NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook_sources" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "playbook_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbook_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "playbooks_workspace_id_status_idx" ON "playbooks"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "playbooks_workspace_id_id_key" ON "playbooks"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "playbook_sources_workspace_id_playbook_id_idx" ON "playbook_sources"("workspace_id", "playbook_id");

-- CreateIndex
CREATE UNIQUE INDEX "playbook_sources_workspace_id_source_id_key" ON "playbook_sources"("workspace_id", "source_id");

-- AddForeignKey
ALTER TABLE "playbook_sources" ADD CONSTRAINT "playbook_sources_workspace_id_playbook_id_fkey" FOREIGN KEY ("workspace_id", "playbook_id") REFERENCES "playbooks"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (playbooks' docs/data.md). One live agent per audience: a partial unique key, which
-- Prisma's schema cannot say; an archived agent frees its audience. Two creates or audience changes
-- that race past the commands' checks meet here, answered as playbook_icp_in_use.
CREATE UNIQUE INDEX "playbooks_live_icp" ON "playbooks"("workspace_id", "icp_id") WHERE "status" <> 'archived';

-- archived_at is set exactly when the agent is archived, which is final.
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_archived_at" CHECK (
  ("archived_at" IS NOT NULL) = ("status" = 'archived')
);

-- No grant of their own: app reads and writes both tables through the roles migration's default
-- privileges, as alpha's tenant tables do. No person data, so no eraser needs them.
