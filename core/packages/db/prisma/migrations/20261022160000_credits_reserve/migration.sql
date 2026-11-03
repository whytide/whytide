-- CreateIndex
CREATE INDEX "credit_usage_organization_id_status_lease_expires_at_idx" ON "credit_usage"("organization_id", "status", "lease_expires_at");

-- Hand-written (prisma/schema/credits.prisma points here), for reserve, commit and release
-- (core/modules/credits/docs/security.md): what `app` may do to a usage row can only settle it once,
-- at or under what it reserved, so no change of `app`'s lowers another organization's `reserved` or
-- `committed`, or gives back credits a commit took; and no amount is negative.
ALTER TABLE "credit_usage" ADD CONSTRAINT "credit_usage_credits_non_negative" CHECK ("credits" >= 0),
  ADD CONSTRAINT "credit_usage_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_monthly_allowance_non_negative" CHECK ("monthly_allowance" >= 0);
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_amount_non_negative" CHECK ("amount" >= 0);

-- `app` updates the four columns commit, release and the lease sweep change, never a row's
-- organization, workspace, action, key or lease.
REVOKE UPDATE ON TABLE "credit_usage" FROM app;
GRANT UPDATE ("quantity", "credits", "status", "settled_at") ON TABLE "credit_usage" TO app;

-- A usage row leaves `reserved` once, for committed, released or expired, and its credits never rise.
CREATE FUNCTION credits_usage_settle_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'reserved' OR NEW.credits > OLD.credits THEN
    RAISE EXCEPTION 'credits: a usage row is settled once, never above its reservation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "credit_usage_settle_once" BEFORE UPDATE ON "credit_usage"
  FOR EACH ROW EXECUTE FUNCTION credits_usage_settle_once();

-- credits_seed_self_hosted as in credits_initial, but a subscription that is not active (cancelled)
-- gets no new period and no grant. CREATE OR REPLACE keeps the owner and the grants; SECURITY DEFINER
-- and the pinned search_path are written again, since a replace resets them.
CREATE OR REPLACE FUNCTION credits_seed_self_hosted(org_id text) RETURNS boolean
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
  IF v_sub.status <> 'active' THEN
    RETURN false;
  END IF;
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

REVOKE EXECUTE ON FUNCTION credits_usage_settle_once() FROM PUBLIC;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['credits_usage_settle_once()', 'credits_seed_self_hosted(text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', fn, current_schema());
  END LOOP;
END
$$;
