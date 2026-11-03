# @whytide/ai: security

## The grounding sample's sheet

The sheet ([README](../README.md#the-grounding-sample)) is a way for data to leave: it holds the workspace's texts as written, the why bullets' quotes and the drafts, with their facts, which name the lead (a first name, a headline, a post's link and excerpt, the company). It is read in the workspace's own tenant runs (`tests/tenancy.test.ts` holds `grounding_samples`), written through the files port under the workspace's `exports/` only, and kept 7 days at most. Only an engineer's command writes it; no route answers it. Nothing logs a text, a fact or an email: the command prints the file's key, the counts and the codes. `grounding_samples` holds counts, the ISO week and the reader's user id, and no person: the deletion script has nothing to erase there, and a `person_id` added to it would need ai's eraser to delete its rows.
