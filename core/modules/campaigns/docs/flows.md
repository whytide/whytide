# campaigns: flows

## Approve → enrollment

1. A member presses Approve on a lead (contacts' `approveLead`, beta-p2-030): the lead becomes `approved` and `contacts.lead_approved` `{ personId, approvedBy }` is written to the outbox in the same transaction.
2. The worker's outbox loop delivers the event in a transaction of its own for the event's workspace, as `service:worker`, not in Approve's. campaigns' subscriber (`events.ts`) runs `enrollApproved` with that transaction and the event's id.
3. First, contacts' `lockLeadStatus(personId)` locks the lead and reads its status, so that a block's change of the lead waits for this delivery, or this delivery reads the block once it has committed (beta-p2-050). Then, in this order: the event's enrollment exists (a redelivery), or the person's `active` one: nothing. No lead, or `suppressionOf(personId, { newEnrollment: true })` answering `person_not_found`: nothing. Any other reason: an `exited` enrollment, `suppressed`, with the reason in `exit_detail`, and no step. A lead no longer `approved` (suppressed, in a campaign or done since): nothing. `senderOf(approvedBy)` null: an `exited` enrollment, `no_sender`, no step, the lead left `approved`.
4. Otherwise an `active` enrollment with the sender, the template and `started_at`, inserted unless the person's active one appeared meanwhile; the four step executions, `planned`, `connect` due now; and `recordLeadStatus(personId, "in_campaign", { templateId, actor: system })`, one change row.
5. A throw fails the delivery, which the outbox tries again from step 3 with the checks run anew; after its attempts the event is dead (the platform's README "Events and the outbox"). The steps wait for the queue ("The queue").

The event carries ids only; no step's text travels anywhere from here.

## Erasure

privacy's deletion script runs `erasePerson(personId)` in its tenant run, after the platform's step and before contacts': the lead locked, then the person's enrollments in id order (`FOR UPDATE`), the stops' one order (beta-p4-040); then the person's step executions, then their enrollments, deleted. The platform's step deletes the outbox events naming the person, and waits for an event a delivery holds; campaigns' step, after it, so also erases what a `contacts.lead_approved` delivery wrote meanwhile.

## The gate

campaigns' sender (beta-p4-020) calls `checkGate(stepExecutionId, { at })` in its claim's run and again right before the call. Each check reads the database in that run; the first that fails decides:

| # | Check | Blocked reason | What the gate writes |
|---|---|---|---|
| 1 | the step is `scheduled`, or `executing` under the sender's claim | `step_not_ready` | nothing |
| 2 | the enrollment is `active` | `enrollment_ended` | the step `held` when the enrollment is `replied`, else `cancelled` |
| 3 | `suppressionOf(personId, { newEnrollment: false })` answers not suppressed | the suppression's reason | the enrollment `exited` (`suppressed`, the reason in `exit_detail`), the person's other pending steps `cancelled`, the step `skipped` |
| 4 | linkedin's `lastInboundAt(senderAccountId, personId)` is null or before `started_at` | `replied` | `holdForReply(personId, { at })`, then the step `held` |
| 5 | contacts' `lastTouchAt(personId)` is not on today's quota day in the sender's zone (`quotaDay`, the zone from `findSenderAccount`) | `touched_today` | `error_code`; the status stays and the plan places the step on a later day |
| 6 | for every action but a `withdraw` (an action added later included): the step's `approval_item_id` is its latest item in approvals' `decisionsFor`, `approved`; then approvals' `approvedContent(stepExecutionId)` answers for that item, its text unchanged and approved by the account's owner | `not_approved`, then `content_changed` | the step `skipped`, with the owner's skip's follow-on ("The decision") |

A block writes its reason (`skip_reason`, or `error_code` for `touched_today`) and the checks seen (`jit_checks`) on the step, if it still has the status the gate read. The answer is `{ pass: true, checks }` or `{ pass: false, reason, checks }`; `checks` holds `at` and what each check that ran saw (statuses, the suppression's answer, instants, the quota day), never a name or a text. A pass of check 6 adds `approval`, the item's id, its status and the approved text's hash. On a pass the sender stores the checks with its send, then reserves: a blocked step takes no slot and no credit. An enrollment without `started_at`, and a touch dated after today's quota day, fail closed.

For a withdrawal, check 6 is its connection request's `accepted_at`, which must be null: set, the step `cancelled` (`invite_accepted`) and the enrollment going on, with `invite` in `checks` ("The withdrawal").

## The hold on reply

`holdForReply(personId, { at })`, in the caller's transaction (inbox's store, beta-p5-010; the gate's check 4), in this order: the lead locked (contacts' `lockLeadStatus`); each `active` enrollment of the person `replied` with `ended_at = at`; every `planned`, `awaiting_approval` and `scheduled` step of the person, in every enrollment, `held` with `skip_reason = replied`, and their pending approval items blocked (approvals' `cancelItems`, the same transaction); then the lead `replied` through `recordLeadStatus(personId, "replied", { actor: system })`, unless it is `suppressed` or has no lead. It answers the ids of the steps it held. A second call finds nothing to hold and the lead already `replied`: no write, no status change. The reply and the hold commit together, so the stop takes no longer than the store (RB-23.1.3's 60 seconds). An `executing` step stays: the sender's gate holds it.

## The suppression subscriber

`contacts.suppression_added` (an entry added by hand, an opt-out) is delivered in a transaction of its own (`context.tx`). The subscriber reads every `active` enrollment of the workspace and asks `suppressionOf(personId, { newEnrollment: false })` once for each; for a suppressed person, the enrollment `exited` (`suppressed`, the reason in `exit_detail`, `ended_at` now) and their `planned`, `awaiting_approval` and `scheduled` steps `cancelled` with the reason in `skip_reason` and their pending items blocked. An `executing` step is left to the sender, whose gate runs again before the call. A second delivery finds those enrollments ended: nothing changes. The lead is contacts': its entry already set it `suppressed`.

The hold, the enrollment and the skip lock in one order: the lead, the enrollments, the steps, the items; the suppression subscriber and the gate's exit lock no lead, the enrollments then the steps and the items. So two stops at once wait on each other rather than deadlock: a reply racing an approval's delivery waits for the enrollment it makes, then holds it, and a skip racing a reply waits for the hold, then finds the step held (beta-p5-010). The one row the gate locks after the hold, an `executing` step it holds after a reply, is the sender's own claim, which no other stop touches.

## The lead page's panel

1. A member opens a lead; the panel, in the browser, reads `GET …/campaigns/enrollments?personId=` with the session (`campaigns.read`).
2. In the request's tenant run: the person's enrollments, newest first, at most 20; their steps in a query of their own, as the tenant client refuses a relation; each sender account's zone, once per account, from linkedin's `findSenderAccount`, null for an account it no longer holds.
3. The panel words each status and code from its keys and shows each time in the sender's zone, named.

## The daily plan

Every `TICK_MINUTES` (15), the schedule `campaigns.plan` runs `campaigns_plan_tick`, global (README.md "Worker"):

1. `campaigns_start_plans`: tenancy's `listWorkspaceIds()`, then `startWorkflow(planStart(workspaceId))` for each: one run of `campaigns.plan:<workspaceId>:current` at a time, so a workspace whose plan still runs gets none this tick. A failed start leaves the others started and fails the tick with its code.
2. `campaigns_plan` `{ workspaceId }`, its activity `campaigns_plan_accounts`: the sender accounts of the workspace's `scheduled` steps, and of its `executing` steps due for their check (beta-p4-040), in a tenant run; then each account in a tenant run of its own, `planAccount(accountId, now)`:
   1. linkedin's `findSenderAccount`: nothing unless the account is `connected` (`not_connected`).
   2. platform's `isWindowOpen` now, in the account's zone with its hours, its days cut to Monday to Friday: nothing while closed (`window_closed`), on a Saturday or Sunday too.
   3. linkedin's `remainingToday`, `{ invites, messages, withdrawals, actions, windowEnd }`: nothing when `windowEnd` is null (`no_window`), none of today's window left or an account that may not send (decisions.md, Finding 56). No row of linkedin's log either way.
   4. The account's `scheduled` steps, and no other status. Kept: placed on today's quota day, the time ahead or less than `MIN_ACTION_GAP_MS` behind. Stale: more than a gap behind, or on an earlier quota day. The candidates: the unplaced and the stale steps whose `due_at` has passed, messages first, then withdrawals, then invites, each by `due_at`, `position` and id.
   5. The room: each type within `remainingToday`'s number and all three within `actions`, the kept steps counted first, earliest first; a kept step past the room is dropped. A candidate is taken while its type has room, unless its person has a kept step today, or contacts' `lastTouchAt` falls on today's quota day (or answers `person_not_found`); only a person's first candidate counts (`TOUCHES_PER_PERSON_PER_DAY`).
   6. The stale and the dropped steps lose their time: `scheduled_for` and `quota_day` back to null, each update conditional on the time the plan read.
   7. `placeTimes`: from the later of now and the account's last `executed_at` plus a gap, to `windowEnd`, less a gap on each side of every kept time; platform's `randomTimesInWindow` draws one time per candidate, at least a gap apart; a time `isWindowOpen` calls closed is dropped; sorted, the first candidates take the earliest; as many as fit.
   8. Each time and its quota day written, the update conditional on the step still `scheduled` and unplaced.
   9. When the account has a step placed on today's quota day, or, not skipped, an `executing` step due for its check (beta-p4-040, "The check first"), its sender started, `senderStart(workspaceId, accountId)`, one run at a time per account ("The sender"); the account's line logged, `campaigns: account planned` with `{ skipped, kept, released, placed, sender_started }`.
3. An account that fails leaves the others planned; the activity then fails with its code and Temporal tries it again, the times already placed kept.

Nothing is sent here: the sender claims each step at its time, and linkedin's `reserveSend` refuses anything past the caps or outside the hours, whoever asks.

## The queue

Every `TICK_MINUTES` (15), the schedule `campaigns.queue` runs `campaigns_queue_tick`, global:

1. `campaigns_start_queue_runs`: tenancy's `listWorkspaceIds()`, then for each workspace `campaigns_queue` as `campaigns.queue:<workspaceId>:<slot>`, the tick's 15-minute slot in UTC, with `oneAtATime`. A failed start leaves the others started and fails the tick with its code.
2. `campaigns_queue` `{ workspaceId }`: `campaigns_due_steps`, in a tenant run, first gives a `message_1` left without a due time (its request accepted, its enrollment `active`) one drawn from now once its account allows it (beta-p4-040; README.md "Decided here"), in a run of its own; then the ids of the `planned` `invite` and `message` steps due by now plus `QUEUE_WINDOW_HOURS` (24) whose enrollment is `active`, oldest first; then `campaigns_queue_step` for each, in a tenant run of its own (`queueStep`):
   1. the step still `planned` with a `due_at`, its enrollment `active`, else nothing (`passed_over`);
   2. contacts' `suppressionOf(personId, { newEnrollment: false })` suppressed: nothing, no draft paid for; the suppression subscriber or the gate ends the step;
   3. linkedin's `findSenderAccount` finds no account: nothing (`no_sender`);
   4. the step `awaiting_approval`, conditional on `planned`; approvals' `openItem` with the step's ids, its action and key, `scheduledFor = due_at`, `senderUserId` the account's owner, and `earlierDraftIds` the drafts of the enrollment's `succeeded` steps before it, oldest first; the item's id into `approval_item_id` (`opened`). For a message, approvals asks messaging for the draft, written as the owner; a connection request gets an empty note at once.
3. The run answers `{ opened, passedOver, noSender, failed }`: a step that fails past its attempts counts as `failed`, stays `planned` and comes again next tick.

A step waits in `awaiting_approval` with its item until the owner decides; the next day's run lists `planned` steps only, so it opens nothing new for it.

## The decision

The owner approves or skips the item in "Up next" (approvals' commands); approvals publishes `approvals.item_decided` `{ approvalItemId, stepExecutionId, decision }`. The worker delivers it in a transaction of its own; campaigns' subscriber (`applyDecision`, `domain/decisions.ts`):

1. the step, `awaiting_approval` with the event's item in `approval_item_id`, else nothing (a redelivery, or a decision after a hold or a cancel);
2. the item's stored status from approvals' `decisionsFor([stepExecutionId])`, the step's latest item; not the event's item, neither `approved` nor `skipped`, or without who decided and when: nothing;
3. approved: the step `scheduled` with the item's `draft_id`, conditional on `awaiting_approval`; the daily plan places it;
4. skipped (`skipStep`, the lead locked first, then the enrollment): the step `skipped`, `skipped_by_owner`. A connection request: the enrollment's other pending steps `cancelled` (`skipped_by_owner`) and their items blocked, the enrollment `exited` (`removed`), and the lead `finished` (`removed`, the owner its actor), unless it is suppressed. A message: the next step's `due_at` its delay in business days after the decision, Monday to Friday in the sender's zone (`nextDueAt`), left null once linkedin no longer holds the account, so a redelivery does not fail on it; after the last step, the enrollment `completed` and the lead `finished`.

The gate's `not_approved` and `content_changed` skip a step with the same follow-on, counted from the gate's `at`.

## Acceptance → the first message

1. linkedin detects that a person accepted the account's connection request: its receiver, at the provider's event (beta-p0-060), or its daily check of pending invites, for one the provider missed (beta-p4-070). It publishes `linkedin.invite_accepted` `{ sender_account_id, person_id, detected_at }`, `detected_at` when Whytide learned of it.
2. The worker delivers it in a transaction of its own for the event's workspace; campaigns' subscriber (`recordAcceptance`, `domain/acceptance.ts`):
   1. the person's `active` enrollment with that account, locked (`FOR UPDATE`), then its steps, never the lead, in the stops' one order ("The suppression subscriber"); none, or one a stop ended meanwhile: nothing;
   2. its `connect` step must have gone out (`succeeded`, or `executing` under the sender's claim) with `accepted_at` null, else nothing: a redelivery, a second acceptance, or a request the platform never sent;
   3. `accepted_at = detected_at`, conditional on both; the status stays;
   4. `message_1`, still `planned` without a due time: linkedin's `findSenderAccount` for the zone and the hours, then `due_at = firstMessageDueAt(detected_at, account, random())`, conditional on both. An account linkedin no longer holds, or one whose days hold no weekday: no due time.
3. `firstMessageDueAt`: `detected_at` plus a uniform draw of 1 to 3 hours, never under 10 minutes after it; outside the account's window, or on a Saturday or Sunday in its zone, the next window start on a weekday, the account's hours with its days cut to Monday to Friday, where the window is open.
4. The queue's next run, at most `TICK_MINUTES` later, finds `message_1` due within its 24 hours and opens its item ("The queue"); once the owner approves it, the plan draws its time in the window, never before `due_at`.

The subscriber calls no provider and starts no workflow: nothing is sent here, and the step still passes the approval, the plan and the gate.

## The sender

The plan starts `campaigns_sender` `{ workspaceId, accountId }` for an account with a step placed on today's quota day, as `campaigns.sender:<workspaceId>:<accountId>`, one run at a time (README.md "Worker"). The run takes one step at a time:

1. `campaigns_sender_next`: the account's earliest `scheduled` step on today's quota day whose `scheduled_for` is no more than `MIN_ACTION_GAP_MS` behind now, and the wait, until the later of its time and the account's last `executed_at` plus the gap. None: the run ends `no_step`. A step further behind is the plan's to place again; an account linkedin no longer holds has none.
2. A wait: the workflow sleeps, a tick at most, and goes back to 1, as the plan, a hold or a stop may have moved the steps meanwhile.
3. A message: linkedin's `linkedin_check_reply` reads the chat (a `send_check` read). A reply found sets the outreach row's `last_inbound_at`, and the claim's gate holds the person. A refused read is recorded by the claim's activity as a refused slot is (4); an answer that is no refusal, a port's error, ends the run `refused` with no write, the step left placed.
4. `campaigns_sender_claim`, one tenant run:
   1. more than a gap past its time (after a slow read), or no longer `scheduled` at the time read: `step_not_ready`, no write; back to 1;
   2. the gate ("The gate"): a block writes its outcome, and `touched_today` also clears the time, so the plan places the step another day; back to 1;
   3. another step of the person `executing`: `send_in_flight` (beta-p4-040), unplaced; back to 1;
   4. the claim: `executing`, `attempt + 1`, `error_code` null, conditional on `scheduled` and the time read;
   5. an invite or a message: `credits.reserve` of `campaigns.linkedin_send` × 1 under `<idempotency_key>:<attempt>`, lease `async`, its usage in `credit_usage_id`. `insufficient_credits` rolls the run back; a second run writes the code on the step, `scheduled` and unplaced, with no slot; the run ends `refused`;
   6. linkedin's `reserveSend` with the step's own key. A refusal: the credits released in the run; the step back to `scheduled`, unplaced, the code in `error_code`, `due_at` moved to `retryAt` when later; the run ends `refused` when `retryAt` is null or the code is `rate_limited`, else back to 1.
5. `campaigns_sender_prepare`: in a run, the person's member id (contacts' `getPerson`, its `providerRefs` under `unipile`) and the approved text (approvals' `approvedContent`); after it, the file `raw/campaigns/<stepExecutionId>/send.json` written through the files port. No member id (`member_ref_unknown`), or a person erased (`person_not_found`): the holds freed, the step back to `scheduled`, unplaced; an approval gone since the claim: the gate's block, the holds freed; back to 1.
6. `campaigns_sender_gate`: the file read and its text hashed (an invite's note, empty when none, or a message's text), then the gate in a run. A block, or an approved hash that differs from the file's (`content_changed`, the step `skipped` with the owner's skip's follow-on, "The decision"): the holds freed, a `touched_today` step unplaced, the file deleted; back to 1. A pass writes `jit_checks`: what the gate saw, `approvalItemId` and `contentHash`.
7. linkedin's activity for the action, `stepAttempt` the step's `attempt`: with the step's attempt or Temporal's above 1, or an earlier outcome unknown, it checks first and makes no second call for a send that went out (linkedin's docs/flows.md "The send activities").
8. `campaigns_sender_settle`, one tenant run, on the answer:
   - `{ sent: true }`: `credits.commit`, then `commitSend`; the person's rows locked, the lead after the last step only, then the enrollment, then the step; the step `succeeded` with `executed_at` and `error_code` null; the next step, still `planned`, due its delay in business days after the send, Monday to Friday in the sender's zone (`message_1` waits for the acceptance); contacts' `recordTouch` (a person erased meanwhile has none); `campaigns.step_sent`; after `follow_up_2`, the enrollment `completed` with `ended_at` and the lead `finished`. A commit answering `usage_not_open` leaves the step `succeeded` and logs `campaigns: send_uncharged`. Back to 1.
   - a refusal before the call, `{ refused, retryAt }` with its slot no longer `reserved` (the activity's re-read of the refusals, `reservation_not_open` after a pause): as 4.6's refusal, linkedin having freed the slot.
   - a port's error `{ refused, retryAfterSec? }`, or a code no refusal names: "The error map".
   - a refused check that kept its slot `reserved`, or no answer, the activity failing (one attempt): the step stays `executing` with its credits and slot, its file kept, and the run ends `unsettled`; the next run's check settles it ("The check first").
   Then the file is deleted, but for a step left `executing`.

A cancelled run waits for the send activity's attempt to end (`WAIT_CANCELLATION_COMPLETED`), so it never closes while a call may go out. The claim and the settle are conditional on the status read, so a retried activity changes nothing twice: a repeated settle finds the step `succeeded`, and credits and linkedin answer a repeated commit as the first.

## The withdrawal

Daily at 05:00 UTC, the schedule `campaigns.withdraw` runs `campaigns_withdraw_tick`, global (README.md "Worker", "Withdrawals"):

1. `campaigns_start_withdrawals`: tenancy's `listWorkspaceIds()`, then `startWorkflow(withdrawStart(workspaceId, now))` for each, `campaigns.withdraw:<workspaceId>:<UTC date>`, one run at a time. A failed start leaves the others started and fails the tick with its code.
2. `campaigns_withdraw` `{ workspaceId }`, its activity `campaigns_open_withdrawals` in a tenant run, `openWithdrawals(now)`: the `active` enrollments, then their `connect` steps `succeeded` with `executed_at` at least 21 × 24 hours before now and `accepted_at` null; for each, a step `withdraw`, `position` 1, `action_type` `withdraw`, the request's hash, its key followed by `:withdraw`, `scheduled`, `due_at` now and no item, inserted unless the enrollment has one (`ON CONFLICT DO NOTHING`). It answers `{ opened }`.
3. The plan places it in the account's window, before the invites ("The daily plan"); the queue opens no item for it ("The queue").
4. The sender takes it as any step ("The sender"), but:
   1. the gate, at the claim and before the call, checks the request's `accepted_at` in place of an approval: set, the step `cancelled` (`invite_accepted`), its holds freed, the enrollment going on; the check is in `jit_checks.invite`;
   2. the claim reserves no credits, and linkedin's `reserveSend` takes `actionType: "withdraw"`: within 15 a day and the 200, in the window, on a weekday, under no switch, its refusals as any step's;
   3. the request file holds the member id and the step's key, no note and no text, and the second gate compares no hash;
   4. the call is linkedin's `linkedin_withdraw_invite`, on the outreach row's invitation, which sets its `withdrawn_at`.
5. `campaigns_sender_settle`, the lead locked, then the enrollment, then the step:
   - `{ sent: true }`: linkedin's `commitSend`; the step `succeeded` with `executed_at`; contacts' `recordTouch`; `campaigns.step_sent` `{ stepExecutionId, personId, actionType: "withdraw" }`; then 6;
   - `{ refused }` with `linkedin_not_found` or `linkedin_send_refused`, no `retryAt`, its slot `committed` (linkedin's `findSendReservation`): the invitation is already gone, declined or withdrawn by hand; the step `failed` with the code and `executed_at`; the touch all the same; no event; then 6, and the run goes on;
   - any other answer: as any step's.
6. The end, unless the request's `accepted_at` was set meanwhile: the enrollment `exited` (`not_accepted`) with `ended_at`, while `active`; its pending steps `cancelled` (`not_accepted`) with their items blocked (approvals' `cancelItems`); the lead `finished` (`recordLeadStatus`, the template's id, the system). For 90 days from the touch, contacts' `suppressionOf(personId, { newEnrollment: true })` answers `recently_contacted`, so an Approve enrolls nothing ("Approve → enrollment").

An acceptance recorded after the gate's last check: the settle ends nothing, a call answered `linkedin_not_found` leaves the step `failed` with no touch, and the enrollment goes on with its `message_1`. A person erased meanwhile has no touch to record.

## The read before an invite

A connection request whose person has no member id under contacts' `providerRefs.unipile` (`MEMBER_REF_KEY`) is read first (beta-p4-030), behind `patched("member-reference")`: `campaigns_sender_next` answers `memberRefUnknown` for it (false for a person erased, whom the gate stops), and the sender takes this way in place of "The sender"'s 4:

1. `campaigns_sender_claim` with `mode: "credits"`: as 4.1 to 4.5, no slot. `insufficient_credits` stops here: nothing is read, and the run ends `refused`.
2. `campaigns_profile_prepare`, in a run: the step still `executing` (else `step_not_ready`, its credits freed) and its person (erased: `person_not_found`, the credits freed, the step back to `scheduled`, unplaced; a stored URL off linkedin's `profileRequestFile`: no read, the credits freed, the step `failed` `linkedin_input_invalid` and its enrollment ended as "The error map" says, beta-p4-040), each counted `blocked`, the run going on ("The sender"'s 1); then linkedin's `reserveReads` of one `read_profile`, the step as its object, which writes a `read_profile` row and counts in the day's reads and the 200. A refusal (a switch, a disconnected or paused account, `rate_limited`, `outside_working_hours`, `read_cap_reached`, `daily_actions_cap_reached`): the credits released, the step back to `scheduled`, unplaced, the code in `error_code`, `due_at` moved to `retryAt` when later; the run ends `refused` when `retryAt` is null or the code is `rate_limited`, else it goes on ("The sender"'s 1). After the run, the request file `raw/campaigns/<stepExecutionId>/profile.request.json`, linkedin's `profileRequestFile` with the person's stored `linkedin_url`; a write that fails releases the read.
3. linkedin's `linkedin_read_profile` `{ workspaceId, accountId, requestKey, rawKey }` by name (`PROFILE_READ_TIMEOUT`, 2 minutes; `WAIT_CANCELLATION_COMPLETED`; `PROFILE_READ_ATTEMPTS`, 3 attempts at most, linkedin's own, beta-p4-040): the profile written at `raw/campaigns/<stepExecutionId>/profile.json` and a `read_profile` row `ok`, or `{ refused }`.
4. `campaigns_profile_settle`, in a run, the profile file read before it; a settle retried once that file is gone, deleted by an attempt whose answer was lost, answers `{ stored, readAt, waitMs }` from the person's member id (beta-p4-040):
   - a profile: `commitReads`; contacts' `upsertPersonFromSource` (`source` `linkedin`, `provider` `unipile`) at the person's stored URL, with the profile's business fields and `providerId` its `providerMemberRef`, which `providerRefs` keeps; a person erased meanwhile (`person_erased`, `person_not_found`) stores nothing. `{ stored, readAt, waitMs }`.
   - `linkedin_not_found`: the credits released, `commitReads`; the lead locked, then the enrollment; the step `failed` with `profile_unreadable`, the enrollment's other pending steps `cancelled` (`profile_unreadable`) and their items blocked, the enrollment `exited` (`send_refused`) with `ended_at`, the lead `finished` (a suppressed one stays so). Counted `blocked`, and the run goes on ("The sender"'s 1).
   - another refusal (`linkedin_account_disconnected`, `linkedin_provider_error`; or, before the call, `account_paused` or `linkedin_rate_limited`, beta-p6-020): the credits released, `commitReads`, as signals settles its reads; no answer, the read failing past its attempts: the credits released, `releaseReads`. Either way the step back to `scheduled`, unplaced, with the code when `STEP_REASON_CODES` lists it, else `member_ref_unknown`; the run ends `refused`.
   Then both files are deleted.
5. A sleep of `waitMs`: `MIN_MINUTES_AFTER_PROFILE_READ` (3) from the settle's time, which follows the read's answer (`useProfileReadWait` shortens it under `APP_ENV=test` only). The credits' `async` lease covers it, and no slot is held.
6. `campaigns_sender_claim` with `mode: "slot"` and the step's `usageId`: the step still `executing`, the gate again ("The gate": a person suppressed, or replying, during the wait is blocked, the credits freed), then linkedin's `reserveSend`, a refusal freeing the credits as 4.6's.
7. Then "The sender"'s 5 to 8: the request file, with the member id now, the gate right before the call, the invite and the settle.

A read refused, then the step placed again and invited, charges one send: its key `:1` released, `:2` committed. The history holds the two files' keys, never their bodies.

## The check first

beta-p4-040, with the patch `check-executing`. Before its first claim the sender reads the account's `executing` steps due for their check (`campaigns_sender_checks`: `due_at` null or past, oldest first) and, for each:

1. `campaigns_sender_prepare` with `check: true`: the request file written again from the step, its holds kept. When it cannot be (no member id, no approved text, a file off the port's schema), the file the send left is checked as it is; with none, no call was made, since a send reads its file and an `executing` step keeps it: the credits released, the step back to `scheduled`, unplaced, waiting on that reason (`member_ref_unknown`, `not_approved`, `linkedin_input_invalid`), due at the check's time when it has no due time, and the sender goes to the next check.
2. linkedin's `linkedin_check_sent` `{ workspaceId, accountId, requestKey }` (linkedin's docs/flows.md "The send activities"): a `send_check` read, refused while the account's `retry_at` is ahead.
3. `campaigns_sender_settle` on its answer:
   - `sent`: settled as a send that went out ("The sender", 8; a withdrawal as "The withdrawal", 5, says, its invitation no longer pending, whether withdrawn or declined meanwhile), linkedin having committed the slot; a commit answering `usage_not_open` is logged `campaigns: send_uncharged`;
   - `not_sent`: linkedin released the slot; the credits released, the step back to `scheduled`, unplaced, with no code, for the plan, due at the check's time when it has no due time (one kept after an unknown outcome: the plan places due steps only); the next claim raises `attempt`, so its credits are reserved again under a new key;
   - a refusal with no call (not a port's code): the step stays `executing`, `due_at` its `retryAt`, or the next quota day's start when none; the run ends `unsettled`;
   - a port's error on the check (a `linkedin_…` code): the step stays `executing`, `due_at` the next quota day's start; the run ends `unsettled`. An outage costs one check a quota day.

The send itself: one attempt (`maximumAttempts: 1`), so a lost answer is never retried in the run; the gate right before the call is asked again while its pass is older than `GATE_FRESH_MS` (60 s of the workflow's time) when the call is scheduled; a step more than a gap past the later of its time and its slot's reservation at that gate (a connection request's slot is taken the read's wait after its time, "The read before an invite") has its holds freed and goes back for the plan; and `campaigns_sender_next` counts a step left `executing` in the gap from its gate's pass (`jit_checks.at`).

## The error map

A port's error after the call, `{ refused, retryAfterSec? }`, by linkedin's `SEND_ERROR_MAP` (linkedin having settled the slot, `retry_at` and the health), in `campaigns_sender_settle`:

| Answer | Credits | Step | Run |
|---|---|---|---|
| `linkedin_rate_limited` | released | `scheduled`, unplaced, `due_at` now + `retryAfterSec` | ends |
| `linkedin_provider_error`, `linkedin_output_invalid`, `linkedin_error_unmapped` | kept | `executing`, `due_at` null: checked at the next run past linkedin's pause | ends `unsettled` |
| `linkedin_send_refused`, `linkedin_not_found` | released | `failed`; the enrollment `exited` (`send_refused`), its pending steps `cancelled` with the code and their items blocked, the lead `finished` | goes on |
| `linkedin_limit_reached`, `linkedin_account_disconnected` (any reason) | released | `scheduled`, unplaced, `due_at` the next quota day's start | ends |
| `linkedin_input_invalid` | released | `failed`; the enrollment `exited` (`send_refused`, `exit_detail` `linkedin_input_invalid`) | goes on |

A withdrawal's `linkedin_not_found` or `linkedin_send_refused` with its slot `committed` is not the map's: "The withdrawal", 5, settles it first, the enrollment `not_accepted`. A code the map does not have is `linkedin_error_unmapped`'s. A request file off the port's schema before the call (`campaigns_sender_prepare`) is `linkedin_input_invalid`'s row, with no call. A failed step locks the lead, the enrollment, the steps, then the items: the stops' one order. A waiting step's code and `due_at` go on its approved item for "Up next" (`noteItemWait`), cleared at its next claim; `invites_paused` refuses connection requests only, so the run goes on with the account's messages.

## A replaced account

linkedin publishes `linkedin.account_replaced` `{ sender_account_id }` when another LinkedIn account is behind the row. campaigns' subscriber, in the delivery's transaction, takes each `active` enrollment of the account, oldest id first: the lead, then the enrollment locked; the enrollment `exited` (`no_sender`, `exit_detail` `account_replaced`, `ended_at`); its `planned`, `awaiting_approval` and `scheduled` steps `cancelled` (`skip_reason` `account_replaced`) and their pending items blocked (approvals' `cancelItems`); the lead `finished`. An `executing` step is left to the sender's check, which settles it on the account it went from. A redelivery finds no `active` enrollment and changes nothing.
