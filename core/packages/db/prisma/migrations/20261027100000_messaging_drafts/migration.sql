-- CreateEnum
CREATE TYPE "message_channel" AS ENUM ('linkedin_note', 'linkedin_message');

-- CreateEnum
CREATE TYPE "message_draft_status" AS ENUM ('drafting', 'ready', 'flagged', 'failed', 'edited');

-- CreateTable
CREATE TABLE "message_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "channel" "message_channel" NOT NULL,
    "status" "message_draft_status" NOT NULL DEFAULT 'drafting',
    "plan" JSONB,
    "text" TEXT,
    "edited_text" TEXT,
    "edited_at" TIMESTAMPTZ,
    "model_id" TEXT,
    "prompt_version" INTEGER,
    "decision_record_id" TEXT,
    "dossier_hash" TEXT,
    "gates" JSONB NOT NULL DEFAULT '[]',
    "regenerations" INTEGER NOT NULL DEFAULT 0,
    "flag_reasons" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_drafts_workspace_id_person_id_created_at_idx" ON "message_drafts"("workspace_id", "person_id", "created_at");
