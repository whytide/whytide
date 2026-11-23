# approvals: concepts

- **Item:** one step of a sequence that can reach a person (a connection request, `invite`, a message, or an `email` from a mailbox), waiting for the owner of its sender, the LinkedIn account or the mailbox. It moves once, from `pending` to `approved`, `skipped` or `blocked`.
- **Decision:** the owner's approve or skip, from the app (`decision_origin = app`). A cancel is not a decision: campaigns blocks the item when it holds, cancels or skips the step.
- **The mode's approval:** an item opened for the campaign's mode (`approval_by = mode`) approved by it once its draft is `ready`, its text ending with the channel's AI disclosure line (`decision_origin = approval_mode`, no `decided_by`). Not a person's decision: no stat counts it, and a caller sees it only with `allowMode`. **Mode declined:** the wait of such an item the mode left to a person.
- **Frozen text:** messaging's final text of the step's draft once approved, a first email's subject with it. The item keeps its SHA-256 (`approved_content_hash`, of an email's body and subject together); `approvedContent` answers the text only while the two match.
- **Drafting:** an item whose draft is not attached yet: its writer has not ended it.
- **Stale:** the step's local day, in the sender's zone, is before today there. **Needs attention:** pending for `APPROVALS_NEEDS_ATTENTION_AFTER_DAYS` (3 unset) days or more. Both are computed when the queue is read.
- **Wait:** why an approved step has not gone out yet, a code (`insufficient_credits`, the note budget) and maybe a time, which campaigns' sender sets.
- **Small edit:** an approval whose edit ratio is above 0 and at most `APPROVALS_SMALL_EDIT_MAX_RATIO` (0.2 unset).
