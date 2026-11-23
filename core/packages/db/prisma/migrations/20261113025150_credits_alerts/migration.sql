-- CreateTable
CREATE TABLE "credit_alerts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "threshold" INTEGER NOT NULL,
    "used" DECIMAL(65,30) NOT NULL,
    "granted" DECIMAL(65,30) NOT NULL,
    "notified_at" TIMESTAMPTZ,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_alerts_organization_id_period_start_threshold_key" ON "credit_alerts"("organization_id", "period_start", "threshold");

-- Hand-written (prisma/schema/credits.prisma points here), for the credit alerts (gamma-p7-020;
-- core/modules/credits/docs/security.md): a row per organization, period and threshold, written by
-- the worker's check as `app`, which then only marks its mail: notified_at once it went, tries when it
-- failed past its attempts. No row is deleted, and no figure changes once written.
ALTER TABLE "credit_alerts" ADD CONSTRAINT "credit_alerts_threshold"
  CHECK ("threshold" IN (80, 95, 100));
ALTER TABLE "credit_alerts" ADD CONSTRAINT "credit_alerts_tries_non_negative" CHECK ("tries" >= 0);

REVOKE UPDATE, DELETE ON TABLE "credit_alerts" FROM app;
GRANT UPDATE ("notified_at", "tries") ON TABLE "credit_alerts" TO app;
