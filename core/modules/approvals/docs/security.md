# approvals: security

- **Personal data:** the table holds ids only. The queue's answer carries the lead's name, title and company and the draft's text, to the owner of the item's sender only (`approvals.read`, then their own senders).
- **No cross-user view (gamma-p6-050):** "Up next" reads the caller's own senders' items only, whatever their role; an Owner or an Admin does not read another member's queue, which waits for the audit log (RB-13.1.3). Beta's screen showed every item with its controls off, so every member read every draft.
- **Who decides:** `approvals.decide` (every role), and then only the owner of the item's sender, the LinkedIn account or an email's mailbox: no one else speaks through a personal account or mailbox. Another member, an Owner too, is refused (`not_sender_owner`) and never reads the item.
- **Nothing sent without approval:** `approvedContent` answers only for an item approved by its sender's owner, and only while messaging's frozen text, an email's subject with it, hashes to the approval's hash; a pending, skipped or blocked item, or a changed text, answers null. A decision applies once, under a condition on `pending`, the mode's too.
- **The mode's approval:** only through messaging's `approveStepDraftByMode`, so its text always ends with the AI disclosure line, which the hash covers; never on an item opened for a person, a connection request or a draft not `ready`; recorded with no person. Fail closed: `approvedContent` answers it only to a caller asking `allowMode: true`, and answers null for a mode's approval without the line or a person's with it.
- **Logs:** messaging's `draft_text_refused` quotes the text's words in its details (`phrase`, `entity`); this module never logs it, only the caller reads it.
- **The event:** `approvals.item_decided` carries ids and the decision only, never a text.
- **Erasure:** privacy's deletion script deletes the person's items (`erasePerson`).
