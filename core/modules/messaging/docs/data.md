# messaging: data

## `message_drafts`

One row per draft, a tenant table (`workspace_id`, indexed with `person_id` and `created_at`), migration `20261027100000_messaging_drafts`, ids `mdr_…`. No foreign key: the person is contacts', the records ai's. Since `20261029092149_messaging_step_drafts` (beta-p3-010) it holds a sequence step's drafts too, beside the lead's; since `20261101125854_messaging_email_channel` and `20261101125855_messaging_email_drafts` (gamma-p3-070), emails; since `20261102113116_messaging_disclosure` (gamma-p4-080), `disclosure_applied`.

| Column | What | PII class |
|---|---|---|
| `person_id`, `channel`, `status` | the lead, `linkedin_note`, `linkedin_message` or `email`, `drafting` · `ready` · `flagged` · `failed` · `edited` · `approved` (a step's draft only) | none |
| `kind` | `lead_draft` (alpha's panel; every row before beta) or `outbound_step` (a sequence step's), enum `message_draft_kind` | none |
| `step_execution_id`, `step_key` | a step's draft: campaigns' `sx_` id, no foreign key, and the template's step key (`STEP_KINDS`); null for a lead's draft | none |
| `plan` | `{ angle, factIds, cta, decisionRecordId }`, the planner's last answer and its call's record | none |
| `text` | the writer's last text | `business_contact` |
| `edited_text`, `edited_at` | a member's own text (`PATCH …/drafts/{id}`) and when it was saved; a step's final text at its approval when it differs from `text`, the campaign's mode's always (gamma-p4-080) | `business_contact` |
| `subject`, `edited_subject` | an email's subject as the writer wrote it, and the member's or the owner's; null for a follow-up and off an email | `business_contact` |
| `mailbox_id` | a step's email: the mailbox it is sent from, a plain id its caller gives, no foreign key | none |
| `step_kind` | the kind a lead's draft is written as (`WRITTEN_STEP_KINDS`); null for none, and for a step's, whose key says it | none |
| `model_id`, `prompt_version`, `decision_record_id` | the last call's: the write's, else the plan's; the panel's history shows the model and version | none |
| `dossier_hash` | the dossier's hash when written; another than today's makes the draft stale in the panel | none |
| `gates` | the last round's `{ gate, issues }`, in the gates' order | `business_contact`: an issue may name a text's words |
| `regenerations` | 0 to 2 | none |
| `flag_reasons` | the issues a flagged draft was left with, or a failed one's `{ code }` | `business_contact`, as `gates` |
| `edited_by_user`, `edit_ratio` | set by approvals' path (beta-p3-020): the member changed a step's text, and by how much, 0 to 1 (`decimal(4,3)`) | none |
| `approved_at` | when a step's draft was approved | none |
| `disclosure_applied` | approved by the campaign's mode, never a person: `edited_text` ends with the channel's AI disclosure line (gamma-p4-080); false, the default, for a person's approval and every other draft | none |

Hand-written SQL in the migration, which Prisma's schema cannot say: CHECKs that `step_execution_id` and `step_key` are set exactly for an `outbound_step` draft, that `approved_at` is set exactly when the status is `approved` (compared as text: Postgres refuses a new enum value in the transaction that adds it), that only an `outbound_step` draft is `approved`, and that `edit_ratio` lies between 0 and 1; and the partial unique key `(workspace_id, step_execution_id) WHERE step_execution_id IS NOT NULL`, one draft per step execution. gamma-p3-070's: `email` added alone in its migration, so it is committed before a statement uses it; CHECK `message_drafts_email_columns` (`subject`, `edited_subject` and `mailbox_id` only on an `email` draft, `mailbox_id` only on an `outbound_step` one) and CHECK `message_drafts_step_kind` (`step_kind` only on a `lead_draft`, one of the written kinds), both comparing `::text`; and the partial index `(workspace_id, mailbox_id, created_at) WHERE mailbox_id IS NOT NULL`, which the near-duplicate gate reads.

`erasePerson` deletes a person's rows, a step's drafts and an email's subject included. The event `messaging.draft_requested` and the workflow's input carry ids only: the workspace, the draft, the person, the member who asked (a step's draft: the sender account's owner), the replaced draft and a step's `earlierDraftIds`; `messaging.step_draft_ready` the draft, its step execution and its status. No text travels in an event or an input: the writer reads the earlier texts by id.

## The dossier

Built on every read and stored nowhere; a draft keeps its hash. What it reads, through each owner's public functions:

| Record | Fields | PII class |
|---|---|---|
| tenancy's `users` | `display_name` of the signed-in user | `business_contact`, the user's own |
| onboarding's `company_knowledge` | `one_liner`, `products`, `pain_points`, the `text` of `proof_points` | none |
| contacts' `persons` | `first_name`, `headline`, `title`, `location_text`; `company_name` without a linked company | `business_contact` |
| contacts' `workspace_companies` | `name`, `industry`, `size_range`, `country` | none |
| signals' `signal_events`, `evidence` | `occurred_at`; `url`, `excerpt`, `comment_text`, `reaction` | `url`, `excerpt` and `comment_text` are the evidence's `pii` columns |

Never read into it: a last name, the LinkedIn URL and member ids, the evidence's `author`, any contact detail or photo (contacts stores none), Company Knowledge's other fields and the provenance maps. Each fact's `sourceRef` names its row and column, so a value traces back to its record.
