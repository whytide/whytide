# approvals

The approval queue's items (beta-p3-030): every step of a sequence that can reach a person waits as an item until the owner of its sender, the LinkedIn account or an email's mailbox (gamma-p4-090), approves or skips it, or, for an item opened for it, the campaign's mode approves it with the AI disclosure line. An approval freezes the text through messaging and keeps its hash, so the send can prove it carries exactly what was approved.

- **Owns:** `approval_items` ([docs/data.md](docs/data.md)); the queue's routes; the event `approvals.item_decided`; a subscriber to `messaging.step_draft_ready`.
- **Public interface:** `index.ts` (below).
- **Depends on:** `platform`, `db`; messaging's `requestStepDraft`, `approveStepDraft`, `approveStepDraftByMode`, `approvedContent`, `stepDrafts` and `events`; contacts' `getLead`; linkedin's `findSenderAccount` and `senderOf`; email's `findMailbox`; `@nestjs/common` in `api/`. Never campaigns: campaigns imports this module.
- **Reviewers:** the owners of this module.

## Public interface

Each runs in the caller's tenant run (`domain/items/`):

| Export | What it does |
|---|---|
| `openItem({ stepExecutionId, personId, senderAccountId?, mailboxId?, actionType, stepKey, scheduledFor, senderUserId, earlierDraftIds, approvalBy? })` | The step's pending or approved item unchanged, else a new `pending` one and messaging's `requestStepDraft`; `{ approvalItemId }`. `actionType` is `invite`, `message` or `email`: an email has its `mailboxId` and no `senderAccountId`, the others the reverse, and `senderUserId` is the sender's owner. `approvalBy`, `person` by default, `mode` for an item the campaign's mode may approve (below). A `withdraw` step, or a sender off its rule, is `approvals_input_invalid`. |
| `cancelItems(stepExecutionIds)` | Every `pending` item of the steps becomes `blocked`; the count. campaigns calls it when it holds, cancels or skips a step. |
| `noteItemWait(stepExecutionId, { code, until? } \| null)` | Sets or clears why the step's `approved` item waits (`insufficient_credits`, the note budget); the count, 0 or 1. |
| `approvedContent(stepExecutionId, { allowMode }?)` | `{ text, subject?, contentHash, approvalItemId, approvedBy, approvedAt }` for an `approved` item decided by its sender's owner, the account's or the mailbox's, whose frozen content still hashes to the approval's hash; else null. `subject` is an email's only, null for a follow-up. Asked with `{ allowMode }`, the answer adds `origin` (`app`) and `disclosureApplied` (false), and with `allowMode: true` the mode's approval answers too: `approvedBy` null, origin `approval_mode`, `disclosureApplied` true. Without `allowMode`, the mode's approval is no approval. |
| `decisionsFor(stepExecutionIds)` | Each step's latest item, `{ stepExecutionId, approvalItemId, status, draftId, decidedBy, decidedAt }`, in the order asked. |
| `editStats({ since })` | `{ approved, unedited, smallEdits }` over the items a person approved since; an invite approved with an empty note is left out. |
| `decisionDays({ since })` | `[{ senderAccountId, day, decisions }]`: the local days, in each sender's zone, with a person's decision; an email item's sender is its mailbox, by its id. |
| `erasePerson(personId)` | Deletes the person's items, `{ approval_items }`; privacy registers it. |
| `queueWindowHours` | `APPROVALS_QUEUE_WINDOW_HOURS` as configured, 24 unset ("Settings"): how far ahead of its due time a step enters "Up next" (campaigns' queue). |

Also `api`, `events` (`approvals.item_decided { approvalItemId, stepExecutionId, decision }`, `approved` or `skipped`, a person's or the mode's), `ids` (`apv`), `errors` and `permissions` (`approvals.read`, `approvals.decide`: Owner, Admin, Member).

### Approving by the mode

An item opened with `approvalBy: "mode"` is approved by the campaign's mode as soon as its draft is attached `ready`, at the open or by the subscriber, in the same tenant run (`domain/items/mode.ts`): only through messaging's `approveStepDraftByMode`, which ends the text with its channel's AI disclosure line before it freezes, so the item's hash covers the line. The item becomes `approved` with origin `approval_mode`, no `decided_by`, and `approvals.item_decided` is published as for a person. A connection request, a draft `flagged`, `failed` or `edited`, and one messaging refuses (`draft_not_ready`, `disclosure_check_failed`) leave the item `pending` for a person, with `wait_code` `mode_declined`. Which steps campaigns opens for the mode is gamma-p4-070's.

## Routes

Under `/v1/workspaces/{workspaceId}/approvals` (`api/items.controller.ts`, `schemas/items.ts`):

- `GET /items` (`approvals.read`): the caller's own queue, whatever their role (gamma-p6-050), `{ items, senders, counts: { toApprove, decidedToday } }`. The `pending` items, overdue ones included, and the `approved` ones with a `waitCode`, of the senders the caller owns, their LinkedIn account and their mailboxes, by `scheduledFor`, at most `ITEMS_LIST_MAX` (200); another member's items are never read into it. Each item has its `channel` (`linkedin` or `email`), `mailboxId` (an email's), `approvalBy`, its `lead` (the first why bullet only), its `draft` (null while drafting; a first email's `subject`, `maxSubjectWords` and `maxSubjectCharacters`, else null), its `sender` (`accountId`, null on an email, `label`, the mailbox's address on an email, `timeZone`), the flags `stale` and `needsAttention`, and `canDecide`. `senders`, by label, are the caller's senders with an item to show or count, and their connected LinkedIn account even without one: `{ accountId, mailboxId, label, timeZone, toApprove, decidedToday }`, an account's `accountId` or a mailbox's `mailboxId`, the other null; `toApprove` its pending items, past the cap too; `decidedToday` its items a person approved or skipped since today's start in its own zone. `counts` are the senders' sums. A caller with no sender gets no item, no sender and zeros.
- `POST /items/{id}/approve` (`approvals.decide`, idempotent), body `{ text?, subject?, draftId? }`, strict, the texts at most 4,000 characters, `""` allowed: 200 with the item. `draftId` is the draft the screen showed. 404 `approval_item_not_found`; 409 `approval_item_not_pending`; 403 `not_sender_owner`; 400 `approval_subject_not_allowed` (a subject on an item that is not an email); 409 `approval_draft_pending`; 409 `approval_draft_changed` (a `draftId` not the item's); 400 `draft_text_refused` (messaging's, `details.issues`) and `draft_subject_not_allowed` (messaging's, a subject on an email follow-up).
- `POST /items/{id}/skip` (`approvals.decide`, idempotent): 200 with the item; the draft stays as it is. The same refusals, but the draft's.

## Testing

`pnpm -F approvals test` (the items), `test:safety` (the approval cases), `test:tenancy`; the routes in `core/apps/api/tests/approvals-items.test.ts`; two members' decisions through to the send in `core/apps/worker/tests/safety/approvals-per-member.test.ts`. `@whytide/approvals/testing`: `createApprovalItem(item, client?)` writes an item in any state; `useApprovalsClient(client)` sets the client it writes on; `useQueueClock(() => date)` sets the time "Up next" is read at, `undefined` the system's again.

## Decided here

- Only the owner of the sender decides its items: linkedin's account's `owner_user_id`, or, on an email item, the mailbox's (email's `findMailbox`), against the caller's user id, whatever the role (not in the sources); a gone account or mailbox answers `not_sender_owner`. `approvedContent` checks it again against the owner now. An item opened for the mode still takes its owner's decision while `pending`.
- One pending and one approved item per step, two partial unique keys (not in the sources). A decision first claims the item under a condition on `pending`, so of two presses at once one wins and the other is 409.
- The draft is attached when its writer ends it (`ready`, `flagged`, `failed`), by the subscriber, or at the open when it ended already: a connection request's note, or a step opened again after a block.
- "Up next" is each member's own (gamma-p6-050): every role, an Owner's and an Admin's included, reads the items of the senders they own only, so the list and the decision check agree; a view of another member's queue waits for the audit log (RB-13.1.3). The read takes the items' distinct senders, each read once, and the caller's connected account, keeps those the caller owns, then reads those senders' items only, so another member's never take a place under the cap. No new column: the owner stays the account's or the mailbox's.
- `stale` and `needsAttention` are computed when the queue is read, never stored; `needsAttention` is a pending item's only. `decidedToday` counts per sender from today's start in its own zone, as a member's senders may sit in two; the totals are the senders' sums. `decisionDays` puts a gone account's days in UTC.
- `wait_code` and `wait_until`, and `noteItemWait`, are not in the sources: "Up next" says why an approved step waits.
- The mode's approval (gamma-p4-090): only through messaging's `approveStepDraftByMode`, so what the mode approves always ends with the channel's AI disclosure line and its hash covers it (RB-20.6.1); never a person's in the record (no `decided_by`, origin `approval_mode`, left out of `editStats`, `decisionDays` and `decidedToday`); no answer from `approvedContent` without `allowMode`, so a caller that asks a person's approval never sends it. A person's approval never carries the line, and `approvedContent` answers null when the frozen content says otherwise. The mode's approval and the item's update share the run: a crash rolls both back, so a retry finds the draft `ready` again (!239).
- `approval_by` is the open's, never changed: a person's decision of a mode item keeps it. `mode_declined` is the one wait of a `pending` item, cleared by a person's decision or a cancel.
- An Approve's `draftId` (a beta leftover): optional in the body, compared when given; the screen always sends it.
- The draft's and the lead's words in the answers (gate, channel, status, tier) are open strings: messaging and contacts own their lists.
- Grants as alpha's tenant tables have them, the owner's default privileges; no row-level policy.

## Screen

"Up next" (beta-p3-040), at `/w/{workspace}/up-next` in the navigation's Leads group, after the lead list (`ui/nav.ts`, `ui/up-next/`): the member's own waiting steps, for them to edit, approve or skip, grouped by sender (gamma-p6-050). Nothing on it sends: an approved step goes out at its time, through campaigns.

- **Header:** the counters "to approve" and "decided today" of the last read, the member's totals, and the line that nothing here sends.
- **Senders:** with two or more, a section each, by label, titled with its label and zone and its two counters, holding its rows; with one, the rows as before, with no section.
- **Rows:** "Overdue" first (the stale ones), then grouped by the local day and hour they are due, in their sender's zone. Each row has the lead, linked to the lead page, with title, company, tier and first why bullet as the lead list shows them; the step; its time in the sender's zone; the flags (past its day, needs attention, drafting, draft failed, flagged with the gates' issues, waiting with its reason); the text with its counter against the draft's `maxCharacters`; Show facts; Edit, Approve and Skip.
- **Edit and Approve:** Edit opens the text in a field; Approve sends `{}` for the draft as it is, `{ text }` once edited, and is off outside the draft's `minCharacters` and `maxCharacters`. A refused text (`draft_text_refused`) shows each gate's issue and keeps what was typed. A failed draft opens the field empty; a connection request's note may stay empty.
- **Skip:** a dialog first; on a connection request it says that skipping ends the sequence.
- **Drafting rows:** a spinner and no Approve. The queue is read again every `POLL_MS` (5 s) while a row is drafting, until `POLL_MAX_MS` (20 min) after its step opened; then a note with Check again.
- **Show facts:** messaging's dossier of the lead, read on the first open, and the facts the draft's `factIds` name, with their sources in words. It is today's dossier, and says so.
- **Another member's rows:** never shown, so their hint went (gamma-p6-050).
- **States:** loading (the header, the kit's LoadingState and Skeleton rows); empty, which, for a member with no sender, says to connect a LinkedIn account and links to its screen; and a failed read in words with Try again.

The screen reads approvals' routes and messaging's dossier only. Each press sends an `Idempotency-Key` of its own, which Try again sends again. The spec, `core/apps/web/tests/approvals-up-next.spec.ts`, runs on what the e2e api's `POST …/e2e/up-next` seeds through `createApprovalItem` and `attachStepDraft` (`@whytide/approvals/testing`), which does the subscriber's work where no worker runs.

Decided here, for the screen:

- Order 15 in the navigation, between the lead list (10) and the never-contact list (20).
- The counters render in the browser part, so a decision updates them from the next read.
- The polling window counts from the item's `createdAt`: the screen cannot see when the writer started.
- An error is worded by the module that owns its code (the web's `errorOwner`): messaging's for its own codes.
- Step names, wait reasons, gates and fact sources are open strings: one off the lists gets a generic word. The tier shows as a badge for `hot`, `warm` and `cool` only.
- A failed draft opens its field for its sender's owner, the one member who sees the row.
- The sections (gamma-p6-050): a section's title is the sender's label and its zone's IANA name; in a section, the groups' and rows' headings go one level down. A row the api answers with `canDecide: false` would keep its decisions off, though none is shown.
- Email rows (gamma-p4-090): the mailbox's address is the sender; a first email's subject is shown and edited beside the body, within `maxSubjectWords` and `maxSubjectCharacters`, a follow-up's has none. Approve always sends the shown `draftId`, with `subject` only when it was edited. gamma-p3-070's gates, `signal_act`, `subject`, `links` and `near_duplicate`, have their words, and a length its unit (!221).
- An item opened for the mode: while it is drafting the row says the mode approves it once ready and shows the channel's AI disclosure line, messaging's panel in the page's `disclosure` slot; once declined it says why, in words chosen from the row: a connection request, a draft that is not ready, or a check failing with the line.

## The mode taken back

gamma-p4-070: `returnModeItems(stepExecutionIds)` (`domain/items/cancel.ts`), campaigns' call when a campaign goes back to "Review everything", in its run under the step's locks. The steps' items opened for the mode and still `pending` are blocked; those the mode approved are blocked with their hash, decision time and origin cleared, as the CHECKs have a blocked item, and their drafts made `ready` again through messaging's `reopenModeApproval`. A person's item, pending or decided, stays as it is. It answers the steps whose item it blocked; a repeat blocks nothing. `decisionsFor` answers each item's `approvalBy` and `decisionOrigin` too, so campaigns schedules a step the mode approved and finds the mode's items. Tests: `tests/mode.test.ts` and campaigns' `tests/safety/approval-mode.test.ts`.

## Settings

The `modules/approvals` block of `deploy/.env.example`, `settings.ts` (env-settings-a), each read once, as the module loads, the defaults in `domain/items/constants.ts`:
- `APPROVALS_NEEDS_ATTENTION_AFTER_DAYS` (3, an integer of 1 or more, no maximum): a pending item is flagged "Needs attention" after this many days (`needsAttention`).
- `APPROVALS_QUEUE_WINDOW_HOURS` (24, an integer of 1 or more, no maximum): how far ahead of its due time a step enters "Up next"; campaigns' queue reads it as `queueWindowHours` from `index.ts`.
- `APPROVALS_SMALL_EDIT_MAX_RATIO` (0.2, a number above 0 and at most 1): the most a reviewer can change of an AI message, as a share of its text, for the change to count as a small edit in the edit report (`isSmallEdit`).

Unset or empty, the default applies. A value off its range stops the api's and the worker's start with `config_invalid` naming it. **A changed value needs an api and worker restart.** `tests/settings.test.ts` sets 2 days, 48 hours and 0.1 and tries the values off their ranges; campaigns' `tests/settings.test.ts` opens a step due within 48 hours.
