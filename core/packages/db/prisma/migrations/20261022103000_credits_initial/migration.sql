-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('active', 'cancelled');

-- CreateEnum
CREATE TYPE "credit_usage_status" AS ENUM ('reserved', 'committed', 'released', 'expired');

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_allowance" DECIMAL(65,30) NOT NULL,
    "is_fixed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'active',
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_grants" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "reason" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_usage" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "credits" DECIMAL(65,30) NOT NULL,
    "status" "credit_usage_status" NOT NULL DEFAULT 'reserved',
    "idempotency_key" TEXT NOT NULL,
    "lease_expires_at" TIMESTAMPTZ NOT NULL,
    "subject_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ,

    CONSTRAINT "credit_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_balances" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "granted" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "committed" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "credits" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grants_organization_id_reason_period_start_key" ON "credit_grants"("organization_id", "reason", "period_start");

-- CreateIndex
CREATE INDEX "credit_usage_workspace_id_created_at_idx" ON "credit_usage"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_usage_workspace_id_organization_id_idempotency_key_key" ON "credit_usage"("workspace_id", "organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_balances_organization_id_key" ON "credit_balances"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_action_version_key" ON "price_list"("action", "version");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (prisma/schema/credits.prisma points here; architecture §6 and §10, docs/15 §11): the
-- grants, the balance triggers and credits_seed_self_hosted. The DO block at the end pins every
-- function's search_path to this migration's schema with pg_temp last, so that a temporary table of
-- the caller's session never stands in for a credits table inside a SECURITY DEFINER function.

-- The roles migration gives `app` every table: here it keeps SELECT on the six and INSERT and UPDATE
-- on credit_usage only; `billing_writer` writes plans, subscriptions, grants and prices. Nobody
-- deletes, the ledgers being append-only; credit_balances is written by the triggers alone.
REVOKE INSERT, UPDATE, DELETE ON TABLE "plans", "subscriptions", "credit_grants", "credit_balances", "price_list" FROM app;
REVOKE DELETE ON TABLE "credit_usage" FROM app;
GRANT SELECT, INSERT, UPDATE ON TABLE "plans", "subscriptions", "credit_grants", "price_list" TO billing_writer;

-- An id in the platform's format, <prefix>_<ULID> (core/packages/platform/ids): 48 bits of
-- milliseconds and 80 random bits in Crockford base32, for the rows the functions below write.
CREATE FUNCTION credits_new_id(prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet CONSTANT text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  -- Bytes 1 to 6 of a version 4 UUID are random: six of one and four of another make the 80 bits.
  entropy CONSTANT bytea := substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6)
    || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4);
  n numeric := floor(extract(epoch FROM clock_timestamp()) * 1000);
  ulid text := '';
BEGIN
  FOR i IN 0..9 LOOP
    n := n * 256 + get_byte(entropy, i);
  END LOOP;
  FOR i IN 1..26 LOOP
    ulid := substr(alphabet, mod(n, 32)::integer + 1, 1) || ulid;
    n := div(n, 32);
  END LOOP;
  RETURN prefix || '_' || ulid;
END
$$;

-- The organization's balance row moved by the deltas; created at its first grant or usage row.
CREATE FUNCTION credits_balance_add(org_id text, d_granted numeric, d_reserved numeric, d_committed numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO credit_balances AS b (id, organization_id, granted, reserved, committed, updated_at)
  VALUES (credits_new_id('bal'), org_id, d_granted, d_reserved, d_committed, now())
  ON CONFLICT (organization_id) DO UPDATE SET
    granted = b.granted + EXCLUDED.granted,
    reserved = b.reserved + EXCLUDED.reserved,
    committed = b.committed + EXCLUDED.committed,
    updated_at = EXCLUDED.updated_at;
END
$$;

-- The balance triggers: a change to a grant or a usage row takes off what the row counted before and
-- adds what it counts after, so credit_balances is the sums over the rows: `granted` the grants'
-- amounts, `reserved` and `committed` the credits of the usage rows in those states. They run as the
-- owner, since neither `app` nor `billing_writer` may write credit_balances.
CREATE FUNCTION credits_balance_on_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM credits_balance_add(OLD.organization_id, -OLD.amount, 0, 0);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM credits_balance_add(NEW.organization_id, NEW.amount, 0, 0);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION credits_balance_on_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM credits_balance_add(OLD.organization_id, 0,
      CASE OLD.status WHEN 'reserved' THEN -OLD.credits ELSE 0 END,
      CASE OLD.status WHEN 'committed' THEN -OLD.credits ELSE 0 END);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM credits_balance_add(NEW.organization_id, 0,
      CASE NEW.status WHEN 'reserved' THEN NEW.credits ELSE 0 END,
      CASE NEW.status WHEN 'committed' THEN NEW.credits ELSE 0 END);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "credit_grants_balance" AFTER INSERT OR UPDATE OR DELETE ON "credit_grants"
  FOR EACH ROW EXECUTE FUNCTION credits_balance_on_grant();
CREATE TRIGGER "credit_usage_balance" AFTER INSERT OR UPDATE OR DELETE ON "credit_usage"
  FOR EACH ROW EXECUTE FUNCTION credits_balance_on_usage();

-- The organization's subscription to the fixed plan and its grant for the current period, once:
-- called for the first sign-in's organization (credits subscribes to tenancy.organization_created)
-- and for every subscription at each start of the api (the seeder). The period is the calendar month
-- in UTC, as periodFor says (core/modules/credits/domain/period.ts); the grant is the plan's allowance
-- of the moment, so a changed allowance counts from the next period. True when this call granted.
-- `app` may call it: it grants exactly the plan's allowance for a period not granted yet, nothing else
-- (docs/15 §11, rule 3). It runs as the owner: a migration cannot hand it to `billing_writer`
-- (core/modules/credits/docs/security.md).
CREATE FUNCTION credits_seed_self_hosted(org_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_month CONSTANT timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  v_start CONSTANT timestamptz := v_month AT TIME ZONE 'UTC';
  v_end CONSTANT timestamptz := (v_month + interval '1 month') AT TIME ZONE 'UTC';
  v_plan plans;
  v_sub subscriptions;
  v_granted integer;
BEGIN
  IF org_id IS NULL OR org_id = '' THEN
    RAISE EXCEPTION 'credits_seed_self_hosted: no organization id' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_plan FROM plans WHERE is_fixed ORDER BY created_at DESC, id DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credits_seed_self_hosted: no fixed plan, run pnpm credits:seed' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO subscriptions (id, organization_id, plan_id, status, period_start, period_end)
  VALUES (credits_new_id('sub'), org_id, v_plan.id, 'active', v_start, v_end)
  ON CONFLICT (organization_id) DO NOTHING;
  SELECT * INTO STRICT v_sub FROM subscriptions WHERE organization_id = org_id;
  UPDATE subscriptions SET period_start = v_start, period_end = v_end
  WHERE id = v_sub.id AND period_start < v_start;
  INSERT INTO credit_grants (id, organization_id, subscription_id, amount, reason, period_start, period_end)
  SELECT credits_new_id('grant'), org_id, v_sub.id, p.monthly_allowance, 'allowance', v_start, v_end
  FROM plans p WHERE p.id = v_sub.plan_id
  ON CONFLICT (organization_id, reason, period_start) DO NOTHING;
  GET DIAGNOSTICS v_granted = ROW_COUNT;
  RETURN v_granted = 1;
END
$$;

-- Functions are executable by PUBLIC when created: credits_seed_self_hosted by `app` and
-- `billing_writer` only, the others by their owner only.
REVOKE EXECUTE ON FUNCTION credits_new_id(text), credits_balance_add(text, numeric, numeric, numeric),
  credits_balance_on_grant(), credits_balance_on_usage(), credits_seed_self_hosted(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credits_seed_self_hosted(text) TO app, billing_writer;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['credits_new_id(text)', 'credits_balance_add(text, numeric, numeric, numeric)',
    'credits_balance_on_grant()', 'credits_balance_on_usage()', 'credits_seed_self_hosted(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', fn, current_schema());
  END LOOP;
END
$$;
