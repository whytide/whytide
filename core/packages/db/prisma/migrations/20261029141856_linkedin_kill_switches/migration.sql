-- CreateEnum
CREATE TYPE "linkedin_switch_source" AS ENUM ('tester', 'operator');

-- CreateEnum
CREATE TYPE "linkedin_control_scope" AS ENUM ('platform', 'workspace', 'account');

-- CreateEnum
CREATE TYPE "linkedin_control" AS ENUM ('sending', 'stop', 'invites');

-- CreateEnum
CREATE TYPE "linkedin_control_actor_type" AS ENUM ('user', 'operator', 'system');

-- AlterTable
ALTER TABLE "sender_accounts" ADD COLUMN     "kill_switch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kill_switch_source" "linkedin_switch_source";

-- CreateTable
CREATE TABLE "linkedin_platform_controls" (
    "id" TEXT NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "sending_open" BOOLEAN NOT NULL DEFAULT false,
    "stopped" BOOLEAN NOT NULL DEFAULT false,
    "invites_paused" BOOLEAN NOT NULL DEFAULT false,
    "invites_paused_reason" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "linkedin_platform_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_workspace_controls" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "stopped" BOOLEAN NOT NULL DEFAULT false,
    "stop_source" "linkedin_switch_source",
    "changed_by" TEXT,
    "changed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "linkedin_workspace_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_control_events" (
    "id" TEXT NOT NULL,
    "scope" "linkedin_control_scope" NOT NULL,
    "target_workspace_id" TEXT,
    "sender_account_id" TEXT,
    "control" "linkedin_control" NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "actor_type" "linkedin_control_actor_type" NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "linkedin_control_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_platform_controls_singleton_key" ON "linkedin_platform_controls"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_workspace_controls_workspace_id_key" ON "linkedin_workspace_controls"("workspace_id");

-- CreateIndex
CREATE INDEX "linkedin_control_events_target_workspace_id_at_idx" ON "linkedin_control_events"("target_workspace_id", "at");

-- Hand-written (prisma/schema/linkedin.prisma points here). The platform's switches are one row at
-- most: `singleton` is always true and unique. A database with no row reads as sending closed and
-- nothing stopped, so app may insert and update the row but never delete it: a deleted row would
-- lift a platform stop.
ALTER TABLE "linkedin_platform_controls" ADD CONSTRAINT "linkedin_platform_controls_singleton" CHECK ("singleton");
REVOKE DELETE ON TABLE "linkedin_platform_controls" FROM app;

-- A stop's source, the tester's or the operator's, is set exactly while the stop is on.
ALTER TABLE "linkedin_workspace_controls" ADD CONSTRAINT "linkedin_workspace_controls_stop_source" CHECK (("stop_source" IS NOT NULL) = "stopped");
ALTER TABLE "sender_accounts" ADD CONSTRAINT "sender_accounts_kill_switch_source" CHECK (("kill_switch_source" IS NOT NULL) = "kill_switch");

-- The control events are append-only for app (docs/security.md): it inserts and reads them, never
-- changes or deletes one.
REVOKE UPDATE, DELETE ON TABLE "linkedin_control_events" FROM app;
