# approvals: data

`approval_items` (`apv_`, tenant; `packages/db/prisma/schema/approvals.prisma`, migrations `20261029114318_approvals_initial` and `20261112101005_approvals_email_and_mode`, gamma-p4-090):

- Ids only, no foreign key: `workspace_id`, `step_execution_id` (campaigns'), `person_id`, `sender_account_id` (linkedin's, null on an email item), `mailbox_id` (email's, an email item's only), `draft_id` (messaging's, null until attached), `decided_by` (a user, null on the mode's approval).
- `action_type` (`invite`, `message`, `email`), `step_key`, `scheduled_for` (the step's due time at the open), `status` (`pending`, `approved`, `skipped`, `blocked`), `approved_content_hash`, `decided_at`, `decision_origin` (`app`, a person's; `approval_mode`, the campaign's mode's), `wait_code`, `wait_until`, `approval_by` (`person`, the default, or `mode`), `created_at`, `updated_at`.
- Keys: one `pending` and one `approved` item per step (partial unique keys); indexes `(workspace_id, status, scheduled_for)`, `(workspace_id, person_id)` and `(workspace_id, step_execution_id)`, every status, for `decisionsFor`.
- CHECKs: the hash exactly on an approved item; the decision's time and origin exactly on an approved or skipped one, and its user too unless the origin is `approval_mode`, which only an approved item opened for the mode has, never an invite (`approval_items_decision`); a wait on an approved item, or `mode_declined` alone, with no time, on a pending item opened for the mode (`approval_items_wait`); an `email` item has a mailbox and no sender account, every other the reverse (`approval_items_channel_sender`). The new enum values are compared as text, as the migration adds them in its own transaction.
- PII: none. The table holds no text and no name; the person is an id.
- Retention: kept with the step; deleted with the person by the deletion script (privacy's eraser).
