-- CreateEnum
CREATE TYPE "reply_label" AS ENUM ('positive', 'not_positive');

-- CreateTable
CREATE TABLE "reply_labels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "label" "reply_label" NOT NULL,
    "labeled_by" TEXT NOT NULL,
    "labeled_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reply_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reply_labels_workspace_id_message_id_key" ON "reply_labels"("workspace_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_id_key" ON "messages"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "reply_labels" ADD CONSTRAINT "reply_labels_workspace_id_message_id_fkey" FOREIGN KEY ("workspace_id", "message_id") REFERENCES "messages"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Grants and policy as inbox_initial's tables: the owner's default privileges give app SELECT,
-- INSERT, UPDATE and DELETE (20261021000000_db_roles), which the label's upsert and the erasure's
-- cascade need; no row-level policy before zeta (docs/rules/security.md §3).
