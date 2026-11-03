# inbox: data

Three tenant tables in `packages/db/prisma/schema/inbox.prisma`, migrations `20261029145816_inbox_initial` and `20261029173053_inbox_reply_labels` (beta-p5-040):

- `threads` (`thr_`): `workspace_id`, `channel` (`linkedin`), `sender_account_id` (linkedin's), `owner_user_id` (the account's owner at the first message), `person_id` (contacts'), `provider_thread_ref`, `last_message_at` (moved forward only), `created_at`, `updated_at`. Unique `(workspace_id, channel, provider_thread_ref)`; indexes `(workspace_id, last_message_at)` and `(workspace_id, person_id)`.
- `messages` (`msg_`): `workspace_id`, `thread_id` (a foreign key to `threads` by `(workspace_id, thread_id)`, restrict), `person_id`, `direction` (`in`, `out`), `sent_by` (`campaign`, `user`; null exactly when `direction` is `in`, the CHECK `messages_sent_by`), `step_execution_id` (campaigns', beta-p5-020), `body`, `provider_message_ref`, `sent_at` (the provider's), `received_at` (the store's), `approved_by`, `approved_at` (a campaign message's, from approvals), `opt_out_matched`, `owner_notified_at` (beta-p5-030). Unique `(workspace_id, provider_message_ref)` and `(workspace_id, step_execution_id)`; index `(workspace_id, thread_id, sent_at)`.
- `reply_labels` (`rlb_`, beta-p5-040): `workspace_id`, `message_id` (a foreign key to `messages` by `(workspace_id, message_id)`, `ON DELETE CASCADE`), `label` (enum `reply_label`: `positive`, `not_positive`), `labeled_by` (identity's user id of the member who chose it), `labeled_at`. Unique `(workspace_id, message_id)`: one label per reply, changed in place. Only an inbound message gets one (the label refuses another, `message_not_inbound`). `messages` gained the unique `(workspace_id, id)` the key points at.
- No foreign key leaves the module: the other ids are plain.
- PII: `messages.body`, the person's words as the provider gave them. No other column holds a text or a name; a label is a word and ids.
- Retention: until the person is erased: `erasePerson` deletes the person's messages and every message of their threads, then their threads (privacy's deletion script); a message's label goes with it, by the cascade. A reply that comes after the erasure stores nothing: the store asks contacts first. The message's file under raw/ is deleted by the store, else expires after 72 hours.
- Grants: the owner's default privileges give `app` select, insert, update and delete, as alpha's tenant tables; no row-level policy before zeta.

## The reply golden set's line

`exports/reply-labels-<UTC date>.jsonl`, or `exports/reply-labels-<ISO week>.jsonl` (beta-p7-030; [README](../README.md#the-reply-golden-set)): one JSON object a line, per labeled reply, in the order the labels were chosen.

| Key | |
|---|---|
| `person_sha256`, `thread_sha256` | the sha256, in hex, of the person's id and of the thread's id; no id of the person, the thread, the message or the member |
| `label`, `labeled_at` | the reply's latest label (`reply_labels`), `positive` or `not_positive`, and when it was chosen |
| `received_at`, `text` | the reply: when Whytide stored it (`messages.received_at`), and its text |
| `earlier` | the thread's messages sent before the reply, by `sent_at` then id, the latest 10 (`EXPORT_EARLIER_MAX`), oldest first, each `{ direction, sent_by, text, at }`: `in` or `out`; `campaign`, `user`, or null for the person's; the text; its `sent_at` |

In every text, the person's first and last names (contacts' `getLead`) are `[first_name]` and `[last_name]`: whole words, any case, in any script. Another name a text holds, a colleague's or the sender's, stays as written.
