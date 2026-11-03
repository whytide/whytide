-- alpha-p1-050: the outbox table of core/packages/platform (docs/architecture.md §4.3 rule 4, §7.6):
-- a module's change and its event row commit together, and the worker delivers the row later
-- (prisma/schema/platform.prisma). Prisma wrote the statements; `app` reads and writes the table
-- through the default privileges of 20261021000000_db_roles.
-- CreateTable
CREATE TABLE "outbox" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dead_at" TIMESTAMPTZ,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_workspace_id_created_at_idx" ON "outbox"("workspace_id", "created_at");

-- CreateIndex: the claim's index (core/packages/platform/outbox): the worker's poll reads the due rows by
-- these three across every workspace, and would scan the table on every poll without it.
CREATE INDEX "outbox_delivered_at_dead_at_next_attempt_at_idx" ON "outbox"("delivered_at", "dead_at", "next_attempt_at");
