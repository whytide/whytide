# credits

The wallet, one per organization: the plan it is on, the monthly grants and the usage reserved or committed against it ([architecture §10](../../../docs/architecture.md#10-credits)). In Core the plan is fixed, `self_hosted`, written from `.env` at the api's start by the seeder; an organization gets its subscription and its first grant when tenancy creates it. Modules spend through the platform's `credits` client, which this module implements (reserve, commit, release), at the prices they declare in their `prices.ts`.

- **Owns:** `plans`, `subscriptions`, `credit_grants`, `credit_usage`, `credit_balances` and `price_list` in `core/packages/db/prisma/schema/credits.prisma`, with the grants, the balance triggers and `credits_seed_self_hosted` in the migration `credits_initial`, and the CHECKs, `app`'s column grant and the settle-once trigger in `credits_reserve` ([docs/data.md](docs/data.md)).
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`, `tenancy` (`findWorkspace` and its event); for the cost counter, `contacts` (`getLead`), `qualification` (`countQualified`) and `signals` (`personReads`, its prices' actions).
- **Reviewers:** the owners of this module; two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

## Public interface

| | |
|---|---|
| `readBalance(workspaceId)` | the balance of the organization the workspace belongs to: `{ organizationId, granted, reserved, committed, updatedAt }`, the amounts as decimal strings; `null` for an unknown workspace or before the first grant. Outside a tenant run only |
| `periodFor(date)` | the period holding the instant: `{ start, end }`, the calendar month in UTC, `end` excluded |
| `onStart({ log })` | binds the credits client, then the seeder and the price list, below; the api host awaits it after the migrations and before it listens (core/apps/api README "Modules") |
| `api` | `GET /v1/workspaces/{workspaceId}/credits/balance`: `{ available, granted, reserved, committed, periodEnd }` of the workspace's organization; `GET …/credits/usage?from&to&cursor&limit`: the workspace's usage rows, newest first, `limit` 1 to 100 (50), with `nextCursor`; `GET …/credits/costs?week` and `GET …/credits/leads/{personId}/cost`, the cost counter, below. All need `credits.read` (Owner, Admin, Member) and read the run's workspace, `currentTenant()` |
| `workflows/index.ts` | the global workflow `credits_period`, its activity `credits_grant_periods` and its schedule `period` (Periods); `onWorkerStart`, which binds the credits client at the worker's start |

The registries: `ids` (`plan`, `sub`, `grant`, `usage`, `bal`, `pl`), `settings`, `metrics` (`credits.usage`, by outcome: reserved, insufficient, committed, released, expired; `deploy/observability/dashboards/credits.json`), `permissions` (`credits.read`), `errors` (`insufficient_credits` 402, `usage_not_open` 409, `credits_not_bound` 500, `credits_input_invalid` 400), and `events`: none published; `events.ts` subscribes to tenancy's `tenancy.organization_created` and calls `credits_seed_self_hosted` for the new organization.

## The cost counter

What a week and a lead cost (alpha-p10-010; [docs/concepts.md](docs/concepts.md) "Costs"), in `domain/costs/`, read in the request's run:
- `weeklyCosts({ workspaceId, week })`, `GET …/credits/costs?week=2026-W44` (the current week without `week`): the ISO week in UTC, Monday 00:00 to the next Monday excluded; `credits`, the usage committed among the rows created in the week, `byAction`; `money`, the `unit_cost` of the cost events created in it, `byVendor`; `qualified`, qualification's `countQualified`; `costPer100Qualified`, both × 100 ÷ `qualified`, null for none. A week the year lacks is `credits_input_invalid` (400), `details.fields` `["week"]`.
- `leadCost(personId)`, `GET …/credits/leads/{personId}/cost`: the committed usage and the cost events whose subject is the person, and what the signal runs that found it charged, signals' `personReads`, both under `signals`: its share of each run's committed `signals.engager_read`, a run's before beta-p1-090, its credits × the person's candidates ÷ the candidates the run staged; and the committed `signals.engager` whose subject is one of the person's candidates, the profile reads of a run since; `byFeature` by module. A lead found by runs of both kinds shows both. A person with no lead in the workspace, another workspace's too, is contacts' `lead_not_found` (404), never a zero.

Amounts are decimal strings, summed exactly (`domain/costs/decimal.ts`), a share cut at the 30th decimal. LinkedIn reads write no cost event: their money is not counted.

## Screens

`ui/nav.ts` declares the shell's `balance` slot (core/apps/web/docs/screens.md): `ui/balance/slot.tsx` reads `GET …/credits/balance` as the member when a workspace page loads and shows `available` as `credits.balance.label`, a link to the costs page; `ui/balance/balance.tsx` reads it again from the browser at each navigation, since the shell's layout stays while its pages change. A failed read shows nothing, or keeps the last value: the header never takes a page down.

The costs page, `/w/{ws}/credits` (a `pages` entry: no navigation group holds it), reads the balance, the week's costs and its usage in the browser: the balance, large, and the period's end, with a bar of the period's grant, spent then reserved; a week picker of the last twelve weeks; the week's numbers as tiles, by action and by vendor, each amount with a bar of its share of the week, and its usage a page at a time, with the loading state, the error state with the code in words and a retry, and the empty state of a week with nothing spent. `ui/lead-cost/panel.tsx` is the cost line in the `cost` slot of contacts' lead page, a server component; the slot shows its loading and error states.

## Reserving

A module calls `credits` of `@whytide/platform` (core/packages/platform README "Credits") inside its own tenant run, a request's or an activity's `context.tenant`, never the tables ([architecture §4.3](../../../docs/architecture.md#43-how-modules-talk), rule 5):
- `reserve({ workspaceId, action, quantity, idempotencyKey, subjectRef, lease })` takes the organization's lock (`pg_advisory_xact_lock`, held to the run's end), expires the organization's reservations past their lease, checks `granted − reserved − committed` against price × quantity and inserts the row `reserved`: `{ usageId, credits }`, or `insufficient_credits` with no row. A key already used in the workspace returns its row. `lease` is `sync`, 15 minutes, for work in a request, or `async`, 24 hours, for a workflow's.
- `commit(usageId, actualQuantity?)` settles it at the credits of the actual quantity, pro rata and never above the reservation; `release(usageId)` frees it. A repeat returns the same; an unknown usage, the other settlement or a commit past the lease is `usage_not_open`.
- `balance(workspaceId)` and `priceOf(action)` read in the run; an action without a price is `credits_input_invalid`.

## Declaring a price

A module prices its actions in its `prices.ts`, and exports `prices` from its `index.ts` so the api loads it:

```ts
export const prices = definePrices([{ action: "qualification.assessment", credits: 1, unit: "lead" }], import.meta.url);
```

At the api's start, `onStart` writes the declared prices into `price_list` as `billing_writer`, the whole list as the next `version` when anything changed, nothing otherwise; `priceOf` reads the highest version. `PRICE_<ACTION>` in `.env`, the action in upper case with `.` as `_` (`PRICE_QUALIFICATION_ASSESSMENT=0.5`), overrides a price: a decimal of 0 or more, else the start stops with `config_invalid` naming the variable. An action priced by two modules stops the start with `duplicate_price_action` naming both files. A price changes with a restart only.

## The seeder

`onStart`, run by the api at every start and by `pnpm credits:seed`, as `billing_writer` (`DATABASE_URL_BILLING_WRITER`):
1. upserts the plan `CREDITS_PLAN_CODE` with `monthly_allowance` set to `CREDITS_MONTHLY_ALLOWANCE` and `is_fixed`; any other plan stops being the fixed one;
2. calls `credits_seed_self_hosted` for every organization with a subscription, so each has its grant for the current period;
3. logs `credits: the plan and the periods are seeded` with `plan_id`, `granted_count` and `period_start_at`.

A failure stops the api's start (`module_invalid` for `credits`, `details.field` `onStart`); `pnpm credits:seed` exits 1. Changing the allowance: [docs/runbook.md](docs/runbook.md).

## Periods

A period is the calendar month in UTC (`periodFor`, and the same rule in SQL). `credits_seed_self_hosted(organization_id)` subscribes the organization to the fixed plan when it has no subscription, moves the subscription to the current period and grants its plan's allowance for that period, once: a second call in the same period changes nothing and returns `false`. A subscription that is not `active` gets nothing.

The worker grants a new period: the schedule `credits.period` starts the global workflow `credits_period` every day at 00:05 UTC. Its activity `credits_grant_periods` (kind `db`) lists the organizations with a subscription in `withoutTenant("credits.period")` and calls `credits_seed_self_hosted` as `app` for each, one call each, so a failure keeps the grants made before it and the activity's retry runs the pass again. It logs `credits: the periods are granted` with `organization_count` and `granted_count`. The api's start grants the current period too (The seeder).

## Settings

The `modules/credits` block of `deploy/.env.example`: `CREDITS_MONTHLY_ALLOWANCE`, a whole number of credits from 0 to 2^53 − 1 (default `10000000`), and `CREDITS_PLAN_CODE`, 2 to 40 lowercase letters, digits and underscores, starting with a letter (default `self_hosted`).

## Testing

`pnpm -F credits test` runs, against the worktree's database:
- `tests/seed.test.ts`: the seeder as `billing_writer`, a second run with another allowance, the same statement refused as `app`; `bootstrapOrganization` and its event delivered in process with `deliverPending`, then one subscription, one grant and the balance, and a second call changing nothing;
- `tests/balance-trigger.test.ts`: one thousand random grants, grant changes, reservations, commits, releases and expiries over three organizations, from a fixed seed; the balances equal the sums over the rows;
- `tests/period.test.ts`: `periodFor`;
- `tests/tenancy.test.ts` (`test:tenancy`): `credit_usage` in the two-workspace harness, the usage list and the cost counter's reads through `assertScoped`, and a workspace of organization B reading B's balance, never A's;
- `tests/reserve.test.ts`: the arithmetic, the repeated key, ten reserves in parallel on ten connections, the leases on a moved clock, each outcome in `credits.usage`; `tests/prices.test.ts`: the override parser and the version bump;
- `tests/costs.test.ts`: a fixture week, ten assessments at 0.2, a run of 4 credits and three drafts, by action, by vendor and per 100 qualified, another organization's its own; a signal-sourced and an imported lead's cost; the week's and the share's arithmetic.

The routes are tested through the api, `core/apps/api/tests/credits-balance.test.ts` and `credits-costs.test.ts`; the screens in `core/apps/web/tests/credits-screen.spec.ts` (`pnpm -F web test`), in `wsp_e2e_costs`, seeded by the e2e api's `POST …/e2e/leads`, `spend` and `costs`, and `wsp_e2e_nocosts`; and `credits_period` through the worker, `core/apps/worker/tests/credits-period.test.ts`, on the slice's Temporal: a subscription a period behind gets one grant, a second run none, a `cancelled` one none, and two starts leave one schedule; its recorded history, `workflows/__histories__/credits_period.json`, replays in `pnpm -F worker test:replay`. `@whytide/credits/testing` has `grantAllowance(organizationIds, allowance)`, `createCreditsClient(now)` and `useCreditsClient(client)`, which points the module's own `app` client at a test's schema.

`test:roles` of core/packages/db proves the grants on these tables.

## Decided here

- The organization-level tables are global models, read through `withoutTenant("credits.<reason>")` for the organization tenancy gives for the workspace, never one a caller names; `credit_usage` is the tenant table ([docs/security.md](docs/security.md)).
- `credit_usage`'s idempotency key is unique per `(workspace_id, organization_id, idempotency_key)`: a tenant table's unique keys start with `workspace_id`.
- `billing_writer` inserts and updates; nobody deletes. `credit_balances` is written by the triggers alone.
- Amounts are `numeric`, read as decimal strings.
- tenancy's event is `tenancy.organization_created`, named `module.event_name` as the platform's events are.
- reserve runs in the caller's run, on its transaction: the lock, the sweep, the check and the insert commit or roll back with the caller's work. It reads the workspace's `organization_id` in that transaction, since tenancy's `findWorkspace` opens a `withoutTenant`, which a run refuses (`nested_run`). The sums stay Postgres `numeric`: Prisma's `Decimal` computes with 20 digits.
- An advisory lock, not `SELECT … FOR UPDATE`: `app` may not lock `credit_balances`. Commit and release take it too, before any row, so a run that settles, then reserves, cannot deadlock with another reserve of the organization. reserve reads the price after the repeated key, so a repeat returns its usage even when the action lost its price. The sweep is lazy, by the next reserve of the organization; `balance` shows an expired lease as reserved until then.
- A commit's credits are the reservation's pro rata of the actual quantity, at the reservation's price; a release frees a reservation past its lease too.
- The price list's version is global: each version holds the whole list.
- `credits_period` runs every day, not on the 1st alone: the function grants a period once, so a day with nothing new grants nothing, and a worker down on the 1st grants the month the next day.
- The cost counter's week is the ISO week in UTC, as contacts' weekly summary and qualification's golden set name one. A usage row counts in the week it was created, committed only; a lead counts as qualified in the week its assessment's own snapshot (no re-score's criteria hash) was created with `qualified`, once. A run's candidates are its counts' `staged`, whose share of the run's reads each candidate carries, so the shares of a run's persons never add up to more than the run's credits.
- The api host references the module in its tsconfig and loads its build by path, with no dev dependency (its tests' `pnpm run build` builds it first): credits depends on qualification, which depends on icp, which lists the web, which depends on the api: a cycle `pnpm -r` refuses (`ERR_PNPM_TASK_CYCLE`).
