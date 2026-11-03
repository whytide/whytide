# campaigns: data

Both tables are tenant tables (`workspace_id` first in every key and index), from migration `20261029122327_campaigns_initial`, with no foreign key to another module: `person_id` is contacts' person, `sender_account_id` linkedin's account, both plain ids. No column holds a message's text, a name or a URL: ids, codes, hashes and times only, so no PII class but `none`.

## `enrollments`

Ids `enl_…`. One row per approval delivered: the person's way through the template.

| Column | What |
|---|---|
| `person_id` | the enrolled person |
| `sender_account_id` | the approver's connected account; null for `no_sender`, and for `suppressed`, decided before the sender |
| `template_id`, `template_version` | `linkedin_default`, 1 |
| `status` | `active` · `replied` · `completed` · `exited` (enum `enrollment_status`) |
| `exit_reason` | `suppressed` · `removed` · `no_sender` · `not_accepted` · `send_refused` (enum `enrollment_exit_reason`), set exactly when `exited` |
| `exit_detail` | a code of `EXIT_DETAILS`: the suppression reason behind `suppressed`; `account_replaced` behind `no_sender` and `linkedin_input_invalid` behind `send_refused` (beta-p4-040); null otherwise |
| `source_event_id` | the `contacts.lead_approved` event the row came from |
| `started_at` | when the enrollment started; null for one that exited at its creation |
| `ended_at` | set exactly when the status is not `active` |

Keys: unique `(workspace_id, source_event_id)`; the partial unique `enrollments_active_person` `(workspace_id, person_id) WHERE status = 'active'`, one active enrollment per person; index `(workspace_id, person_id)`. CHECKs `enrollments_exit_reason` and `enrollments_ended_at`.

## `step_executions`

Ids `sx_…`. One row per step of an enrollment, four at enrollment. The withdrawal job adds a fifth, `withdraw` (`position` 1, its key the `connect` step's followed by `:withdraw`, `scheduled` when written; README.md "Withdrawals"); `failed` when the invitation was already gone, with the settle's time in `executed_at` and linkedin's code in `error_code`.

| Column | What |
|---|---|
| `enrollment_id` | foreign key `(workspace_id, enrollment_id)` to `enrollments`, restricting a delete |
| `person_id`, `sender_account_id`, `template_id`, `template_version` | the enrollment's |
| `step_key`, `position`, `action_type` | the template's step: `invite` · `message` · `withdraw` (enum `step_action_type`) |
| `step_template_hash`, `idempotency_key` | SHA-256 hex (README.md "The template") |
| `status` | `planned` · `awaiting_approval` · `scheduled` · `executing` · `succeeded` · `failed` · `skipped` · `held` · `cancelled` (enum `step_execution_status`), `planned` when written |
| `due_at` | when the step may go: `connect`'s the enrollment's time, `message_1`'s the acceptance's draw (beta-p4-050), the others' null until their anchor happens; on an `executing` step, when the sender's check may run, null or past for now (beta-p4-040) |
| `scheduled_for`, `quota_day` | the send's slot and its quota day (`YYYY-MM-DD`, as linkedin's, CHECK `step_executions_quota_day_date`), set by the plan (beta-p4-010), cleared by the sender when the step waits again (beta-p4-020) |
| `executed_at`, `attempt` | the send's time; the claims made, 0 at first |
| `jit_checks` | what the gate saw (jsonb): `at`, then what each check that ran saw (statuses, the suppression's answer, instants, the quota day), never a name or a text; written by a block, and by the sender with its send (beta-p4-020), with the approval check's `approval` (`approvalItemId`, `status`, `contentHash`); null until then |
| `skip_reason`, `error_code` | codes of `STEP_REASON_CODES`: a stop's reason in `skip_reason` beside its status (`held`, `cancelled`, `skipped`), in `error_code` what a `scheduled` step waits on: the gate's `touched_today` with the status kept (README.md "The gate") and the sender's waits (`insufficient_credits`, `member_ref_unknown`, linkedin's refusals), cleared by the claim and the send; on a connection request `failed` at its profile read, `profile_unreadable` (beta-p4-030); null otherwise |
| `approval_item_id`, `draft_id` | approvals' item, set by the queue with `awaiting_approval`; messaging's draft, set with `scheduled` when the item is approved |
| `credit_usage_id`, `accepted_at` | the claim's credit reservation, credits' usage under `<idempotency_key>:<attempt>`, set by the sender's claim for an invite or a message and cleared when the step waits again; on `connect`, the acceptance's detection time, written once by the acceptance subscriber (beta-p4-050), null until then |

Keys: unique `(workspace_id, enrollment_id, step_key)`; the partial unique `step_executions_key_claimed` `(workspace_id, idempotency_key) WHERE status IN ('executing', 'succeeded')`; indexes `(workspace_id, sender_account_id, status, scheduled_for)` and `(workspace_id, person_id)`.

The partial indexes and the CHECKs are hand-written SQL in the migration. Grants and policies are alpha's tenant tables': `app` reads and writes through the roles migration's default privileges, and no row-level policy before zeta (docs/rules/security.md §3).

## Retention and erasure

Rows keep their end state and are never deleted, but by `erasePerson`, which privacy's deletion script runs: a person's step executions, then their enrollments, go with the person (data model §6.1).
