# messaging: flows

## The dossier route

`GET …/messaging/leads/{personId}/dossier`: the host checks the session, the membership and `drafts.read`, then hands the handler the tenant with no run around it (`whytide:own-runs`). `buildDossier` opens one run of the workspace for contacts' `getLead` (its `lead_not_found` becomes `dossier_lead_not_found`) and `getCompany`, onboarding's `readCompanyKnowledge` (which creates the empty record on a workspace's first read) and signals' `listEvidence`; reads the user with tenancy's `findUser` after it, outside any run; and answers `assembleDossier`'s dossier. Nothing is written but that empty record; no event is published.

## A draft requested

`POST …/messaging/leads/{personId}/drafts { channel }` (`drafts.write`, `@Idempotent()`): in the request's tenant run, `requestDraft` checks the lead with contacts' `getLead` (`dossier_lead_not_found`), writes a `drafting` row and publishes `messaging.draft_requested` (ids only: the workspace, the draft, the person, the member who asked, the replaced draft); 202 with the draft. The worker delivers the event to `events.ts`, which starts `messaging_draft_message` by the id `messaging.draft:<workspace>:<draft>`, so a second delivery starts no second run. Its activity `messaging_write_draft` (kind `ai`: three attempts of five minutes at most) calls `writeDraft`, below; past its attempts, `messaging_draft_failed` marks the draft `failed`, `write_failed`, if it is `drafting` still, and the workflow fails. The draft panel (alpha-p9-030) reads `GET …/drafts/{id}` until the draft is no longer `drafting`.

## An edit

`PATCH …/drafts/{id} { editedText }` (`drafts.write`): 409 `draft_not_editable` while the draft is `drafting`; 400 `messaging_input_invalid` (`fields: ["editedText"]`) for a text, trimmed, above the channel's hard limit (a note `LINKEDIN_NOTE_LIMIT`, a message 1,900); otherwise `edited`, with `edited_text` and `edited_at`, `text` left as the writer wrote it. The writer writes only a `drafting` draft, so nothing changes an edited one.

## A regeneration

`POST …/drafts/{id}/regenerate` (`drafts.write`, `@Idempotent()`): 409 while the draft is `drafting`; otherwise `requestDraft` with `replacesId`, a new `drafting` row of the same person and channel, and its event; 202 with it. Its writer sends the replaced draft's angle, call to action and text (the member's edit, if any) in `<replaced>`, asking for a different one. The replaced row stays as it is.

## A draft written

`writeDraft` (`domain/drafts/write.ts`), outside any run: it reads the draft in a tenant run (a draft no longer `drafting` answers its status, so a retried activity changes nothing); resolves the requester's membership with tenancy's `resolveMembership` (none: `failed`, `draft_requester_not_member`, before any call); builds the dossier as that member (no lead: `failed`, `dossier_lead_not_found`); builds the blocks (`domain/drafts/blocks.ts`); calls the planner, then the writer, each through `callAgent`, which opens its own runs for the cache, the decision record and the cost event, and runs the gates on each answer. An answer with an issue is asked again with the issues, at most two regenerations in all; `ai_failed` ends the draft `failed`. The last run writes the draft once, if it is `drafting` still. Nothing is published, and nothing is logged.

## The draft panel

contacts' lead page renders `ui/draft-panel/panel.tsx` on the server in its `draft` slot, which shows its loading state meanwhile: `GET …/leads/{personId}/drafts` as the member and, when the newest draft has a plan, `GET …/leads/{personId}/dossier`; a read the api refuses is the panel's error state, whose retry reads the page again, and any other fault the slot's. In the browser, Draft is `POST …/leads/{personId}/drafts { channel }` with a new `Idempotency-Key`, then `GET …/drafts/{id}` until the draft is no longer `drafting`: every two seconds, then an eighth of its age, thirty seconds at most, and none past twenty minutes, when a note offers Check again, one more read. Save is `PATCH …/drafts/{id} { editedText }`; Regenerate is `POST …/drafts/{id}/regenerate`, polled the same way; a newer plan on another dossier hash reads the dossier once more, a loading line meanwhile. A failed request shows its code in words with a retry, which sends Draft or Regenerate again with the same key; a refused Save keeps the text. Copy writes the text to the clipboard: the member sends it on LinkedIn, and nothing is sent from the product.
