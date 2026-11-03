# credits: data

Six tables in `core/packages/db/prisma/schema/credits.prisma`, created by the migration `20261022103000_credits_initial`. Every id is `<prefix>_<ULID>` (`ids.ts`; the functions make theirs with `credits_new_id`); every instant is a `timestamptz`; every amount is `numeric`.

| Table | Id | Columns | Keys | Scope | Written by |
|---|---|---|---|---|---|
| `plans` | `plan_` | `code`, `name`, `monthly_allowance`, `is_fixed`, `created_at` | `code` unique | global | `billing_writer` |
| `subscriptions` | `sub_` | `organization_id`, `plan_id`, `status`, `period_start`, `period_end`, `created_at` | `organization_id` unique | organization | `billing_writer`, `credits_seed_self_hosted` |
| `credit_grants` | `grant_` | `organization_id`, `subscription_id`, `amount`, `reason`, `period_start`, `period_end`, `created_at` | `(organization_id, reason, period_start)` unique | organization | `billing_writer`, `credits_seed_self_hosted` |
| `credit_usage` | `usage_` | `organization_id`, `workspace_id`, `action`, `quantity`, `credits`, `status`, `idempotency_key`, `lease_expires_at`, `subject_ref`, `created_at`, `settled_at` | `(workspace_id, organization_id, idempotency_key)` unique; index `(workspace_id, created_at)` | tenant | `app` |
| `credit_balances` | `bal_` | `organization_id`, `granted`, `reserved`, `committed`, `updated_at` | `organization_id` unique | organization | the triggers |
| `price_list` | `pl_` | `action`, `credits`, `unit`, `version`, `effective_from` | `(action, version)` unique | global | `billing_writer` |

`status` is the enum `subscription_status` (`active`, `cancelled`) on `subscriptions` and `credit_usage_status` (`reserved`, `committed`, `released`, `expired`) on `credit_usage`. Foreign keys: `subscriptions.plan_id` and `credit_grants.subscription_id`; `organization_id` has none, `organizations` being tenancy's table.

The migration `20261022160000_credits_reserve` adds non-negative CHECKs on `credit_usage` (`credits`, `quantity`), `plans.monthly_allowance` and `credit_grants.amount`, the index `(organization_id, status, lease_expires_at)` for the lease sweep, `app`'s column grant and the trigger `credit_usage_settle_once` ([docs/security.md](security.md)), and makes `credits_seed_self_hosted` skip a subscription that is not active.

The SQL written by hand in the migrations: the grants ([docs/security.md](security.md)); the triggers `credit_grants_balance` and `credit_usage_balance`, which take off what a row counted before a change and add what it counts after; and `credits_seed_self_hosted(organization_id)` (README "Periods").

Personal data: none. `subject_ref` holds an id, never a person's data. Nothing is deleted in alpha: grants and usage rows are the ledger.
