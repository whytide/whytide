-- AlterTable
ALTER TABLE "credit_usage" ADD COLUMN     "price_list_version" INTEGER;

-- AlterTable
ALTER TABLE "price_list" ADD COLUMN     "announced_at" TIMESTAMPTZ,
ADD COLUMN     "withdrawn_at" TIMESTAMPTZ;

-- Hand-written (prisma/schema/credits.prisma points here), for the price notice (gamma-p2-060;
-- core/modules/credits/docs/security.md): a price rise waits 30 days as a pending version, which the
-- seeder may withdraw before its date and change in no other way, and every usage row names the
-- version it was charged at.

-- A version in effect is never withdrawn: a withdrawal comes before the version's effective_from.
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_withdrawn_before_effect"
  CHECK ("withdrawn_at" IS NULL OR "withdrawn_at" < "effective_from");

-- `billing_writer` inserts versions and withdraws a pending one: no price of any version changes
-- after it is written. `app`'s UPDATE on credit_usage stays on its four columns (credits_reserve), so
-- a row's price_list_version never changes after the reserve.
REVOKE UPDATE ON TABLE "price_list" FROM billing_writer;
GRANT UPDATE ("withdrawn_at") ON TABLE "price_list" TO billing_writer;

-- The rows written before: the version in effect at each row's created_at (the latest effective_from
-- at or before it, then the highest version), where that version prices the row's action; null
-- otherwise. credit_usage_settle_once refuses any change to a settled row, and credit_usage_balance
-- would rewrite each organization's balance with what it holds: both are off for this one statement,
-- inside the migration's transaction.
ALTER TABLE "credit_usage" DISABLE TRIGGER "credit_usage_settle_once";
ALTER TABLE "credit_usage" DISABLE TRIGGER "credit_usage_balance";
UPDATE "credit_usage" AS u SET "price_list_version" = p."version"
FROM "price_list" AS p
WHERE u."price_list_version" IS NULL AND p."action" = u."action" AND p."version" = (
  SELECT e."version" FROM "price_list" AS e
  WHERE e."withdrawn_at" IS NULL AND e."effective_from" <= u."created_at"
  ORDER BY e."effective_from" DESC, e."version" DESC
  LIMIT 1);
ALTER TABLE "credit_usage" ENABLE TRIGGER "credit_usage_balance";
ALTER TABLE "credit_usage" ENABLE TRIGGER "credit_usage_settle_once";
