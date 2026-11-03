# approvals: flows

- **An item opens:** campaigns calls `openItem` in its run. A step's pending or approved item is answered as it is; else a `pending` item is written and messaging's `requestStepDraft` asks for the draft, written as the account's owner.
- **The draft attached:** messaging publishes `messaging.step_draft_ready` when the draft ends; the subscriber, in the delivery's transaction, sets `draft_id` on the step's pending item without one. A redelivery or a blocked item changes nothing.
- **An approval:** `POST …/items/{id}/approve` in the request's run: the item is claimed while `pending`, the caller must own the account, the draft must be attached; messaging's `approveStepDraft` checks and freezes the text; the item becomes `approved` with the hash; `approvals.item_decided` is written to the outbox. All commit together or not at all.
- **A skip:** the same checks; the item becomes `skipped`; the draft stays as it is; `approvals.item_decided`.
- **A cancel:** campaigns calls `cancelItems` when it holds, cancels or skips a step: its pending item becomes `blocked`, so a late press is 409.
- **The send's check:** campaigns reads `approvedContent` before a send and compares the hash with what it carries (beta-p3-050).
- **"Up next" loads:** the page reads `GET …/approvals/items` as the member, on the server; the browser reads it again after each decision, every `POLL_MS` while a row is drafting (until `POLL_MAX_MS` after its step opened), and on Check again or Try again. The last read wins.
- **"Up next" presses:** Approve posts `POST …/items/{id}/approve` with `{}`, or `{ text }` once edited; Skip posts `POST …/items/{id}/skip` once its dialog is confirmed. Each press has its own `Idempotency-Key`, which its Try again sends again; a refusal stays on its row, a refused text with the gates' issues. Show facts reads messaging's `GET …/messaging/leads/{personId}/dossier`, once per row, on the first open.
