# inbox: flows

## The store

1. linkedin's receiver keeps a message of an outreach the platform started: it writes the file `raw/linkedin/messages/<event_key_hash>.json`, then in one transaction its receipt, the row's `last_inbound_at` (the gate's reply check) and `linkedin.message_received { sender_account_id, person_id, direction, file_key }`.
2. The worker's outbox delivers the event to the subscriber (`events.ts`), which starts `inbox_store_message` with `{ workspaceId, senderAccountId, personId, direction, fileKey }` by the id `inbox.message:<workspaceId>:<event id>`: a second delivery starts none.
3. The activity `inbox_store` (`workflows/index.ts`, kind `provider`) reads the file through the files port, outside any run, and parses it with linkedin's `messageFile`: missing (`files_not_found`), invalid (not JSON, off the schema, a key outside the workspace, or a direction other than the event's), or the message.
4. Outbound, the account's own message (beta-p5-020), one tenant run (`domain/store/echo.ts`), never a hold:
   - contacts' `lockLeadStatus`, then `getPerson`: for a person erased since, the run ends here;
   - a row holding the message's `provider_message_ref` already: the platform's message, stored by the step's event ("The step's event" below), and the run ends here;
   - else the tester's, typed on LinkedIn: contacts' `recordTouch(personId, sentAt)` (`person_not_found` ends the run with nothing written), the thread by its chat, and the message, `sent_by = user`, the file's text;
   - the answer `{ stored, messageId?, held: false, optOut: false }`; a missing file stores nothing, an invalid one stays and fails `inbox_file_invalid`.
5. Inbound, one tenant run (`domain/store/store.ts`):
   - campaigns' `holdForReply(personId, { at })`, `at` the message's `sentAt`, else the store's time: every pending step of the person `held`, each active enrollment `replied`, the lead `replied` unless suppressed;
   - without a file, the run ends here;
   - contacts' `getPerson`: for a person erased since (`person_not_found`), the run ends here too, nothing stored or published, and the file is deleted after it;
   - linkedin's `findSenderAccount`: the thread's owner;
   - the thread by its chat, inserted unless there (`ON CONFLICT DO NOTHING`), its `last_message_at` moved forward;
   - the message, inserted unless a row holds its `provider_message_ref` already: a repeat ends the run here;
   - on `matchesOptOut(text)`: contacts' `addOptOut(personId, { source: "system", reason: "reply_opt_out" })`, which suppresses the lead, and `opt_out_matched`;
   - `inbox.reply_received { messageId, threadId, personId }`.
6. Once the run committed, the file is deleted. An invalid file stays and the activity fails `inbox_file_invalid`, the hold committed.

The answer is `{ stored, messageId?, held, optOut }`, ids and booleans. The stop takes the outbox's delivery, the workflow's start and one run: about a second on the stack, inside RB-23.1.3's 60 seconds.

## The step's event

beta-p5-020: campaigns' settle publishes `campaigns.step_sent { stepExecutionId, personId, actionType }` once a send went out, its touch recorded. The worker's outbox delivers it to the subscriber (`events.ts`), which writes in the delivery's own run (`domain/store/sent.ts`), from rows only:

1. An `actionType` other than `message` (a connection request, a withdrawal): nothing.
2. contacts' `lockLeadStatus`, then `getPerson`: for a person erased since, nothing.
3. A row holding the step already: a redelivery, nothing.
4. campaigns' `sentStep` (the step `succeeded`: its account and `executed_at`), approvals' `approvedContent` (the frozen text, `approved_by`, `approved_at`) and linkedin's `sentMessageRef` (the provider's message and chat refs). A null from any, or a step of another person or action: nothing, and the `error` line `inbox_sent_message_unmatched` with the step's id.
5. linkedin's `findSenderAccount`, the thread by its chat as the store's, and the message: `direction = out`, `sent_by = campaign`, the step, the approved text, the provider's ref, `sent_at = executed_at`, `approved_by`, `approved_at`.
6. A row holding the ref already, stored from the echo as the user's: it becomes the campaign's, with the step, the approval and the approved text, its `sent_at` kept.

The order race: the provider's echo can reach the receiver before the step's event is delivered, or after. Both runs lock the lead first and the unique `(workspace_id, provider_message_ref)` keeps one row: the echo first stores it as the user's (and a touch, the same day as the send's), and the step's event then claims it; the step's event first stores it as the campaign's, and the echo then finds it and changes nothing.

## The reads

beta-p5-040, in the member's tenant run, from inbox's tables and contacts' `getLead` only (`domain/threads/queries.ts`):

1. The list (`GET …/inbox/threads`): `limit + 1` threads by `last_message_at`, then id, both descending, after the cursor's pair when one is given; the extra row only says that a next page exists, and the page's last row is its cursor.
2. The page's messages, ids and directions, oldest first: the last one's direction is who wrote last; the replies among them without a `reply_labels` row are its `toLabel`.
3. Each person of the page through `getLead`, one call per person: their names, title and company, or null when contacts answers `lead_not_found` or `person_not_found`.
4. The thread (`GET …/inbox/threads/{id}`): the thread, then its messages oldest first with their texts, each reply with its label, and the person as above; none, in this workspace, is `thread_not_found`.

## The label

`PUT …/inbox/messages/{id}/label` (`domain/labels/label.ts`), in the member's tenant run:

1. The message, in this workspace, or `inbox_message_not_found`; an outbound one is refused `message_not_inbound`.
2. The row inserted with the label, the member and now, unless the message has one (`ON CONFLICT DO NOTHING` on `(workspace_id, message_id)`).
3. When it had one with another label, that row changed in place to the label, the member and now; with the same label, nothing changes.
4. The answer: the row's label, member and time.

## The reply mail

1. The store's run publishes `inbox.reply_received { messageId, threadId, personId }` for a newly stored reply (above).
2. The worker's outbox delivers it to the module's own subscriber (`events.ts`), which starts `inbox_reply_mail` with `{ workspaceId, messageId }` by the id `inbox.reply_mail:<workspaceId>:<messageId>`: a second delivery starts none. The mail goes from the workflow, never from the delivery's run.
3. The activity `inbox_mail_reply` (`workflows/index.ts`, kind `provider`) runs `mailReply` (`domain/mail.ts`):
   - a tenant run: the inbound message and its `owner_notified_at`, its thread (`owner_user_id`, `person_id`) and the person's first name (contacts' `getPerson`). A message, thread or person gone (erased since) answers `{ sent: false, reason: "gone" }`; a set marker, `{ sent: false, reason: "already_sent" }`;
   - outside any run: tenancy's `findUser(ownerUserId)`, which reads the global users table. No user, or a disabled one: `{ sent: false, reason: "owner_unavailable" }`, and an `info` line with the message's, the thread's and the user's ids;
   - `renderMail("inbox.mail.reply", { firstName, hasName, link, hasLink }, locale)`, the user's locale when it has messages, else the default; the link `<APP_PUBLIC_ORIGIN>/w/<workspaceId>/inbox/<threadId>`, none while the origin is empty; then the app-mail port's `send({ to, subject, text })`;
   - a second tenant run: `owner_notified_at = now` where it is still null. It answers `{ sent: true }`.
4. A failed attempt (the port's `mail_unreachable`, the database) is retried by Temporal, five attempts in all; the marker stops an attempt after the mail went. The port takes no idempotency key: a crash between the send and the marker sends a second mail on the next attempt, a window accepted.

## The reply golden set

beta-p7-030 (README "The reply golden set"): `GET …/inbox/exports/reply-labels.jsonl` or `pnpm inbox:export-labels`, through the same function (`domain/export/reply-labels.ts`), in the caller's tenant runs: the route opens its own (`whytide:own-runs`), the command a set per workspace as the service `inbox`.

1. A `week`, when given, is checked first (`domain/export/week.ts`): its Monday 00:00 UTC to the next Monday, else `week_invalid`.
2. One run reads the labels, all of them or those chosen in the week, by `labeled_at`, then id.
3. A run per 100 labels (`EXPORT_PAGE`) reads their messages, inbound ones only, their threads, every message of those threads, and each person's names through contacts' `getLead` (a person erased since gets no line), then builds the lines (`domain/export/reply-line.ts`).
4. Outside any run, the files port writes `exports/reply-labels-<UTC date or ISO week>.jsonl` and replaces a file of the same name; past 25 MiB it refuses `files_too_large`. No row is written.
