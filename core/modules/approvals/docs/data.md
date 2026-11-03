# approvals: data

`approval_items` (`apv_`, tenant; `packages/db/prisma/schema/approvals.prisma`, migration `20261029114318_approvals_initial`):

- Ids only, no foreign key: `workspace_id`, `step_execution_id` (campaigns'), `person_id`, `sender_account_id`, `draft_id` (messaging's, null until attached), `decided_by` (a user).
- `action_type` (`invite`, `message`), `step_key`, `scheduled_for` (the step's due time at the open), `status` (`pending`, `approved`, `skipped`, `blocked`), `approved_content_hash`, `decided_at`, `decision_origin` (`app`), `wait_code`, `wait_until`, `created_at`, `updated_at`.
- Keys: one `pending` and one `approved` item per step (partial unique keys); indexes `(workspace_id, status, scheduled_for)` and `(workspace_id, person_id)`.
- CHECKs: the hash exactly on an approved item; the decision's user, time and origin exactly on an approved or skipped one; a wait on an approved one only.
- PII: none. The table holds no text and no name; the person is an id.
- Retention: kept with the step; deleted with the person by the deletion script (privacy's eraser).
