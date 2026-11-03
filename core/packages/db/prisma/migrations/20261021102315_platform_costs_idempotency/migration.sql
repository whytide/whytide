-- alpha-p1-055: the platform's cost events and idempotency records (core/packages/platform/cost and
-- idempotency; prisma/schema/platform.prisma). Prisma wrote the statements from the schema. Both are
-- tenant tables that `app` reads and writes through the default privileges of 20261021000000_db_roles,
-- so no grant is needed here; monthly partitions arrive with analytics (gamma).

-- CreateTable
CREATE TABLE "cost_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "task" TEXT,
    "vendor" TEXT NOT NULL,
    "model" TEXT,
    "units" JSONB NOT NULL,
    "unit_cost" DECIMAL(65,30) NOT NULL,
    "credits" DECIMAL(65,30),
    "price_list_version" TEXT NOT NULL,
    "subject_ref" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_events_workspace_id_created_at_idx" ON "cost_events"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "cost_events_workspace_id_subject_ref_idx" ON "cost_events"("workspace_id", "subject_ref");

-- CreateIndex
CREATE INDEX "idempotency_records_workspace_id_created_at_idx" ON "idempotency_records"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_workspace_id_key_key" ON "idempotency_records"("workspace_id", "key");
