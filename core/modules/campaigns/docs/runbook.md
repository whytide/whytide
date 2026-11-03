# campaigns: runbook

One setting, `CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND` (README.md "Settings"). The module runs in the worker, as the subscriber to `contacts.lead_approved`, `contacts.suppression_added`, `approvals.item_decided` and `linkedin.invite_accepted`, and as the daily plan, the queue and each account's sender. The subscribers log nothing of their own: a failed delivery is the outbox's log line and the event's row (`attempts`, `last_error`, and `dead_at` after its last attempt; the platform's README "Events and the outbox"). The plan logs one line per account and run, `campaigns: account planned`, with `sender_account_id`, `skipped`, `kept`, `released`, `placed` and `sender_started`. The sender logs one line of its own, `campaigns: send_uncharged` ("A send logged uncharged"); its runs, `campaigns.sender:<workspace>:<account>` in Temporal's UI, answer `{ sent, blocked, refused, end }`.

## Finding a person's enrollment

As the owner role, in the workspace (`<workspace>`, `<person>`):

```sql
SELECT id, status, exit_reason, exit_detail, sender_account_id, source_event_id, started_at, ended_at
FROM enrollments WHERE workspace_id = '<workspace>' AND person_id = '<person>' ORDER BY created_at;
SELECT step_key, status, due_at, scheduled_for, attempt, skip_reason, error_code, jit_checks
FROM step_executions WHERE workspace_id = '<workspace>' AND person_id = '<person>' ORDER BY created_at, position;
```

- No row after an Approve: the event is not delivered yet (is the worker running? `outbox` row of `contacts.lead_approved` with the person's id, its `delivered_at`), or the person was erased (`person_not_found`, nothing written).
- `exited`, `no_sender`: the approver has no connected LinkedIn account in the workspace; they connect one and approve again (the lead stayed `approved`).
- `exited`, `suppressed`: `exit_detail` names the reason (`opted_out`, `never_contact_person`, `never_contact_company`, `recently_contacted`); contacts' never-contact list and the person's last touch say more.
- Approve refused with `lead_in_outreach`: the lead is in a campaign already; its active enrollment is the first query's.

Never edit these rows by hand to re-send: a key in `executing` or `succeeded` refuses another row entering `executing` on purpose.

## Why a step did not go

The second query's `status`, `skip_reason`, `error_code` and `jit_checks` (what the gate saw, and when):

- `held`, `replied`: the person replied. Inbox's store held every pending step (`holdForReply`), or the gate found an inbound message on linkedin's outreach row (`sender_outreach.last_inbound_at`) after the enrollment's `started_at`; the enrollment is `replied`.
- `held` or `cancelled`, `enrollment_ended`: the gate met an enrollment no longer `active`: `held` when it `replied`, `cancelled` otherwise.
- `skipped` with `opted_out`, `never_contact_person` or `never_contact_company`: the gate found the person suppressed; the person's other pending steps are `cancelled` with the same reason and the enrollment `exited`, `suppressed`. The same `cancelled` rows with no `skipped` one and no `jit_checks`: the `contacts.suppression_added` subscriber.
- Still `scheduled`, `error_code` `touched_today`: the person was touched earlier on the sender's quota day (contacts' `last_touch_at`, in the account's zone); the plan places the step on a later day.
- A suppression added and an enrollment still `active`: the `contacts.suppression_added` event is not delivered yet (its `outbox` row, `delivered_at`); the gate stops the step before a send all the same.
- An `executing` step after a stop: the sender's claim, settled by the sender alone; its gate runs again before the call.
- `skipped`, `skipped_by_owner`: the owner skipped it in "Up next" (the item's `decided_by`); for a connection request, the enrollment's other steps are `cancelled` with the same code and the enrollment `exited`, `removed`.
- `skipped`, `not_approved` or `content_changed`, with `jit_checks.approval`: the gate found no approved item for the step, or its text changed after the approval. Neither should happen; look for a hand edit of the item or the draft.
- `awaiting_approval` for days: the owner has not decided; "Up next" shows the item stale. The queue opens nothing new for it.

## The panel

- A reason reads "For a reason this page does not know yet": the code has no key in `ui/enrollment-panel/words.ts`; add one there and in `messages/en.json`.
- Times in UTC: the enrollment has no sender, or linkedin no longer holds its account (the route's `timeZone` is null).

## A step that gets no time

A `scheduled` step whose `scheduled_for` stays null after a tick. Its account's line, `campaigns: account planned`, says why for the whole account:

- `skipped: not_connected`: the account is not `connected` (linkedin's account screen).
- `skipped: window_closed`: outside the account's working hours, or a Saturday or Sunday in its zone; the plan places from the next window.
- `skipped: no_window`: `remainingToday` answers no window: today's is over, or the account may not send (sending closed, stopped or paused, once beta-p1-040 and beta-p6-010 land).
- The account was planned, but not this step: the step is not due (`due_at` null or ahead); today's number of its type, or the actions left of the 200, are used (linkedin's usage route, `GET …/accounts/{id}/usage`); its person has a step placed today, a touch today (contacts' last touch) or another due step taken first; or the window had no room a gap from the other times.
- No line for the account: the workspace's plan did not run (the schedule `campaigns.plan` paused, `WORKER_SCHEDULES`), or a run still holds `campaigns.plan:<workspace>:current` (Temporal's UI).

```sql
SELECT id, person_id, action_type, status, due_at, scheduled_for, quota_day, executed_at
FROM step_executions WHERE workspace_id = '<workspace>' AND sender_account_id = '<account>'
  AND status IN ('scheduled', 'executing') ORDER BY scheduled_for NULLS LAST, due_at;
```

Never set `scheduled_for` by hand: the plan is its only writer (the sender only clears it), and a time placed by hand skips the gap and the day's count.

## A step left `planned` by the queue

A `planned` `invite` or `message` step with no `approval_item_id` after a tick. The workspace's run, `campaigns.queue:<workspace>:<slot>` in Temporal's UI, answers `{ opened, passedOver, noSender, failed }`:

- Not due: `due_at` null (a message before its anchor) or more than 24 hours ahead (`QUEUE_WINDOW_HOURS`). A withdrawal never gets an item.
- Passed over: the enrollment is no longer `active`, or the person is suppressed (contacts' `suppressionOf`); the suppression subscriber or the gate ends the step.
- `noSender`: linkedin no longer holds the step's sender account.
- `failed`: the step's activity failed past its attempts (its error in Temporal's UI); it is tried again next tick.
- No run: the schedule `campaigns.queue` is paused (`WORKER_SCHEDULES`), or the slot's run still holds the id.

## A first message with no due time

`message_1` still `planned` with `due_at` null after the person accepted. The second query of "Finding a person's enrollment", its `connect` row:

- `accepted_at` null: the acceptance is not detected yet (linkedin's `sender_outreach.accepted_at` and `accepted_detected_at`) or not delivered (the `outbox` row of `linkedin.invite_accepted` with the person's id, its `delivered_at`); or the connection request never went out from the platform (`connect` neither `succeeded` nor `executing`: sent by hand, say), or the enrollment had ended.
- `accepted_at` set: at the delivery, linkedin no longer held the account, or its working days held no weekday; nothing can go from it until it does, and then the queue's next run gives the step a due time drawn from that run (beta-p4-040; README.md "Decided here").
- Due, but no item in "Up next": a due time more than 24 hours ahead, a Friday evening's acceptance due on Monday, gets its item when it enters the queue's window.

## A step waiting with a code

A `scheduled` step with no time and an `error_code`: the sender put it back, and the plan places it again from its next tick, never before `due_at`, which a refusal's `retryAt` moved later. The query of "A step that gets no time", with `error_code`:

- `insufficient_credits`: the workspace's organization has no credits left for `campaigns.linkedin_send` (credits' balance); the step goes once the next grant lands, and the sender's run ended at it.
- `member_ref_unknown`: contacts' person has no member id under `providerRefs.unipile` after a profile read that stored none: no answer past the read's attempts, a refusal that campaigns has no code for (`linkedin_provider_error` after the call; `linkedin_rate_limited` before it, the next placement's reservation then waiting `rate_limited` until the account's `retry_at`), or a newer value contacts kept. The next placement reads the profile again ([flows.md](flows.md) "The read before an invite").
- `person_not_found`: the person was erased meanwhile; the next gate ends the step.
- `touched_today`: the person was touched on the sender's quota day; it goes on a later day. `send_in_flight`: another of their steps is `executing`, its outcome not settled yet (beta-p4-040); it goes once that step is settled.
- `sending_closed`, `platform_stopped`, `workspace_stopped`, `account_stopped`: linkedin's switches (its runbook); the plan places nothing while they hold.
- `account_paused`, `invites_paused`, `linkedin_account_disconnected`, `disclosure_required`, `member_id_unknown`: the account's health, session, disclosure or member id (linkedin's account screen and runbook).
- `rate_limited`, `outside_working_hours` and the caps (`invite_cap_reached`, `message_cap_reached`, `weekly_invite_cap_reached`, `daily_actions_cap_reached`, `invite_note_budget`, `read_cap_reached`): linkedin refused the slot, the chat's read or the profile read until `retry_at`, the next window or the next quota day; `due_at` says when.
- `pending_invites_unknown`, `pending_invites_over_limit`: an invite while linkedin's count of the account's pending invitations is unknown (none in 48 hours) or above 400 (linkedin's runbook); `due_at` moves to the day's check or the next quota day, the plan places no invite until the count allows one, and the account's messages still go.
- `reservation_not_open`: linkedin released the slot before the call, as a pause does.
- `linkedin_rate_limited`, `linkedin_limit_reached`, `linkedin_account_disconnected`: the provider's answer after the call (beta-p4-040, docs/flows.md "The error map"); the credits were released, `due_at` is the vendor's wait or the next quota day's start, and linkedin's account screen shows the health. "Up next" shows the code and the time on the step's approved item until the next claim.

Never clear the code by hand to hurry a step: the next claim clears it, and the gate and the reservations decide again.

## A step left `executing`

A sender run that ended `unsettled`: linkedin's answer was a refused check that kept its slot, a port's error whose outcome is unknown (`error_code` `linkedin_provider_error`, `linkedin_output_invalid` or `linkedin_error_unmapped`) or no answer at all, so the send may have gone out. The step stays `executing` with its credits reserved (`credit_usage_id`), its slot as linkedin's error map left it, and its request file under `raw/campaigns/<step>/`. The account's next sender run checks it before any claim (docs/flows.md "The check first"), once `due_at` is null or past: found sent, it is `succeeded`; not sent, it goes back to `scheduled` for the plan; a check refused or failing waits for its `retryAt` or the next quota day's start (`due_at`). The plan starts that run at its next tick. A step `executing` for days means the account's checks keep failing: see linkedin's account screen and its `retry_at`. Never move it by hand: `failed` frees the key while the message may have reached the person, and `scheduled` re-sends without the check unless `attempt` is raised. The person's other steps wait as `send_in_flight`.

## A send logged uncharged

The warn line `campaigns: send_uncharged`, with `step_execution_id` and `credit_usage_id`: the send went out and its step is `succeeded`, but credits answered `usage_not_open` at the commit, the usage past its 24-hour `async` lease and expired (credits' `credit_usage`, its `status` and `lease_expires_at`). The send's record stays as it is: the charge is lost, and nothing is retried. A step left `executing` past its lease and found sent by the sender's check a day later logs it too (beta-p4-040). Many such lines mean sends held `executing` for a day: see "A step left `executing`".

A sender run failing at the claim with `credits_input_invalid` (`fields: ["action"]`): the price `campaigns.linkedin_send` is not in `price_list`; the api writes it at its start, so restart the api after a deploy.

## The report

`pnpm campaigns:report` (README.md "Commands"; on the production machine, `docker compose exec api node ../../modules/campaigns/dist/cli/report.js`), weekly, and before beta's verdict without `--since`, so that every row counts. Exit 0 means the three zeros hold; read the rest against the targets on their lines. Each `violation:` line names the workspace and the step: start from the step (`step_executions`, by id, in that workspace), its item (approvals' `approval_items` by `step_execution_id`) and linkedin's row (`sender_action_log`, `object_ref` the step's id).

- `sends_without_approval`, `no_approval`: the step has no approved item whose frozen text still hashes to the approval's hash. Check the item's `status` and `decided_at`, and whether the step went out through the sender at all (its `jit_checks` hold `approvalItemId` and `contentHash` only after the gate's pass). `item_mismatch`: the send carried another item or hash than the step's approval now answers; a newer item for the step, or a draft changed after the approval, comes first. `approved_after_send`: compare `decided_at` with the row's `at`; a clock problem, or a send that skipped the gate.
- `send_step_missing`: a row whose step is gone or that names none. An erased person's steps are deleted (privacy's erasure), so their sends land here: check privacy's log for the person's erasure around then. Any other row is a send that bypassed campaigns, a defect to explain.
- `actions_against_suppressed`: contacts' list, rebuilt as it stood at the send (a removed entry keeps `removed_at`), had the person. Check the entry's `created_at` against the row's `at`: an entry made just before the send, while the step was already `executing`, is the narrow window the gate leaves; anything older is a gate that did not run. The company's entries are matched as the person's company is now. A person erased since the send answers `person_not_found` and is not counted.
- `duplicate_sends`: a step with two `ok` rows, or a key two `succeeded` steps hold. It counts log rows, so it sees a second send only when linkedin wrote a row for it: the check after an unknown outcome writes none when one exists (beta-p1-050), and a send outside the log does not show. Check the step's `attempt` and the rows' `at`, then linkedin's runbook for the account.
- `restrictions` and `checkpoints`: linkedin's runbook for the account; each checkpoint is explained in beta's notes. `decision_days` below 5 of 5 means a weekday without a decision in "Up next".

The report writes nothing and calls no provider: run it as often as needed. A JSON line before the codes is the platform's info log of tenancy's read across workspaces; `LOG_LEVEL=warn pnpm campaigns:report`, or `docker compose exec -e LOG_LEVEL=warn api …`, prints the codes alone.

## An invite that was not withdrawn

A connection request still pending on LinkedIn more than 21 days after it went out. Its `connect` and `withdraw` steps, as the owner role:

```sql
SELECT step_key, status, executed_at, accepted_at, due_at, scheduled_for, skip_reason, error_code
FROM step_executions WHERE workspace_id = '<workspace>' AND person_id = '<person>'
  AND step_key IN ('connect', 'withdraw') ORDER BY created_at;
```

- No `withdraw` row: the job opens one at 05:00 UTC only for an `active` enrollment whose `connect` step is `succeeded`, with `executed_at` 21 × 24 hours ago or more and `accepted_at` null. Check the enrollment ("Finding a person's enrollment"), then the job's runs in Temporal's UI, `campaigns.withdraw:<workspace>:<UTC date>` (`{ opened }`), and the schedule `campaigns.withdraw` (paused while `WORKER_SCHEDULES=off`). An enrollment that ended otherwise, a suppression or a reply, leaves its request pending: withdrawing those is for a later version.
- `scheduled`, no time, or an `error_code`: it waits as any step ("A step that gets no time", "A step waiting with a code"); `withdrawal_cap_reached` is the 15 a day, and the 200 and the window hold too.
- `cancelled`, `invite_accepted`: the request was accepted before the call, and the enrollment goes on.
- `failed`, `linkedin_not_found` or `linkedin_send_refused`: LinkedIn had no pending invitation to withdraw, or refused the withdrawal; the enrollment ended `not_accepted` and the touch was recorded. A request still pending on LinkedIn then: withdraw it there, by hand.
- `executing`: "A step left `executing`".
- `succeeded`: the withdrawal went out (linkedin's outreach row, `withdrawn_at`).

Never insert a `withdraw` row or clear `accepted_at` by hand: the job, the plan and the gate decide again at their next runs.

## A step `failed` with `profile_unreadable`

A connection request whose profile read (beta-p4-030) answered `linkedin_not_found`: LinkedIn shows the sender account no profile at the person's stored URL (deleted, renamed, or out of the account's sight). Nothing was sent. The read is committed (a `read_profile` row in linkedin's log, and the day's reads), the credits released (`:<attempt> released`), the enrollment `exited` (`send_refused`) with its pending steps `cancelled` under the same code and their items blocked, and the lead `finished` (a suppressed one stays so). Check the URL in contacts (`persons.linkedin_url`). Many such steps for one account at once point to the account rather than the people: its session and health (linkedin's runbook).

## An account replaced

linkedin found another LinkedIn account behind a sender account (its member id changed at a refresh) and published `linkedin.account_replaced`. campaigns' subscriber ended each `active` enrollment of the account `exited` (`no_sender`, `exit_detail` `account_replaced`), cancelled its pending steps (`skip_reason` `account_replaced`) and their items, and finished the lead. The `outbox` row of the event, its `delivered_at` and `last_error`, says whether it ran. A step `executing` then is left to the sender's check ("A step left `executing`"). The leads are `finished`, which Approve refuses in beta (README.md "Decided here", the task's open question). Never re-activate an enrollment by hand.
