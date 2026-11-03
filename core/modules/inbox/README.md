# inbox

The replies of the persons Whytide contacted (beta-p5-010): each message linkedin's receiver kept is stored in its thread, and in the same transaction every pending step of its person is held, so the sequence stops. A reply that asks to stop also suppresses the person. No model is in this path. The account's own messages are in the thread too (beta-p5-020): the platform's, once each, with who approved them, and the ones the tester typed on LinkedIn, as theirs, each that day's touch.

- **Owns:** `threads`, `messages` and `reply_labels` ([docs/data.md](docs/data.md)); the event `inbox.reply_received`; subscribers to `linkedin.message_received` and `campaigns.step_sent`; the workflow `inbox_store_message`; the routes under `/v1/workspaces/{workspaceId}/inbox` and the "Inbox" screens (beta-p5-040, "API" and "Screen" below).
- **Public interface:** `index.ts` (below).
- **Depends on:** `platform`, `db`, `providers` (the files port); approvals' `approvedContent`; campaigns' `events`, `holdForReply` and `sentStep`; contacts' `addOptOut`, `getLead`, `getPerson`, `lockLeadStatus`, `recordTouch` and `errors`; linkedin's `events`, `findSenderAccount`, `messageFile` and `sentMessageRef`; `tenancy`; `ui` for the screens. Nothing imports inbox but privacy.
- **Reviewers:** the owners of this module.

## Public interface

| Export | What it does |
|---|---|
| `erasePerson(personId)` | Deletes the person's messages and every message of their threads, then their threads, in the caller's tenant run; `{ messages, threads }`. privacy registers it. |

Also `events` (`inbox.reply_received { messageId, threadId, personId }`, for a newly stored reply only), `ids` (`thr`, `msg`, `rlb`), `errors` (`inbox_file_invalid`, 500, and the routes' codes, "API"), `permissions` (`inbox.read`, `inbox.label`) and `api`, the routes the api host mounts.

## The store

`linkedin.message_received` starts `inbox_store_message` by the id `inbox.message:<workspaceId>:<event id>`, so a second delivery starts none. Its one activity, `inbox_store` (kind `provider`), reads the message's file outside any run; for an inbound message, one tenant run holds the person's steps first, always, then, with the file and a person contacts still knows, stores the thread and the message, suppresses the person on an opt-out phrase and publishes `inbox.reply_received`; for the account's own message, one tenant run stores it (below). The file is deleted once the run committed. The order: [docs/flows.md](docs/flows.md).

## The platform's own messages

beta-p5-020. A sent message step: `campaigns.step_sent` (`actionType = message`; an invite stores nothing) reaches a subscriber that writes in the delivery's own run (`domain/store/sent.ts`), from rows only: campaigns' `sentStep`, approvals' `approvedContent` and linkedin's `sentMessageRef`, the provider's refs linkedin's alone. Its message joins the chat's thread as `sent_by = campaign`, with the step, the approved text, `approved_by` and `approved_at`. The account's own message as the receiver keeps it, the echo (`direction = out`, `domain/store/echo.ts`): a row holding its `provider_message_ref` is the platform's, and nothing changes; any other is the tester's, typed on LinkedIn, stored as `sent_by = user` with contacts' `recordTouch(personId, sentAt)`. Whichever of the two comes first, one row stays: the step's event makes an echo stored first the campaign's. Each run locks the person's lead first; the step's event logs `inbox_sent_message_unmatched` with the step's id when one of the three reads answers null, a defect.

## Testing

`pnpm -F inbox test` (the phrases, the store, the step's event in `tests/sent.test.ts`, the eraser, the isolation), `test:safety` (`tests/safety/reply-hold.test.ts`: the message, the hold and the opt-out commit together or not at all; no model; `tests/safety/tester-touch.test.ts`: a typed message is the person's touch, a platform message's echo no second row), `test:tenancy`. The workflow on the fakes is `core/apps/worker/tests/inbox-store.test.ts`, the account's own messages from the sender's send `core/apps/worker/tests/inbox-sent-messages.test.ts`; end to end from linkedin's webhook, `core/apps/worker/tests/safety/stop-on-reply.test.ts` (`pnpm -F worker test:safety`). `@whytide/inbox/testing`: `createThread` and `createMessage` write rows as the store leaves them, and `createLabel` a reply's label; `useInboxClient(client)` sets the client they write on.

## Decided here

- Every inbound message the receiver kept holds, whatever the lead's status: the receiver keeps only messages on an outreach the platform started, so the person is in a campaign or past one. `holdForReply` leaves a suppressed lead suppressed.
- The store's order: the hold, then the account's owner, the thread, the message, the opt-out and the event, in one run. A missing file (raw/'s 72 hours) still holds and stores nothing. An invalid file, or one whose direction is not the event's, holds, stays for the runbook and fails `inbox_file_invalid`.
- The account's messages are stored once by `provider_message_ref`, in either order: the step's event finds an echo stored first as the user's and makes it the campaign's, with the approved text (the provider's copy is used only for a message no step sent) and the echo's `sent_at`, the provider's time; an echo that finds a row changes nothing (beta-p5-020).
- A message the tester types is a touch, not a hold: contacts' `last_touch_at` moves to its time, so the gate's one touch a day (`touched_today`) keeps a follow-up planned that day for the next; the steps stay as they are. A platform message's echo records no touch: the sender's commit did. An echo that comes before the step's event cannot tell the two apart and records one, seconds from the send's own, the same day.
- The step's event and the echo lock the person's lead before anything else, as privacy's erasure does before it deletes their rows: one that waits on an erasure then finds the person gone and writes nothing. The echo records its touch before its rows, so a person erased mid-run, one without a lead to lock (contacts' `person_not_found`), gets neither.
- The provider's refs come from linkedin's `sentMessageRef`, never from campaigns, and none crosses an event, a workflow input or an activity's answer. The step's event checks for a row holding its step before it reads them, since `sentMessageRef` answers the outreach row's last send only.
- A step without its send, its approval or its refs stores nothing and logs `inbox_sent_message_unmatched` (`error`) with the step's id: every `succeeded` message step has all three. So does a ref another step's row holds. The line goes through the host's logger, which `onWorkerStart` (`workflows/index.ts`) keeps.
- A person erased since the reply (contacts' `getPerson` answers `person_not_found`): nothing stored or published and the file deleted, as campaigns' enrollment does for `person_gone`, so the erasure sticks. The store reads it after the hold's lock on the lead, which an erasure that deleted the lead holds until it commits.
- The phrase list decides, no model: whole words, any case, after folding curly apostrophes to straight ones and every run of other characters to one space. "stop" counts only as the reply's first word, the whole reply included ("STOP.", "Stop, please"): elsewhere it is rarely a request, and an opt-out is never removed, so "can't stop thinking about it" and "non-stop" do not suppress. A request mid-reply counts through its own phrases, "stop messaging me", "stop contacting me" and "stop sending me", and "please stop" counts as the whole reply only, so "Please stop by our booth" does not suppress (beta-p5-010's review, beta-p5-030). The other phrases count anywhere, and a hyphen parts words ("opt-out").
- A repeat is a row already holding the message's `provider_message_ref`: the run ends there, with no event.
- The activity is `inbox_store`: the worker refuses a workflow and an activity of one name (`worker_duplicate_registration`).
- The eraser deletes every message of the person's threads too: the messages' foreign key holds a thread. It takes no lock: privacy's run locks the lead before it, after the platform's step, as the store's hold does (contacts' `lockLeadStatus`), so a store that runs during the erasure waits for it, then finds the person gone and writes nothing back (beta-p5-030; the race on the real erasure: `core/apps/worker/tests/inbox-store.test.ts`).
- Grants as alpha's tenant tables have them, the owner's default privileges; no row-level policy.
- `inbox_file_invalid` has a message key, though no screen shows it: messages:check asks one of every code.
- A reply's label lives in inbox's own `reply_labels`, one row per inbound message, changed in place and never removed: not the data model's reply classification, which gamma's own table holds apart (beta-p5-040). beta-p7-030's export reads it.
- No unread state, no views, filters or replies from the app (RB-13.1.1 reduced): the list is the workspace's threads, newest first, and every member with `inbox.read` reads them all, since only the platform's threads exist and beta has one sender per workspace.
- The label's not-found code is `inbox_message_not_found`: the platform's i18n registers `message_not_found`, and the registry refuses a code twice.
- The label is a PUT that sets a state, so it takes no `Idempotency-Key`: the same label again changes nothing, its time and member included.
- The list's cursor is the last row's `last_message_at` and id, base64url, the keyset of its order; the screen reads 20 threads at a time (`ui/inbox/constants.ts`), the api 50 at most.
- The thread's page is `ui/inbox/thread-page.tsx`, beside the list's: `ui/thread/page.tsx` re-exports it, since web:routes mounts a page from `ui/<screen>/page.tsx`.
- One mail per reply, to the sender account's owner, the thread's `owner_user_id` (beta-p5-030): the workflow's id makes a second delivery start nothing, and `owner_notified_at` stops a retry once the mail went. It never carries the reply's text: the person's first name, "a lead" without one, and the thread's link. An opt-out reply gets its mail too, so the owner knows.
- The mail's first name is folded to one line, its direction marks dropped; a blank one, or one longer than 50 characters (`MAIL_NAME_MAX`), is "a lead" (beta-p5-030).
- No mail for a reply erased since its event (`gone`), nor for an owner who is no user or is disabled (`owner_unavailable`): the workflow ends without an error, the latter logged with ids (beta-p5-030).

## Open questions

- An invalid file fails all five attempts of a `provider` activity: a module cannot mark its own code not retried (the worker's `NOT_RETRIED`).
- Whether a message the tester types should also hold the person's pending steps (beta-p5-020; a Finding): here it is a touch only, and the tester can skip the next step in "Up next".
- A reply that begins "Stop by Tuesday" still suppresses for good: "stop" counts as the first word. Any reply holds the sequence all the same.

## API

beta-p5-040: three routes under `/v1/workspaces/{workspaceId}/inbox` (`api/threads.controller.ts`, Zod in `schemas/threads.ts`). They read and write inbox's tables, and the list and the thread read the person's names from contacts' `getLead`; none calls a provider or sends.

| Route | Permission | What it answers |
|---|---|---|
| `GET /threads?limit&cursor` | `inbox.read` | `{ threads, nextCursor }`: the workspace's threads by `last_message_at`, newest first, `limit` of them (50 at most, `THREADS_PAGE_MAX`), each with `id`, `personId`, `person` (`firstName`, `lastName`, `title`, `companyName`; null once contacts no longer has the lead), `senderAccountId`, `lastMessageAt`, `lastDirection` (who wrote last) and `toLabel` (its replies without a label). `nextCursor`, null on the last page, is the next read's `cursor`. |
| `GET /threads/{id}` | `inbox.read` | The thread as the list has it, with its `messages`, oldest first: `id`, `direction`, `sentBy`, `body`, `sentAt`, `approvedAt` and `label` (`{ label, labeledBy, labeledAt }`, or null; always null for an outbound message). `thread_not_found` (404), another workspace's thread too. |
| `PUT /messages/{id}/label` | `inbox.label` | Body `{ label }`, `positive` or `not_positive`, strict: the reply's label set with the caller and the time, or changed in place; the label as stored. `inbox_message_not_found` (404), `message_not_inbound` (409). |

Tests: `core/apps/api/tests/inbox-threads.test.ts`. Requests: `api-calls/beta-p5-040-inbox-screen-labels.http`.

## Screen

beta-p5-040: "Inbox" at `/w/{workspace}/inbox`, in the navigation's Leads group after "Up next", and a thread at `/w/{workspace}/inbox/{threadId}` (`ui/nav.ts`; the code in `ui/inbox/`). Both read inbox's routes only, through the web's api client; nothing on them sends.

- **The list** (`page.tsx`, `threads.tsx`): the header says that only the conversations the platform started appear and that the tester answers on LinkedIn; a table of the threads, newest first, each with the lead's name, title and company, the last message's time, who wrote last and a badge with the replies to label; a row opens its thread. "Load more" adds the next 20.
- **The thread** (`thread-page.tsx`, `thread.tsx`): the way back; the lead's name, linked to their lead page; the messages, oldest first, each with its time and its author in words: the person, the campaign with the time it was approved, or the account's owner, typed on LinkedIn. No reply box: a line says to answer on LinkedIn.
- **The label** (`label-buttons.tsx`): Positive and Not positive on each reply, the chosen one pressed; one click labels, a click on the other changes it, and one on the pressed one sends nothing.
- **States:** loading (`LoadingState`, `Skeleton`); empty (no replies yet, a thread without a message); a failed read in words, with Try again; a thread of another workspace, or none, not found.
- **Tests:** `core/apps/web/tests/inbox-screen.spec.ts`, on the threads the e2e api's module seeds (`POST …/e2e/inbox`) in `wsp_e2e_inbox`; `phone-width.spec.ts` lists `inbox`.

## The reply mail

beta-p5-030: when a reply is stored, the owner of its sender account gets one email saying who replied, with a link to the thread, never the reply's text ([docs/flows.md](docs/flows.md#the-reply-mail), [docs/security.md](docs/security.md)).

- **The start:** the module's own subscriber to `inbox.reply_received` (`events.ts`) starts the workflow `inbox_reply_mail` with `{ workspaceId, messageId }` by the id `inbox.reply_mail:<workspaceId>:<messageId>`: a second delivery starts none.
- **The activity** `inbox_mail_reply` (`workflows/index.ts`, kind `provider`, five attempts) runs `mailReply` (`domain/mail.ts`): a tenant run reads the inbound message, its thread and the person's first name (contacts' `getPerson`); tenancy's `findUser` reads the owner outside any run; `renderMail("inbox.mail.reply", …)` in the owner's locale or the default, then the app-mail port's `send`; a second run sets `owner_notified_at` where it is still null.
- **The answer:** `{ sent: true }`, or `{ sent: false, reason }` with `already_sent` (the marker is set), `owner_unavailable` (no user, or a disabled one) or `gone` (the message, its thread or its person erased since). A port failure fails the attempt, and Temporal retries it.
- **The link:** `<APP_PUBLIC_ORIGIN>/w/<workspaceId>/inbox/<threadId>`, the thread's page ("Screen" above); `APP_PUBLIC_ORIGIN` is the api's variable, which the worker reads too. While it is empty, the mail goes without a link and says to open the inbox in Whytide.
- **Messages:** `inbox.mail.reply.subject` and `inbox.mail.reply.body`.
- **Tests:** `core/apps/worker/tests/inbox-reply-mail.test.ts` on the app-mail fake, the host and the slice's Temporal: one reply, one mail with the first name and the link and no text; the event again and the activity again after the marker, no second mail; no origin; a disabled owner and none; the replay of `workflows/__histories__/inbox_reply_mail.json`. `tests/mail.test.ts`: the first name a mail carries.

## The reply golden set

beta-p7-030: the labels testers put on replies leave the app as a file, one JSON line per labeled reply with the conversation before it, the golden set gamma's classifier starts from; and one command prints the two numbers beta's "Done when" asks for. As qualification's golden set, the route and the command build the same file through the same function (`domain/export/reply-labels.ts`), the line in `domain/export/reply-line.ts` ([docs/data.md](docs/data.md#the-reply-golden-sets-line)).

- **The route:** `GET /v1/workspaces/{workspaceId}/inbox/exports/reply-labels.jsonl[?week]`, `inbox.read` (`api/exports.controller.ts`, Zod in `schemas/exports.ts`): the file, written first, then answered as `application/jsonl; charset=utf-8`, an attachment, `no-store`. `week_invalid` (400), `files_too_large` (413); a `week` not shaped `YYYY-Www` is `validation_failed`. Requests: `api-calls/beta-p7-030-golden-set-export.http`.
- **The command:** `pnpm inbox:export-labels [--workspace <id or slug>] [--week <ISO week>]` (`cli/export-labels.ts`), from the repository root, on the worktree's database (`.env.local`); on the production machine, from `deploy/`, `docker compose exec api node ../../modules/inbox/dist/cli/export-labels.js [options]`. Without `--workspace`, every workspace (tenancy's `listWorkspaceIds`), each in its own tenant runs as the service `inbox`; `--workspace` is looked up first (an id has an underscore, a slug none). One line per workspace, `reply_labels_written: w/<workspaceId>/exports/<file>, <n> lines, <p> positive`, then `reply_labels_total: <n> labeled, <p> positive, <w> workspaces with a positive reply, <t> testers with a positive reply`. Exit 0 written; 1 refused, `workspace_not_found: <id or slug>` writing nothing, or a file refused, `files_too_large: <workspaceId>`; 2 the usage, or `week_invalid: <week>`, writing nothing.
- **The file:** one line per `reply_labels` row, the reply's latest label, in the order the labels were chosen; an unlabeled reply and an outbound message have none, nor a reply whose person contacts no longer has (erased). With `week` (ISO, UTC, Monday 00:00 to the next; `domain/export/week.ts`), only the labels whose `labeled_at` falls in it; a week its year does not have, or one not started, is `week_invalid`. Its key under the workspace's folder: `exports/reply-labels-<UTC date>.jsonl`, or `exports/reply-labels-<ISO week>.jsonl` with `week`, so a week's export leaves the day's full one in place; a second export of the same name replaces it. The files port keeps `exports/` 7 days at most and refuses a file past 25 MiB.
- **The totals:** labeled and positive add the workspaces' lines; a workspace with a positive reply has a positive line; a tester with a positive reply is the owner (`owner_user_id`) of a thread holding one, each counted once across the workspaces. The command adds them itself: no query reads across workspaces.
- **Reads:** in the caller's tenant runs, the labels in one, their lines 100 labels a run (`EXPORT_PAGE`), from inbox's tables and contacts' `getLead`, whose first and last names every text masks. Nothing logs a line: the command prints counts, keys and codes.
- **Decided here:** `received_at` is the store's time (`messages.received_at`), each `earlier` message's `at` its `sent_at`; the names are masked as whole words in any script, the longer first, text and names compared in NFC; `week_invalid` has a message key, as `inbox_file_invalid`, since messages:check asks one of every code.
- **Tests:** `tests/export-labels.test.ts` (the line, the masking, `earlier`, the week), `tests/export-labels-cli.test.ts` (the command across two workspaces, on the files fake), the api's `tests/inbox-exports.test.ts` (the route, on the slice's files storage). `useInboxExportClient(asRole("app"))` of `@whytide/inbox/testing` points the export's own runs at a test's schema.
