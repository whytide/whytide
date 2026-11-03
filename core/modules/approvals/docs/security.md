# approvals: security

- **Personal data:** the table holds ids only. The queue's answer carries the lead's name, title and company and the draft's text, to the workspace's members only (`approvals.read`).
- **Who decides:** `approvals.decide` (every role), and then only the owner of the item's sender account: no one else speaks through a personal account. Another member reads the item with `canDecide: false`.
- **Nothing sent without approval:** `approvedContent` answers only for an item approved by the account's owner, and only while messaging's frozen text hashes to the approval's hash; a pending, skipped or blocked item, or a changed text, answers null. A decision applies once, under a condition on `pending`.
- **Logs:** messaging's `draft_text_refused` quotes the text's words in its details (`phrase`, `entity`); this module never logs it, only the caller reads it.
- **The event:** `approvals.item_decided` carries ids and the decision only, never a text.
- **Erasure:** privacy's deletion script deletes the person's items (`erasePerson`).
