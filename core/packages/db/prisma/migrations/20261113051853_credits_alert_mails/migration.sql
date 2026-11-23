-- CreateTable
CREATE TABLE "credit_alert_mails" (
    "alert_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mailed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_alert_mails_pkey" PRIMARY KEY ("alert_id","user_id")
);

-- AddForeignKey
ALTER TABLE "credit_alert_mails" ADD CONSTRAINT "credit_alert_mails_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "credit_alerts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (prisma/schema/credits.prisma points here), for the alerts' mail (review-gaps-2;
-- core/modules/credits/docs/security.md): a row per alert and recipient, written by the worker's mail
-- as `app` right after that recipient's send, so that a retry mails only the others. No row changes or
-- goes once written.
REVOKE UPDATE, DELETE ON TABLE "credit_alert_mails" FROM app;
