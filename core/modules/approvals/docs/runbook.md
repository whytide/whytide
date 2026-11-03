# approvals: runbook

No setting. Logs: the api's request log for the routes; this module logs nothing itself.

- **An item stuck drafting:** its draft never ended. messaging's sweep fails a stuck draft, which publishes `messaging.step_draft_ready` with `failed`, and the item gets it; the owner then types the text. If the event was never delivered, look for it in `outbox`.
- **`not_sender_owner` for the owner:** the item's sender account is gone or has another owner (`sender_accounts.owner_user_id`). The item can only wait or be blocked by campaigns.
- **`approvedContent` null for an approved item:** the frozen text changed past messaging's commands, or the account's owner changed since the approval. The send refuses it; do not edit `approval_items` by hand.
