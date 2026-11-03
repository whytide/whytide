# approvals

The approval queue's items (beta-p3-030): every step of a sequence that can reach a person waits as an item until the owner of its sender account approves or skips it. An approval freezes the text through messaging and keeps its hash, so the send can prove it carries exactly what the owner approved.

- **Owns:** `approval_items` ([docs/data.md](docs/data.md)); the queue's routes; the event `approvals.item_decided`; a subscriber to `messaging.step_draft_ready`.
- **Public interface:** `index.ts` (below).
- **Depends on:** `platform`, `db`; messaging's `requestStepDraft`, `approveStepDraft`, `approvedContent`, `stepDrafts` and `events`; contacts' `getLead`; linkedin's `findSenderAccount`; `@nestjs/common` in `api/`. Never campaigns: campaigns imports this module.
- **Reviewers:** the owners of this module.

## Public interface

Each runs in the caller's tenant run (`domain/items/`):

| Export | What it does |
|---|---|
| `openItem({ stepExecutionId, personId, senderAccountId, actionType, stepKey, scheduledFor, senderUserId, earlierDraftIds })` | The step's pending or approved item unchanged, else a new `pending` one and messaging's `requestStepDraft`; `{ approvalItemId }`. `actionType` is `invite` or `message`; a `withdraw` step is `approvals_input_invalid`. |
| `cancelItems(stepExecutionIds)` | Every `pending` item of the steps becomes `blocked`; the count. campaigns calls it when it holds, cancels or skips a step. |
| `noteItemWait(stepExecutionId, { code, until? } \| null)` | Sets or clears why the step's `approved` item waits (`insufficient_credits`, the note budget); the count, 0 or 1. |
| `approvedContent(stepExecutionId)` | `{ text, contentHash, approvalItemId, approvedBy, approvedAt }` for an `approved` item decided by the account's owner whose frozen text still hashes to the approval's hash; else null. |
| `decisionsFor(stepExecutionIds)` | Each step's latest item, `{ stepExecutionId, approvalItemId, status, draftId, decidedBy, decidedAt }`, in the order asked. |
| `editStats({ since })` | `{ approved, unedited, smallEdits }` over the items approved since; an invite approved with an empty note is left out. |
| `decisionDays({ since })` | `[{ senderAccountId, day, decisions }]`: the local days, in each sender's zone, with a decision. |
| `erasePerson(personId)` | Deletes the person's items, `{ approval_items }`; privacy registers it. |
| `QUEUE_WINDOW_HOURS` | 24: how far ahead of its due time a step enters "Up next" (campaigns' queue). |

Also `api`, `events` (`approvals.item_decided { approvalItemId, stepExecutionId, decision }`, `approved` or `skipped`), `ids` (`apv`), `errors` and `permissions` (`approvals.read`, `approvals.decide`: Owner, Admin, Member).

## Routes

Under `/v1/workspaces/{workspaceId}/approvals` (`api/items.controller.ts`, `schemas/items.ts`):

- `GET /items` (`approvals.read`): `{ items, counts: { toApprove, decidedToday } }`. Every `pending` item, overdue ones included, and every `approved` one with a `waitCode`, by `scheduledFor`, at most `ITEMS_LIST_MAX` (200). Each item has its `lead` (the first why bullet only), its `draft` (null while drafting), its `sender` (`accountId`, `label`, `timeZone`), the flags `stale` and `needsAttention`, and `canDecide`.
- `POST /items/{id}/approve` (`approvals.decide`, idempotent), body `{ text? }`, strict, at most 4,000 characters, `""` allowed: 200 with the item. 404 `approval_item_not_found`; 409 `approval_item_not_pending`; 403 `not_sender_owner`; 409 `approval_draft_pending`; 400 `draft_text_refused` (messaging's, `details.issues`).
- `POST /items/{id}/skip` (`approvals.decide`, idempotent): 200 with the item; the draft stays as it is. The same refusals, but the draft's.

## Testing

`pnpm -F approvals test` (the items), `test:safety` (the approval cases), `test:tenancy`; the routes in `core/apps/api/tests/approvals-items.test.ts`. `@whytide/approvals/testing`: `createApprovalItem(item, client?)` writes an item in any state; `useApprovalsClient(client)` sets the client it writes on.

## Decided here

- Only the owner of the sender account decides its items: linkedin's `owner_user_id` against the caller's user id, whatever the role (not in the sources); a gone account answers `not_sender_owner`. `approvedContent` checks it again against the account's owner now.
- One pending and one approved item per step, two partial unique keys (not in the sources). A decision first claims the item under a condition on `pending`, so of two presses at once one wins and the other is 409.
- The draft is attached when its writer ends it (`ready`, `flagged`, `failed`), by the subscriber, or at the open when it ended already: a connection request's note, or a step opened again after a block.
- `stale` and `needsAttention` are computed when the queue is read, never stored; `needsAttention` is a pending item's only. `decidedToday` counts from today's start in each sender's zone; a gone account's in UTC.
- `wait_code` and `wait_until`, and `noteItemWait`, are not in the sources: "Up next" says why an approved step waits.
- No AI disclosure line: every send has its own approval (RB-1.2.6, RB-20.6.1).
- The draft's and the lead's words in the answers (gate, channel, status, tier) are open strings: messaging and contacts own their lists.
- Grants as alpha's tenant tables have them, the owner's default privileges; no row-level policy.

## Screen

"Up next" (beta-p3-040), at `/w/{workspace}/up-next` in the navigation's Leads group, after the lead list (`ui/nav.ts`, `ui/up-next/`): every waiting step, for its sender account's owner to edit, approve or skip. Nothing on it sends: an approved step goes out at its time, through campaigns.

- **Header:** the counters "to approve" and "decided today" of the last read, and the line that nothing here sends.
- **Rows:** "Overdue" first (the stale ones), then grouped by the local day and hour they are due, in their sender's zone. Each row has the lead, linked to the lead page, with title, company, tier and first why bullet as the lead list shows them; the step; its time in the sender's zone; the flags (past its day, needs attention, drafting, draft failed, flagged with the gates' issues, waiting with its reason); the text with its counter against the draft's `maxCharacters`; Show facts; Edit, Approve and Skip.
- **Edit and Approve:** Edit opens the text in a field; Approve sends `{}` for the draft as it is, `{ text }` once edited, and is off outside the draft's `minCharacters` and `maxCharacters`. A refused text (`draft_text_refused`) shows each gate's issue and keeps what was typed. A failed draft opens the field empty; a connection request's note may stay empty.
- **Skip:** a dialog first; on a connection request it says that skipping ends the sequence.
- **Drafting rows:** a spinner and no Approve. The queue is read again every `POLL_MS` (5 s) while a row is drafting, until `POLL_MAX_MS` (20 min) after its step opened; then a note with Check again.
- **Show facts:** messaging's dossier of the lead, read on the first open, and the facts the draft's `factIds` name, with their sources in words. It is today's dossier, and says so.
- **Not the account's owner:** the rows show, with Edit, Approve and Skip off and a hint.
- **States:** loading (the header, the kit's LoadingState and Skeleton rows), empty, and a failed read in words with Try again.

The screen reads approvals' routes and messaging's dossier only. Each press sends an `Idempotency-Key` of its own, which Try again sends again. The spec, `core/apps/web/tests/approvals-up-next.spec.ts`, runs on what the e2e api's `POST …/e2e/up-next` seeds through `createApprovalItem` and `attachStepDraft` (`@whytide/approvals/testing`), which does the subscriber's work where no worker runs.

Decided here, for the screen:

- Order 15 in the navigation, between the lead list (10) and the never-contact list (20).
- The counters render in the browser part, so a decision updates them from the next read.
- The polling window counts from the item's `createdAt`: the screen cannot see when the writer started.
- An error is worded by the module that owns its code (the web's `errorOwner`): messaging's for its own codes.
- Step names, wait reasons, gates and fact sources are open strings: one off the lists gets a generic word. The tier shows as a badge for `hot`, `warm` and `cool` only.
- A failed draft opens its field for the account's owner only; another member sees its flag.
