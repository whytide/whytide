# messaging: data

## `message_drafts`

One row per draft, a tenant table (`workspace_id`, indexed with `person_id` and `created_at`), migration `20261027100000_messaging_drafts`, ids `mdr_…`. No foreign key: the person is contacts', the records ai's.

| Column | What | PII class |
|---|---|---|
| `person_id`, `channel`, `status` | the lead, `linkedin_note` or `linkedin_message`, `drafting` · `ready` · `flagged` · `failed` · `edited` | none |
| `plan` | `{ angle, factIds, cta, decisionRecordId }`, the planner's last answer and its call's record | none |
| `text` | the writer's last text | `business_contact` |
| `edited_text`, `edited_at` | a member's own text (`PATCH …/drafts/{id}`) and when it was saved | `business_contact` |
| `model_id`, `prompt_version`, `decision_record_id` | the last call's: the write's, else the plan's; the panel's history shows the model and version | none |
| `dossier_hash` | the dossier's hash when written; another than today's makes the draft stale in the panel | none |
| `gates` | the last round's `{ gate, issues }`, in the gates' order | `business_contact`: an issue may name a text's words |
| `regenerations` | 0 to 2 | none |
| `flag_reasons` | the issues a flagged draft was left with, or a failed one's `{ code }` | `business_contact`, as `gates` |

`erasePerson` deletes a person's rows. The event `messaging.draft_requested` and the workflow's input carry ids only: the workspace, the draft, the person, the member who asked and the replaced draft.

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
