-- CreateTable
CREATE TABLE "icps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "titles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seniorities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "size_ranges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "must_haves" TEXT NOT NULL DEFAULT '',
    "disqualifiers" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "icps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "criteria" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "icp_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "is_must" BOOLEAN NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "criteria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "icps_workspace_id_key" ON "icps"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "criteria_workspace_id_icp_id_key_key" ON "criteria"("workspace_id", "icp_id", "key");

-- AddForeignKey
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_icp_id_fkey" FOREIGN KEY ("icp_id") REFERENCES "icps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
