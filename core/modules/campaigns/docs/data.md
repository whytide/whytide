# campaigns: data

Five tenant tables (`workspace_id` first in every key and index): `enrollments` and `step_executions` from migration `20261029122327_campaigns_initial`; `campaigns`, `campaign_versions` and `steps` from `20261101124816_campaigns_versions` (gamma-p3-030), after `20261101124700_campaigns_email_action`, which adds `email` to `step_action_type` alone, as Postgres refuses a new value in the transaction that adds it; `campaigns.playbook_id` from `20261112053623_campaigns_playbooks` (gamma-p3-065); the approval mode's four columns from `20261112231650_campaigns_approval_mode` (gamma-p4-070). No foreign key to another module: `person_id` is contacts' person, `sender_account_id` linkedin's account, `playbook_id` playbooks' agent, `owner_user_id` and `created_by` a user's id, all plain ids. No column holds a message's text, a person's name or a URL: ids, codes, hashes, times and a campaign's name only, so no PII class but `none`.

## `campaigns`

Ids `cmp_…`. One row per campaign; the seeded one is made on first use (README.md "Campaigns and versions").

| Column | What |
|---|---|
| `key_ref` | what enrollments and step executions carry as `template_id`: `linkedin_default` for the seeded campaign, its own id for any other |
| `name` | 1 to 80 characters; empty for the seeded campaign |
| `status` | `draft` · `active` · `paused` · `completed` · `archived` (enum `campaign_status`); gamma-p3-030 writes `draft` and `active` |
| `owner_user_id` | the member whose accounts the campaign sends from (gamma-p6-040); the user of the workspace's oldest `Owner` membership for the seeded one |
| `current_version_id` | foreign key `(workspace_id, current_version_id)` to `campaign_versions`: the version new enrollments join; null until the first is written |
| `paused_reason`, `paused_at` | `user` · `bounce_rate` (enum `campaign_pause_reason`) and when: both set exactly while `paused` (CHECK `campaigns_paused`, gamma-p3-060) |
| `launched_at`, `created_by` | when it was launched: the seeded campaign at its creation, a draft at its launch (`launchCampaign`, gamma-p3-050), null before; a user's id, or `system` |
| `playbook_id` | the agent it was made for, on playbooks' `playbook_created` (README.md "Agents' campaigns", gamma-p3-065): its leads are enrolled here; null for the seeded campaign and any campaign made without an agent |
| `approval_mode` | `review_everything` (the default) · `review_first_touches` (enum `campaign_approval_mode`; README.md "The approval mode", gamma-p4-070) |
| `review_locked_until` | not null: the creation plus 7 days, the migration's time plus 7 days for the campaigns before it; until then the mode in force is `review_everything` |
| `approval_mode_set_by`, `approval_mode_set_at` | the member who last changed the mode, and when: both null until a change, else both set (CHECK `campaigns_approval_mode_set`) |

Keys: unique `(workspace_id, key_ref)`; the partial unique `campaigns_playbook (workspace_id, playbook_id) WHERE playbook_id IS NOT NULL`, one campaign per agent, in the migration's hand-written SQL (Prisma declares no partial index); indexes `(workspace_id, status)` and `(workspace_id, owner_user_id)`.

## `campaign_versions` and `steps`

Ids `cmv_…` and `stp_…`. A version of a campaign (`campaign_id`, foreign key `(workspace_id, campaign_id)`), `version_no` from 1, what enrollments carry as `template_version`, `change_kind` `initial` or `structural` (enum `campaign_change_kind`) and `created_by`; and its steps (`campaign_version_id`, foreign key `(workspace_id, campaign_version_id)`), each with its `position` from 1, `step_key` (`STEP_KEYS`), `action_type` (`invite` · `message` · `email`), `channel` (`linkedin` · `email`, enum `step_channel`), `delay` (jsonb, the template's `StepDelay`) and `step_template_hash`. Keys: unique `(workspace_id, campaign_id, version_no)`; unique `(workspace_id, campaign_version_id, position)` and `(workspace_id, campaign_version_id, step_key)`. `app` may not update or delete either (`REVOKE UPDATE, DELETE`): a version never changes once saved.

## `enrollments`

Ids `enl_…`. One row per approval delivered: the person's way through a campaign's version.

| Column | What |
|---|---|
| `person_id` | the enrolled person |
| `sender_account_id` | the campaign owner's connected account (gamma-p6-040; beta's rows: the approver's); null for `no_sender`, and for `suppressed`, decided before the sender |
| `template_id`, `template_version` | the campaign's `key_ref` and the version's `version_no`: `linkedin_default`, 1 for beta's rows and the seeded campaign's version 1 |
| `status` | `active` · `paused` · `replied` · `completed` · `exited` (enum `enrollment_status`; `paused` from `20261102110318_campaigns_paused_status`, a migration of its own) |
| `paused_reason`, `paused_until` | `user` · `out_of_office` (enum `enrollment_pause_reason`), set exactly while `paused`, and when it resumes, only then, null for a resume by hand (CHECK `enrollments_paused`) |
| `exit_reason` | `suppressed` · `removed` · `no_sender` · `not_accepted` · `send_refused` (enum `enrollment_exit_reason`), set exactly when `exited` |
| `exit_detail` | a code of `EXIT_DETAILS`: the suppression reason behind `suppressed`; `account_replaced` behind `no_sender` and `linkedin_input_invalid` behind `send_refused` (beta-p4-040); `owner_removed` behind `no_sender` (gamma-p6-040); null otherwise |
| `source_event_id` | the `contacts.lead_approved` event the row came from |
| `started_at` | when the enrollment started; null for one that exited at its creation |
| `ended_at` | set exactly when the status is neither `active` nor `paused` |
| `resumed_at` | when an out-of-office reply's hold was released, the reply's instant (gamma-p4-050): the gate's reply check counts replies after the later of `started_at` and it; null otherwise |
| `reply_label`, `reply_label_at` | the last reply label acted on, a code of `REPLY_ACTION_LABELS`, and its reply's instant, set together (CHECK `enrollments_reply_label`) |
| `remind_at`, `remind_user_id`, `reminded_at` | a `not_now` reply's reminder: when it is due and the user it mails, set together, and when the queue run published it, only once set (CHECK `enrollments_remind`); `remind_user_id` is a plain id of tenancy's user |
| `cool_down_until` | a `not_interested` reply's end of the cool-down, `CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS` (180 unset) days after it: no new enrollment of the person before |

Keys: unique `(workspace_id, source_event_id)`; the partial unique `enrollments_active_person` `(workspace_id, person_id) WHERE status IN ('active', 'paused')`, one live enrollment per person (recreated by `20261102110350_campaigns_fallback_pause`); indexes `(workspace_id, person_id)` and `(workspace_id, remind_at)` (`20261105123444_campaigns_reply_actions`); `(workspace_id, template_id, status)`, an enrollment's campaign for the funnel, and `(workspace_id, sender_account_id, ended_at)`, a sender's replies for the counts (`20261112091353_campaigns_funnel_indexes`, gamma-p6-080). CHECKs `enrollments_exit_reason`, `enrollments_ended_at`, `enrollments_paused`, `enrollments_reply_label` and `enrollments_remind`.

## `step_executions`

Ids `sx_…`. One row per step of the enrollment's version, written at enrollment: four for the seeded campaign's version 1. The withdrawal job adds one more, `withdraw` (`position` 1, its key the `connect` step's followed by `:withdraw`, `scheduled` when written; README.md "Withdrawals"); `failed` when the invitation was already gone, with the settle's time in `executed_at` and linkedin's code in `error_code`.

| Column | What |
|---|---|
| `enrollment_id` | foreign key `(workspace_id, enrollment_id)` to `enrollments`, restricting a delete |
| `person_id`, `template_id`, `template_version` | the enrollment's |
| `sender_account_id`, `mailbox_id` | a LinkedIn step's sender account, the enrollment's; an email step's mailbox, a plain id set from gamma-p4-010. CHECK `step_executions_channel_actor`: `sender_account_id` null exactly for an email step, `mailbox_id` null on every other |
| `step_key`, `position`, `action_type` | the version's step: `invite` · `message` · `withdraw` · `email` (enum `step_action_type`) |
| `step_template_hash`, `idempotency_key` | SHA-256 hex (README.md "Campaigns and versions") |
| `status` | `planned` · `awaiting_approval` · `scheduled` · `executing` · `succeeded` · `failed` · `skipped` · `held` · `cancelled` (enum `step_execution_status`), `planned` when written |
| `due_at` | when the step may go: `connect`'s the enrollment's time, `message_1`'s the acceptance's draw (beta-p4-050), or the same draw from the settle that skips a connection request to a connection already (connect-already-connected), the others' null until their anchor happens; on an `executing` step, when the sender's check may run, null or past for now (beta-p4-040) |
| `scheduled_for`, `quota_day` | the send's slot and its quota day (`YYYY-MM-DD`, as linkedin's, CHECK `step_executions_quota_day_date`), set by the plan (beta-p4-010), cleared by the sender when the step waits again (beta-p4-020) |
| `executed_at`, `attempt` | the send's time; the claims made, 0 at first |
| `jit_checks` | what the gate saw (jsonb): `at`, then what each check that ran saw (statuses, the suppression's answer, instants, the quota day), never a name or a text; written by a block, and by the sender with its send (beta-p4-020), with the approval check's `approval` (`approvalItemId`, `status`, `contentHash`); null until then |
| `skip_reason`, `error_code` | codes of `STEP_REASON_CODES`: a stop's reason in `skip_reason` beside its status (`held`, `cancelled`, `skipped`), in `error_code` what a `scheduled` step waits on: the gate's `touched_today` with the status kept (README.md "The gate") and the sender's waits (`insufficient_credits`, `member_ref_unknown`, linkedin's refusals), cleared by the claim and the send; on a connection request `failed` at its profile read, `profile_unreadable` (beta-p4-030); null otherwise |
| `approval_item_id`, `draft_id` | approvals' item, set by the queue with `awaiting_approval`; messaging's draft, set with `scheduled` when the item is approved |
| `credit_usage_id`, `accepted_at` | the claim's credit reservation, credits' usage under `<idempotency_key>:<attempt>`, set by the sender's claim for an invite or a message and cleared when the step waits again; on `connect`, the acceptance's detection time, written once by the acceptance subscriber (beta-p4-050), null until then |

Keys: unique `(workspace_id, enrollment_id, step_key)`; the partial unique `step_executions_key_claimed` `(workspace_id, idempotency_key) WHERE status IN ('executing', 'succeeded')`; indexes `(workspace_id, sender_account_id, status, scheduled_for)`, `(workspace_id, person_id)` and `(workspace_id, sender_account_id, executed_at)`, a sender's sends for the counts (`20261112091353_campaigns_funnel_indexes`, gamma-p6-080).

The partial indexes, the CHECKs and the `REVOKE` are hand-written SQL in the migrations. Grants and policies are alpha's tenant tables': `app` reads and writes through the roles migration's default privileges, but for the versions' rows, and no row-level policy before zeta (docs/rules/security.md §3).

## Retention and erasure

Campaigns, their versions and their steps hold no person's data and are kept. Enrollment and step rows keep their end state and are never deleted, but by `erasePerson`, which privacy's deletion script runs: a person's step executions, then their enrollments, go with the person (data model §6.1).
