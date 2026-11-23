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

beta-p5-040, in the member's tenant run, from inbox's tables and contacts' `getLead` only (`domain/threads/queries.ts`), each read of threads on the caller's `owner_user_id` (gamma-p6-060):

1. The list (`GET …/inbox/threads`): `limit + 1` of the caller's threads by `last_message_at`, then id, both descending, after the cursor's pair when one is given; the extra row only says that a next page exists, and the page's last row is its cursor.
2. The page's messages, ids and directions, oldest first: the last one's direction is who wrote last; the replies among them without a `reply_labels` row are its `toLabel`.
3. Each person of the page through `getLead`, one call per person: their names, title and company, or null when contacts answers `lead_not_found` or `person_not_found`.
4. The thread (`GET …/inbox/threads/{id}`): the caller's thread, then its messages oldest first with their texts, each reply with its label, and the person as above; none of the caller's, in this workspace, is `thread_not_found`, another member's as another workspace's.

## The label

`PUT …/inbox/messages/{id}/label` (`domain/labels/label.ts`; gamma-p4-055), one of campaigns' 7 labels, in the thread owner's tenant run:

1. The message, in this workspace, and its thread, the caller's own, or `inbox_message_not_found` (another member's says nothing of whose it is); an outbound one of theirs is refused `message_not_inbound`.
2. contacts' `lockLeadStatus` on the person (no lead: `inbox_message_not_found`), before any write, as the classifier and an erasure take it.
3. The row as it stands: with the same class, nothing changes, nothing acts, and the answer is the row.
4. The row inserted with the class, beta's word that follows it (`positive` for `interested`, else `not_positive`), the member and now (`ON CONFLICT DO NOTHING` on `(workspace_id, message_id)`), else changed in place to them.
5. For the person's newest reply (by `sent_at`, then id, in any of their threads), campaigns' `applyReplyLabel(personId, { label, suggested: false, returnDate, threadId, ownerUserId, repliedAt })`, the return date the reply's classification's for `out_of_office`, `repliedAt` the reply's `sent_at`, which takes campaigns' locks and acts (an interested notice, a reminder, a cool-down, a pause, an opt-out on every channel); campaigns' repeat rule acts on nothing for a label already acted on at that reply. For an older reply, contacts' `addOptOut` on an `opt_out` only.
6. The answer: `{ label, classLabel, labeledBy, labeledAt }`.

The classifier's later answer for a reply the owner labeled acts on nothing but an `opt_out` ("A reply classified", step 4).

## The reply mail

1. The store's run publishes `inbox.reply_received { messageId, threadId, personId }` for a newly stored reply (above).
2. The worker's outbox delivers it to the module's own subscriber (`events.ts`), which starts `inbox_reply_mail` with `{ workspaceId, messageId }` by the id `inbox.reply_mail:<workspaceId>:<messageId>`: a second delivery starts none. The mail goes from the workflow, never from the delivery's run.
3. The activity `inbox_mail_reply` (`workflows/index.ts`, kind `provider`) runs `mailReply` (`domain/mail.ts`):
   - a tenant run: the inbound message and its `owner_notified_at`, its thread (`owner_user_id`, `person_id`) and the person's first name (contacts' `getPerson`). A message, thread or person gone (erased since) answers `{ sent: false, reason: "gone" }`; a set marker, `{ sent: false, reason: "already_sent" }`;
   - outside any run: tenancy's `findUser(ownerUserId)`, which reads the global users table, then `resolveMembership({ userId, workspaceIdOrSlug: workspaceId })`, the user's active membership of the thread's workspace (gamma-p6-060). No user, a disabled one, or one no longer a member (removed): `{ sent: false, reason: "owner_unavailable" }`, and an `info` line with the message's, the thread's and the user's ids, through the host's logger;
   - `renderMail("inbox.mail.reply", { firstName, hasName, link, hasLink }, locale)`, the user's locale when it has messages, else the default; the link `<APP_PUBLIC_ORIGIN>/w/<workspaceId>/inbox/<threadId>`, none while the origin is empty; then the app-mail port's `send({ to, subject, text })`;
   - a second tenant run: `owner_notified_at = now` where it is still null. It answers `{ sent: true }`.
4. A failed attempt (the port's `mail_unreachable`, the database) is retried by Temporal, five attempts in all; the marker stops an attempt after the mail went. The port takes no idempotency key: a crash between the send and the marker sends a second mail on the next attempt, a window accepted.

## The reply golden set

beta-p7-030 (README "The reply golden set"): `GET …/inbox/exports/reply-labels.jsonl` or `pnpm inbox:export-labels`, through the same function (`domain/export/reply-labels.ts`), in the caller's tenant runs: the route opens its own (`whytide:own-runs`), the command a set per workspace as the service `inbox`.

1. A `week`, when given, is checked first (`domain/export/week.ts`): its Monday 00:00 UTC to the next Monday, else `week_invalid`.
2. One run reads the labels, all of them or those chosen in the week, by `labeled_at`, then id; the route's, those of the caller's own threads only (gamma-p6-060): the ids of their threads' inbound messages first, since the tenant client refuses a relation in a where, then those messages' labels. The command reads every member's.
3. A run per 100 labels (`EXPORT_PAGE`) reads their messages, inbound ones only, their threads, every message of those threads, and each person's names through contacts' `getLead` (a person erased since gets no line), then builds the lines (`domain/export/reply-line.ts`).
4. Outside any run, the files port writes `exports/reply-labels-<UTC date or ISO week>.jsonl` and replaces a file of the same name; past 25 MiB it refuses `files_too_large`. No row is written.

## A reply from the inbox

gamma-p4-060, LinkedIn's channel (README "Replies from the inbox"):

1. `POST …/inbox/threads/{id}/replies` with `{ text }` and an `Idempotency-Key`, in the member's tenant run (`domain/reply/request.ts`): the thread, the caller's own (else `thread_not_found`); the channel sending (else `reply_channel_unavailable`); the text trimmed, within the channel's (else `reply_text_invalid`); contacts' `lockLeadStatus`, then `suppressionOf(personId, { newEnrollment: false })` (else `person_suppressed`); the row `out`, `sent_by = user`, `created_by`, `send_status = sending`; `inbox.reply_requested { messageId }`. 202 `{ messageId, status: "sending" }`. Nothing is sent in the request.
2. The worker's outbox delivers the event to the module's subscriber, which starts `inbox_send_reply { workspaceId, messageId }` by the id `inbox.reply:<workspaceId>:<messageId>`.
3. `inbox_reply_begin` (`workflows/reply.ts`, `domain/reply/begin.ts`), one tenant run: the row still `sending`, else its status; the lead locked; the suppression again (`refused`, `person_suppressed`); the member id and the account (`refused`, `reply_channel_unavailable`); linkedin's `reserveSend({ accountId, actionType: "message", idempotencyKey: messageId })`, which reads the switches, the account's health and hours and the day's budgets (a refusal: `refused` with its code). Outside the run, the request file `raw/inbox/<messageId>/send.json`; one there already means an earlier attempt, so the send is asked as a retry.
4. linkedin's `linkedin_check_reply { workspaceId, accountId, personId }` first, as campaigns' sender reads the chat before a message: the chat since the account's last send, a message of the person's marked (`last_inbound_at`) before this send moves `last_sent_at`. Refused, the settle's `read` phase: the row `refused` with the code, the slot released (on a retry, the outcome left to step 6). Then linkedin's `linkedin_send_message { workspaceId, accountId, reservationId, requestKey, stepAttempt }`, one attempt: a retry checks the chat before it calls; the gate reads the switches and the slot again; the call, then the slot committed or released and the log row (linkedin's README "Sending").
5. `inbox_reply_settle` in a tenant run (`domain/reply/settle.ts`), the lead locked first:
   - sent: linkedin's `sentMessageRef(messageId)`, the provider's message ref and time; an echo stored before it deleted; the row `sent` with the ref and `sent_at`; the thread's `last_message_at` moved forward; contacts' `recordTouch(personId, sentAt)`;
   - refused (before the call) or failed (after it): the row with the code;
   - unknown (no answer, or linkedin's own unknown): nothing changes; the answer carries the wait.
   A settled reply's request file is deleted after the run.
6. While unknown, up to three times: a timer for the wait, then linkedin's `linkedin_check_sent`, then the settle on its answer (`not_sent`: `failed` with the send's code). Never a second send.
7. The echo: the provider's copy reaches linkedin's receiver and the store as the account's own message ("The store", step 4): a row holding its ref is the reply, and nothing changes; before the settle, it is stored as the tester's, and the settle removes it and takes its ref. The lead's lock orders the two runs.

The workflow's input, answers and history carry ids, codes, statuses and times only; the text stays in the row and the request file.

## A reply drafted

inbox-reply-draft (README "The reply draft"):

1. `POST …/inbox/threads/{id}/reply-draft` with `{ brief? }` and an `Idempotency-Key`, in the member's tenant run (`domain/reply-draft/request.ts`): the thread, the caller's own (else `thread_not_found`); the channel sending (else `reply_channel_unavailable`); the brief trimmed, within 2,000 (else `reply_brief_too_long`); contacts' `lockLeadStatus`, then `suppressionOf(personId, { newEnrollment: false })` (else `person_suppressed`). The thread's draft still `drafting`: answered as it is. Else the thread's draft deleted, a new one written `drafting` with the brief, the requester and the ready text it replaces; `inbox.reply_draft_requested { draftId }`. 202 with the draft. No model is called and nothing is sent.
2. The worker's outbox delivers the event to the module's subscriber, which starts `inbox_draft_reply { workspaceId, draftId }` by the id `inbox.reply_draft:<workspaceId>:<draftId>`.
3. `inbox_write_reply_draft` (kind `ai`, `domain/reply-draft/write.ts`): in a tenant run, the draft (not `drafting`: its status, and nothing more), its thread's person, the thread's latest 20 messages sent by the person or the account, oldest first; outside any run, messaging's `writeReply` with them, the brief, the replaced text and the draft's id as the request's (messaging's flows, "A reply drafted"); in a last run, the draft `ready` with the text, the model, the prompt version and the decision record, or `failed` with the code, only while it is `drafting` (else its status as stored, or `gone`).
4. Past the activity's three attempts: `inbox_reply_draft_failed`, the draft `failed` with the failure's code, then the workflow fails.
5. The screen reads `GET …/reply-draft` every 2 seconds while drafting; Use draft puts the text in the reply box, which sends only at Send ("A reply from the inbox").
6. Every 15 minutes, `inbox_reply_draft_sweep` fails each workspace's drafts still `drafting` 30 minutes after their request, `draft_stuck`.

The event, the workflow's input, answers and history carry ids, statuses and codes only; the brief, the conversation and the draft stay in the tables and the worker's process.

## A reply classified

gamma-p4-040 (README "The classifier"):

1. The store's run publishes `inbox.reply_received` for a newly stored reply, after it held the steps and, on a phrase, suppressed the person (above). The worker's outbox delivers it to the module's second subscriber, which starts `inbox_classify_reply { workspaceId, messageId, threadId, personId }` by the id `inbox.classify:<workspaceId>:<messageId>`: a second delivery starts none.
2. `inbox_classify` (kind `ai`, `domain/classify/classify.ts`), a tenant run: the inbound message (none: `gone`), a classification of it (one: `repeat`), its thread, the person (contacts' `getPerson`; erased: `gone`) and the thread's last 6 messages before the reply, a reply from here only when sent. `opt_out_matched`: `opt_out`, origin `phrase`, confidence 1, and step 4.
3. Outside any run: tenancy's `findUser` names the thread's owner; the texts masked (`domain/classify/mask.ts`); ai's `callAgent(inbox.classify-reply, { workspaceId, subjectRef: personId, input })`, which retries a refused answer once. `ai_failed`: `other`, suggested, origin `fallback`, with the record's id. Else the label, suggested under `INBOX_CLASSIFY_SUGGEST_BELOW` (0.7 unset), and the return date for `out_of_office` only, kept from the reply's UTC day to 90 days after. A port's code fails the attempt, and Temporal retries it.
4. A tenant run (`domain/classify/write.ts`): contacts' `lockLeadStatus`, then the person still known (else `gone`, nothing written); a phrase's match takes `opt_out` whatever step 3 gave; the row, once (`repeat` when it exists); for the person's newest reply its thread's owner has not labeled (gamma-p4-055, "The label"), campaigns' `applyReplyLabel(personId, { label, suggested, returnDate, threadId, ownerUserId, repliedAt })`, which takes campaigns' locks and acts; for an older one, or one the owner labeled, contacts' `addOptOut` on an `opt_out` only; the answer in `actions_taken`; `inbox.reply_classified { classificationId, messageId, threadId, personId, label }`.
5. Past the activity's three attempts: `inbox_classify_failed` (kind `db`) runs step 4 with `other`, suggested, origin `fallback`, no record.

The event, the workflow's input, answers and history carry ids, statuses and the label only; the masked texts are in the decision record's raw prompt.
