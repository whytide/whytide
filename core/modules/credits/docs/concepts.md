# credits: concepts

- **Wallet**: one per organization; every workspace of the organization spends from it. What is left is `granted − reserved − committed`.
- **Plan**: a code and a monthly allowance in credits. Core has one, the fixed plan (`is_fixed`), written from `.env` by the seeder and changed only by a restart with a new value or by SQL.
- **Subscription**: an organization's plan and its current period, one per organization, `active` (or `cancelled`, unused in Core).
- **Period**: the calendar month in UTC, its first instant included and the next month's first excluded (`periodFor`).
- **Grant**: credits added to the wallet; `reason` `allowance` is the plan's allowance for one period, granted once per organization and period.
- **Usage row**: one priced action in a workspace: `reserved` when it starts, then `committed` with the credits it cost, `released`, or `expired` when its lease ran out. Its idempotency key makes a retry the same row; `subject_ref` is the id of what it was for.
- **Reserve, commit, release**: a priced action reserves price × quantity before its work, if the wallet has it, then commits what the work used, never more, or releases it all when the work failed.
- **Lease**: how long a reservation holds, 15 minutes (`sync`, work in a request) or 24 hours (`async`, a workflow's). Past it, commit refuses the reservation and the organization's next reserve expires it, which frees its credits.
- **Balance**: `granted`, `reserved` and `committed`, the sums over the grants and the usage rows in those states, kept current by triggers.
- **Price list**: the credits an action costs per unit, declared in the modules' `prices.ts`, overridden by `PRICE_<ACTION>`, written at the api's start; a change writes the whole list as the next version.
- **Costs**: what the work cost, in two currencies: **credits**, the usage committed, and **money**, what the vendors charged for the calls, the cost events' `unit_cost` in the price list's currency (`COST_PRICES_JSON`). LinkedIn reads write no cost event: their money is not counted, only their credits.
- **Week**: an ISO week in UTC, `2026-W44`, from its Monday 00:00 to the next Monday excluded. A usage row or a cost event counts in the week it was created.
- **Weekly figure**: a week's credits and money, by action and by vendor, the leads its assessments qualified (each once), and the **cost per 100 qualified leads**, credits and money × 100 ÷ those leads; none for a week with no lead qualified.
- **Lead cost**: what one lead cost so far: its assessments' credits and calls, its drafts' calls, and its **read share** of each signal run that found it, the run's read credits divided evenly over the candidates the run staged. An imported lead has no read share.
