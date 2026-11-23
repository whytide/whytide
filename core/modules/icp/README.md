# icp

The workspace's ICP: who it sells to, as targeting fields (titles, seniorities, industries, company sizes, countries) and two texts the AI criteria read (must-haves and disqualifiers), plus six fixed criteria with their weights in the fit score. A workspace holds up to `ICP_MAX_AUDIENCES_PER_WORKSPACE` (10 unset; "Settings") such profiles, its audiences (gamma-p3-020); one is its default, the ICP that every caller without an audience's id acts on, as before audiences. Qualification (alpha-p6) reads the default through `readIcpForScoring`; a targeting change moves an audience's version and publishes `icp.audience_updated`, and the default's `icp.updated` too, so leads scored before can be re-scored. Its screen is `/w/{ws}/icp` ("The screen"), whose draft card, as `pnpm icp:draft` ("The script"), drafts an audience from the Company Knowledge or an admin's brief.

- **Owns:** `icps` (with its draft's columns) and `criteria` in `core/packages/db/prisma/schema/icp.prisma` ([docs/data.md](docs/data.md)).
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`; the draft on `ai` (`callAgent`), onboarding's `readCompanyKnowledge` and tenancy's workspace lookup; the screen on `@whytide/ui` and the web host's api client.
- **Reviewers:** the owners of this module.

## Public interface

| | |
|---|---|
| `readIcpForScoring(workspaceId, icpId?)` | `{ icp, criteria }`: the `Icp` (id, name, the targeting fields, `version`, `updatedAt`) and its six `Criterion` rows (`key`, `weight`, `isMust`, `enabled`) in the order of `CRITERION_KEYS`; the audience `icpId`, else the default. For qualification's activity, inside its own tenant run (`withTenant`); the first read creates the empty default, as `GET` does; another workspace than the run's is `tenant_mismatch`, an id the workspace does not hold `icp_not_found` |
| `listAudiences()`, `findAudience(icpId)` | in the caller's tenant run: the workspace's audiences (`AudienceSummary`: id, name, `isDefault`, `createdBy`, `version`, `updatedAt`), the default first, then by name; one `Audience` of the run's workspace, or null |
| `api` | the routes below |
| `events` | `icp.updated` `{ workspaceId, version }`, on a targeting change of the default only; `icp.audience_updated` `{ workspaceId, icpId, version }`, on a targeting change of any audience, the default's included; `icp.draft_requested` `{ workspaceId, icpId, draftRunId }`, which its own subscriber turns into the draft's workflow |

The registries: `ids` (`icp`, `crit`, `idrun` for a draft's run), `errors` (below) and `draftErrors` ("The draft"), each with its key in `messages/en.json`, `permissions` (`icp.read` and `icp.write`: Owner, Admin, Member; `icp.manage`: Owner, Admin, who write every audience; "Decided here"), `events`, `settings` (`AI_MODEL_ICP_DRAFT_PROFILE`, the drafter's model, and `ICP_MAX_AUDIENCES_PER_WORKSPACE`, "Settings") and `workflows/` (`icp_draft_profile`).

## Routes

The api host mounts them under `/v1/workspaces/{ws}/icp`; their requests are in `api-calls/alpha-p4-040-icp-record-and-api.http`, the draft's in `api-calls/icp-draft-screen.http`, the audiences' in `api-calls/gamma-p3-020-many-audiences.http`. The draft's POSTs are idempotent, as onboarding's: each takes an `Idempotency-Key` UUID. The ICP's own routes and the draft's act on the default; the draft's take `?icpId=<id>` for another audience.

| Route | Permission | Does |
|---|---|---|
| `GET /v1/workspaces/{ws}/icp` | `icp.read` | the ICP; the first read creates it empty, version 1, with the six default criteria |
| `PUT /v1/workspaces/{ws}/icp` | `icp.write` | saves every field (a full replacement) and answers the saved ICP |
| `GET /v1/workspaces/{ws}/icp/criteria` | `icp.read` | `{ criteria }`, the six |
| `PUT /v1/workspaces/{ws}/icp/criteria` | `icp.write` | saves the six, each key once, and answers them |
| `GET /v1/workspaces/{ws}/icp/draft` | `icp.read` | `{ status, error, pending, hasKnowledge }`: the latest draft's status and code, its proposal (`fields`, `promptVersion`, and `runId`, its run, which the accept sends back) or null, and whether Company Knowledge has a content field; never the brief, the model or the decision record |
| `POST /v1/workspaces/{ws}/icp/draft` | `icp.write` | 202: requests a draft from `{ brief? }` ("The draft"), over an ICP with targeting too, and answers as GET does |
| `POST /v1/workspaces/{ws}/icp/draft/accept` | `icp.write` | saves the proposal of the run (`{ runId, replace? }`, "The draft") and answers the saved ICP, as PUT does |
| `POST /v1/workspaces/{ws}/icp/draft/discard` | `icp.write` | ends the draft, every field of the ICP kept, and answers as GET does |
| `GET /v1/workspaces/{ws}/icp/audiences` | `icp.read` | `{ audiences, limits }`: each one's id, name, `isDefault`, `createdBy`, `version`, `updatedAt`, the default first, then by name; `limits: { audiences }`, the limit as configured ("Settings"); the first read makes the default |
| `POST /v1/workspaces/{ws}/icp/audiences` | `icp.write` | 201: a new audience from `{ name }` (1 to 80 characters, trimmed), version 1, with the six default criteria, its creator the member; answers as the list does |
| `GET`, `PUT /v1/workspaces/{ws}/icp/audiences/{icpId}` | `icp.read`, `icp.write` | the audience, as `GET …/icp` and `PUT …/icp` do the default's |
| `GET`, `PUT /v1/workspaces/{ws}/icp/audiences/{icpId}/criteria` | `icp.read`, `icp.write` | its six criteria, as `…/icp/criteria` do the default's |

A value off a closed list is 400 `icp_unknown_seniority`, `icp_unknown_size_range` or `icp_unknown_country`, `details.fields` naming each one's path (`seniorities.1`), never the value; weights that do not sum to 100 are 400 `icp_weights_must_sum_100` with `details.sum`. A length or a count off the limits is the host's 400 `validation_failed`. An `icpId` the workspace does not hold, another workspace's included, is 404 `icp_not_found` on every route that takes one; a create past `ICP_MAX_AUDIENCES_PER_WORKSPACE` (10 unset, the default included; "Settings") is 409 `icp_audience_limit` with `details.limit` the value configured. The draft's codes are in "The draft".

## The record

- `name` (100 characters at most), `titles` (50, each 1 to 100 characters), `seniorities` and `sizeRanges` (the closed lists of `domain/lists.ts`), `industries` (free text, 30, each 1 to 100 characters), `countries` (ISO 3166-1 alpha-2, either case), `mustHaves` and `disqualifiers` (1,000 characters each), `version`, `updatedAt`.
- Seniorities: `owner_founder`, `c_level`, `vp`, `head`, `director`, `manager`, `senior_ic`, `ic`. Size ranges, in employees: `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001+`. Their labels are `icp.seniority.*` and `icp.size.*`, through `ui/labels.ts`.
- Stored trimmed and without duplicates: seniorities and sizes in the list's order, countries upper-case in code order.
- The version moves by one when a targeting field changes (any field but the name; the lists compared as sets), and `icp.audience_updated` is written to the outbox in the same transaction, with `icp.updated` for the default. The name alone, or a criteria save, keeps it.
- Each audience is such a record with its own criteria, plus `isDefault`, true for one per workspace, and `createdBy`: the member whose request created it, or `system` for a service's run (the worker's, the script's); null on a row older than audiences.
- The criteria a new ICP gets, with the weights of F04 §4.3 (the planning repository): `title_function` 30 and `location` 10 as musts, `seniority` 15, `company_size` 10, `industry` 15, `must_haves` 20, all enabled.

## The screen

`/w/{ws}/icp`, under the ICP group (`ui/nav.ts`): `ui/edit/page.tsx` reads the audiences, then the one `?audience=<icpId>` names, else the default through the ICP's own routes, and its criteria, as the visitor, and `ui/edit/icp-form.tsx` edits them, in cards: the profile's name; the people and the companies, side by side from `lg`; the must-haves and disqualifiers; the criteria (`ui/edit/criteria.tsx`). The kit's `SaveBar` holds Save and the note that a save scores the leads again, and stays in view while the form differs from what the api holds.
- Titles and industries are free-text chips; seniorities, company sizes and countries chips from their lists, the countries named by `Intl.DisplayNames` in the user's locale, stored as upper-case ISO codes.
- Must-haves and disqualifiers: text areas of 1,000 characters with a counter and the hint that the model reads them as data.
- The criteria: weight (a `TextField` with `inputMode="numeric"`, digits only, 100 at most) with a bar of its share, must and enabled (the kit's `Checkbox`), and the sum with its bar, in the danger colour until it is 100. The version badge in the header.
- The audience picker (`ui/edit/audience-picker.tsx`) under the header: the kit's `Select` of the audiences, the default first and marked "(default)", opens the one chosen at `?audience=<icpId>`. New audience asks for a name in the kit's `Dialog`, creates it and opens it; at the list's `limits.audiences` it is off, the limit said beside it.
- Save sends the chosen audience's `PUT …/audiences/{icpId}/criteria`, then, once it passed, `PUT …/audiences/{icpId}`: weights the api refuses leave the record as it was, and no other audience changes. A code of `errors.ts` shows in words next to its field (`ui/labels.ts`), `validation_failed` next to each field of `details.fields` (`icp.screen.invalid`), any other code in an `ErrorState`.
- The draft card (`ui/edit/draft-card.tsx`), on top, drafts the chosen audience: the default's through the draft's routes without an id, as before audiences, another's with `?icpId=`. No draft: a line on what it does, the brief (2,000 characters with a counter and the hint that the model reads it as data) and Draft from Company Knowledge, which needs a brief while Company Knowledge is empty, the card then linking to the Company screen. Drafting: a status line while it reads `GET …/icp/draft` every 2 seconds for 10 minutes at most (`domain/constants.ts`, the script's waits), then "is the worker running?" with a retry, which reads again. Drafted: the proposal, read-only, the lists by their labels and the countries by name, with Use this draft, the re-score note beside it, and Discard. Failed: the code in words and Draft again.
- Use asks first in the kit's `Dialog` when the ICP has targeting or the form has unsaved changes, then sends `replace: true`; the form then shows the saved ICP and its version, the criteria as stored, and says it was saved. A route's code shows in words in the card (`ui/labels.ts`), any other code in an `ErrorState`.
- An audience the visitor may not write, another member's or, for a Member, the default ("Decided here"), shows its fields disabled under the hint `icp.screen.not_owner`, without the draft card and Save; the page reads `GET /v1/me` for the member and their role. The picker and New audience stay.
- Its end-to-end tests are the web host's `core/apps/web/tests/icp-screen.spec.ts` and `icp-draft.spec.ts` (`pnpm -F web test`), on the e2e api, which mounts icp; its e2e module writes the draft as the drafter leaves it, and its `tests/e2e-icp.ts` removes the audiences of `wsp_e2e_audiences` but the default before the audiences' test.

## The draft

The ICP's draft runs in the worker; nothing reaches the ICP's fields until a member uses it on the screen or the script saves it, but for the automatic draft's own save into an empty default ("The automatic draft"). `domain/draft.ts`, `domain/drafter.ts`, `workflows/`.

- **The request** (`requestDraft`): the brief, trimmed, is 2,000 characters at most (`icp_draft_brief_too_long`); Company Knowledge's content fields and the brief all empty is `icp_draft_no_source`; neither writes. Otherwise, in one transaction, the ICP (created on the first read) becomes `drafting` under a new run (`idrun_`) with the brief, its error and pending draft cleared, and `icp.draft_requested` carries the ids. The version stays and no `icp.updated` is written.
- **The workflow** `icp_draft_profile` (`icp.draft:<ws>:<run>`, so a second delivery starts nothing): the activity `icp_draft_from_sources` (kind `ai`) reads the sources while the run is the ICP's latest, calls the agent [`icp.draft-profile`](agents/draft-profile/README.md) outside any tenant run, which answers every field, inferring what Company Knowledge does not state (prompt v2, the `complete` gate), then writes, under the ICP's row lock, `drafted` with `pending_draft` (the fields, the model, the prompt version, the decision record), or `failed` with `ai_failed` (an answer off its schema or gate twice) or `icp_draft_no_source` (the sources emptied since). A run a later request replaced writes nothing (`superseded`). Past its three attempts, `icp_draft_failed` marks the run `failed`, `draft_failed`, and the workflow fails.
- **The review** (`acceptDraft`, `discardDraft`): the screen's Use this draft and Discard, and the script's save, under the ICP's row lock. Without a drafted proposal, or the accept's with another `runId` than the ICP's latest run (a later request's), `icp_draft_none`: nothing is saved, and the card reads the draft again. The accept over an ICP with targeting needs `replace`, else `icp_not_empty`; a proposal off the PUT body's schema is `icp_draft_invalid`, `details.fields` its paths. Otherwise `saveIcp` saves the name and the targeting, the criteria kept, and the draft ends, in one transaction: `none`, its error, run and proposal cleared, the brief kept. A targeting change moves the version and publishes `icp.updated`, as a PUT does. The discard ends the draft alone.
- **The codes** `draftErrors`: the request's `icp_draft_brief_too_long` 400 and `icp_draft_no_source` 409; the review's `icp_draft_none` 409, `icp_not_empty` 409 and `icp_draft_invalid` 422; the worker's `icp_draft_agent_not_loaded` 500 (started without the task), which no route answers. The card puts the routes' codes in words, and a failed run's `ai_failed`, `draft_failed` and `icp_draft_no_source`.

## The script

`pnpm icp:draft --workspace <id or slug> [--icp <id>] [--brief <text> | --brief-file <path>] [--dry-run] [--replace]` (`cli/draft.ts`), for an engineer setting a workspace up; the worker must run. It calls no model. A relative `--brief-file` is read from the folder pnpm was called in. It drafts the default; `--icp` another audience of the workspace (`icp_not_found: <id>` else), whose lines name it: `icp_draft_requested: <run> in <ws>, audience <id>`, and, saved, `icp_saved: version N of <id>; not the default audience: no re-score`.

1. Finds the workspace (`workspace_not_found` else). An ICP with any targeting field set is `icp_not_empty` unless `--replace`, before anything is written.
2. Requests the draft and prints `icp_draft_requested: <run> in <ws>`, then reads the ICP every 2 seconds for 10 minutes at most, longer than the drafter's three attempts.
3. Prints the proposal, one line per field, or ends: `icp_draft_failed: <code>` (exit 3), `icp_draft_superseded` (exit 4, a later request's run), `icp_draft_ended` (exit 6, the draft used or discarded on the screen meanwhile), `icp_draft_timed_out: … is the worker running?` (exit 5).
4. With `--dry-run`, stops (`icp_draft_not_saved`), the proposal left for the screen. Otherwise saves it as the screen's Use this draft does (`acceptDraft`, "The draft"), with its own run: the ICP's targeting checked again under its row lock (`--replace`), the proposal against the PUT body's schema (`icp_draft_invalid`, exit 3), then `saveIcp`: the version moves on a targeting change and `icp.updated` re-scores the workspace's leads, at 0.2 credit a lead (`icp_saved: version N; …`). The criteria stay as they are, and the draft ends; one that ended or a later request replaced after the last read is `icp_draft_none` (exit 1).

Exit codes, the script's own (through pnpm, any but 0 is 1): 0 done, 1 refused, 2 usage, 3 failed, 4 superseded, 5 timed out, 6 ended on the screen. No line prints the brief or the company's text.

## Commands

`domain/commands.ts`: `getIcp(workspaceId, icpId?)`, `getCriteria(workspaceId, icpId?)`, `saveIcp(fields, icpId?)`, `saveCriteria(rows, icpId?)`, `readIcpForScoring(workspaceId, icpId?)`, `listAudiences()`, `findAudience(icpId)` and `createAudience({ name, createdBy })`, each inside the caller's tenant run, through `tenantClient`, opening none; without `icpId`, the default, and an id the workspace does not hold is `icp_not_found`. Two first reads at once both answer the one default (`INSERT … ON CONFLICT DO NOTHING` on the partial unique index `icps_default`); two creates at once count one after the other under the workspace's advisory lock (`pg_advisory_xact_lock`), so the limit holds; two saves at once, of an audience or of its criteria, are ordered by a lock on its row, so each reads what the other committed and they cannot deadlock.

Every write of an audience, the PUTs of its fields and its criteria, by its id or the default's, and the draft's request, accept and discard, goes through `lockedIcpId`, which asks platform's `canWriteOwned` about the row before it writes: its owner writes it, a holder of `icp.manage` writes every one, and anyone else is 403 `forbidden` and nothing changes (`domain/owner.ts` says who owns an audience). The default, and a row whose `created_by` is null or `system`, belong to the workspace: `icp.manage` only. A service's run, the worker's or `pnpm icp:draft`'s, writes every one.

## Testing

`pnpm -F icp test` runs the rules' unit tests with the default's first reads (`tests/domain.test.ts`), `tests/audiences.test.ts` (the create and its limit under a race, the saves and their events, another workspace's id, `created_by`), `tests/owners.test.ts` (who writes an audience: its owner, an Owner, a Member refused another's, the default and a row owned by nobody, nothing changing), the isolation tests of `icps` and `criteria` and `readIcpForScoring`'s, and `tests/draft.test.ts`: the request, and the script end to end with the test writing the draft as the worker would; `pnpm -F icp test:tenancy` the isolation file alone. The drafter and its workflow run on the LLM fake in the worker's `tests/icp-draft.test.ts` (`pnpm -F worker test`); `workflows/__histories__/icp_draft_profile.json` is replayed by `pnpm -F worker test:replay`. The routes end to end are the api host's tests, `core/apps/api/tests/icp-api.test.ts`, the draft's `icp-draft-api.test.ts` and the audiences' `icp-audiences-api.test.ts`: `pnpm -F icp build`, then `pnpm -F api test`.

## Decided here

- The default weights follow F04 §4.3 by key (industry 15, company size 10), not the order of the task's key list.
- A closed-list value is any string in the body's schema, so that one off the list answers its own code; the answers type the lists as enums.
- `PUT …/icp` replaces every field; the version starts at 1.
- A criteria save keeps the version and publishes nothing: the task ties the bump to the targeting fields.
- The weights sum to 100 over the six, enabled or not; the scorer renormalizes over the enabled ones (alpha-p6-030).
- A title and an industry are 1 to 100 characters; the task gives counts only.
- No foreign key to `workspaces` (Prisma would need the opposite relation in `tenancy.prisma`); the unique key is `(workspace_id, icp_id, key)`, the workspace being in every unique key.
- The commands run in the caller's run, so the module keeps no database client of its own.
- The screen's keys are snake_case (`icp.screen.size_ranges`, `must_haves`, `data_hint`, `rescore_note`): the key check refuses the camelCase names of the task. `icp.screen.name`, `icp.screen.invalid`, `icp.nav.profile` and `icp.criterion.*` are added.
- One Save for both records, the criteria first; the note about re-scoring sits beside Save, and a save shows `icp.screen.saved`.
- The draft's codes are a registry of their own, `draftErrors`: the screen's labels cover the routes' codes only.
- The script checks that the workspace exists before the request, so that a mistyped id writes no ICP.
- The drafter reads the proof points' texts, not their pages, and not the website or the tone: what the ICP needs, and a stable cache key.
- A draft's writes move `updated_at`, as onboarding's do; the answers' shapes stay.
- The draft's accept and discard are idempotent too, as onboarding's: the accept re-scores the leads, which costs credits.
- An accept or a discard ends the draft: its error, run and proposal cleared, so that a late write of that run finds itself superseded; the brief stays.
- The script saves through `acceptDraft`, as the screen does: the draft now ends after its save; it saves its own run's proposal under the lock, so that one used, discarded or replaced meanwhile is `icp_draft_none`; it checks the targeting before the schema.
- The accept takes the proposal's run, required (the review of !230): a Use of a proposal that a later request replaced since the card read it saves nothing. The discard takes no run: it saves nothing.
- A draft used or discarded on the screen while the script reads has its own line and exit, `icp_draft_ended` (6), not `icp_draft_superseded`: its run is cleared, and no later run replaced it.
- `POST …/icp/draft`'s schema takes a brief of any length, so that one too long answers `icp_draft_brief_too_long`.
- The card's retry after ten minutes reads the draft again; it requests no new one.
- The form tells the ICP's targeting itself: a screen cannot import `domain/rules.ts`, which imports the platform.
- Audiences (gamma-p3-020): the limit, `ICP_MAX_AUDIENCES_PER_WORKSPACE` (10 unset), counts the default, which a list or a create makes first. `icp.updated` stays the default's alone, so qualification's re-score is unchanged; `icp.audience_updated` is every audience's, the default's too.
- The keys are `icp.errors.icp_not_found` and `icp.errors.icp_audience_limit`, as the platform composes them, and the screen's snake_case (`icp.screen.audience_label`, `default_badge`, `new_audience`, `new_audience_name`, `audience_limit`, `default_name`), as the key check wants; `icp.screen.create_audience` (the dialog's button) and `unnamed_audience` (an audience whose name a PUT emptied) are added.
- The draft's routes take an optional `?icpId=` rather than routes of their own: the card drafts the chosen audience, and without it acts on the default exactly as before.
- The form saves every audience, the default too, through `…/audiences/{icpId}`; the picker opens an audience with a page load (`window.location.assign`), as icp does not depend on `next`.
- `POST …/audiences` takes no Idempotency-Key: it spends no credit and calls no provider (coding §4, `api/`), and the limit holds whatever is repeated. Its name is 1 to 80 characters; a PUT keeps the record's 0 to 100.
- `created_by` names the principal's user for any actor but a service, whose run records `system`, so that an actor type added later records its user.
- Who writes an audience (gamma-p6-015): its owner, the member in `created_by`, and a holder of `icp.manage` (Owner, Admin); `icp.write` lists Member. The default is the workspace's, whoever's read created it, so a Member never writes it, by `PUT …/icp`, `PUT …/icp/criteria` or its id; nor a row whose `created_by` is null (made before audiences) or `system`. The check sits in `lockedIcpId`, the one gate of every write, so the draft's request, accept and discard of another member's audience are refused too; a refused write that read the default first rolls it back with the run. The create is not checked: any member makes audiences, owned by them.
- The screen's hint is one key, `icp.screen.not_owner`, its ICU `select` naming the default or another member's audience; the task's camelCase name fails the key check. The screen reads `GET /v1/me` and compares the audience's owner and the member's role with `ICP_MANAGE_ROLES`, which `permissions.ts` declares `icp.manage` from; the api decides.
- `icps_default` is hand-written SQL; `(workspace_id, updated_at)` is declared in the schema, as the tenant-index lint wants. The migration is expand-first: `is_default` defaults to true, so the release before this one still inserts a default.
- The routes' tests are the api host's `icp-audiences-api.test.ts`, as icp's others: a module's test never imports a host. `tests/domain.test.ts` gains the database for the first reads.
- The automatic draft (icp-auto-draft): its save runs inside the drafter's write (`recordDraft`, in the drafter's activity), so the workflow's commands are unchanged: no `patched()`, and the recorded history replays as it is, with no new one; the run's result gains `saved`.
- The automatic run is marked by a column, `draft_automatic`, not by the event or the workflow's input, which stay as they were; a member's request and the end of a draft clear it.
- The trigger reads the Company Knowledge before it takes the lock, so that a save without a content field makes no ICP; it ignores the event's version and reads the record as it is now.
- An automatic proposal off the PUT body's schema waits for review, as one whose ICP got targeting: Use then answers `icp_draft_invalid`, as for any draft.
- The card does not say that a draft was automatic: it would need the draft's answer to carry the flag, more than one message key.

## The automatic draft

Once Company Knowledge is ready, the default audience drafts itself from it, and the draft is saved while the ICP is still empty (the owner's request, 2026-11-06). `domain/auto-draft.ts`, `events.ts`, `domain/draft.ts`.

- **The trigger**: icp subscribes to onboarding's `onboarding.company_knowledge_updated`, which every save or accept that changes Company Knowledge publishes. In the delivery's tenant run, `draftAutomatically` requests a draft of the default without a brief, marked automatic (`draft_automatic`), under the default's row lock (the default made on the first read), when all hold: Company Knowledge has a content field (`requestDraft`'s rule), the default has no targeting (`hasTargeting`), and no draft of it is `drafting` or `drafted`. Otherwise it writes nothing. The lock orders a burst of saves and a second delivery: the first requests, the others find it drafting. A failed automatic draft stays `failed`; the next update tries again while the ICP is still empty. The other audiences are never drafted automatically.
- **The save**: the run is `icp_draft_profile`, as any draft's. When its drafter's write lands (`recordDraft`) and the ICP still has no targeting under its row lock, the proposal is saved in the same transaction as Use this draft saves it without `replace`: `saveIcp`, the criteria kept, the draft ended, the version moved and `icp.updated` published; the run's result is `saved`. When targeting appeared meanwhile, or the proposal is off the PUT body's schema, it waits for review on the screen as any draft does. A member's draft, the screen's or the script's, waits for review as before.
- **The cost**: the draft is free, its agent priced at no credit (`maxCostCredits: 0`; the cost event records the call). The save's `icp.updated` re-scores the leads already scored, as every save of the ICP does, at 0.2 credit a lead; with an empty ICP that is normally none.
- **Tests**: `tests/auto-draft.test.ts` (the trigger, through the platform's delivery) in `pnpm -F icp test`; the save in the worker's `tests/icp-draft.test.ts`, on the LLM fake.

## Settings

`ICP_MAX_AUDIENCES_PER_WORKSPACE` (10, the audiences of one workspace, its default included), an integer of 1 or more with no maximum (the default is `AUDIENCES_PER_WORKSPACE` in `domain/constants.ts`), and `AI_MODEL_ICP_DRAFT_PROFILE` (the drafter's model, "The draft"), `settings.ts`: the `modules/icp` block of `deploy/.env.example`. The limit (limits-env, the owner's request of 2026-11-15) replaces the constant `MAX_AUDIENCES_PER_WORKSPACE`, which is gone. Unset or empty, the default applies. A value that is not an integer of 1 or more (0, a negative, a decimal, a word) stops the api's start with `config_invalid` naming it, and the worker's, which loads the module. It is read once, as the module loads: **a changed value needs an api restart**. `createAudience` refuses past it with `details.limit` the value configured, and `GET …/icp/audiences` answers it as `limits: { audiences }`, which the audience picker shows; never a `NEXT_PUBLIC_` variable or a value of the build. The OpenAPI document never depends on it: the create's summary names the default only.

Each live agent needs an audience no other live agent has (playbooks README "Settings"): keep `ICP_MAX_AUDIENCES_PER_WORKSPACE` at or above playbooks' `PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE`, else the audiences run out before the agents. The limit has no upper bound (limits-no-max, the owner, 2026-11-15: "Limits set in .env should not have hard upper limit"); only the number's own range stops a value, above 9007199254740991 (the largest safe integer).

The tests: `tests/limits.test.ts` sets 3 audiences, and tries 1000 and values that are not integers of 1 or more in processes of their own; `tests/audiences.test.ts` runs the default; the api host's `icp-audiences-api.test.ts` reads the list's `limits`.
