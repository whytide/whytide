# approvals: concepts

- **Item:** one step of a sequence that can reach a person (a connection request, `invite`, or a message), waiting for the owner of its sender account. It moves once, from `pending` to `approved`, `skipped` or `blocked`.
- **Decision:** the owner's approve or skip, from the app (`decision_origin = app`). A cancel is not a decision: campaigns blocks the item when it holds, cancels or skips the step.
- **Frozen text:** messaging's final text of the step's draft once approved. The item keeps its SHA-256 (`approved_content_hash`); `approvedContent` answers the text only while the two match.
- **Drafting:** an item whose draft is not attached yet: its writer has not ended it.
- **Stale:** the step's local day, in the sender's zone, is before today there. **Needs attention:** pending for `NEEDS_ATTENTION_AFTER_DAYS` (3) days or more. Both are computed when the queue is read.
- **Wait:** why an approved step has not gone out yet, a code (`insufficient_credits`, the note budget) and maybe a time, which campaigns' sender sets.
- **Small edit:** an approval whose edit ratio is above 0 and at most `SMALL_EDIT_MAX_RATIO` (0.2).
