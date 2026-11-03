# icp

The workspace's one ICP: who it sells to, as targeting fields (titles, seniorities, industries, company sizes, countries) and two texts the AI criteria read (must-haves and disqualifiers), plus six fixed criteria with their weights in the fit score. Qualification (alpha-p6) reads it through `readIcpForScoring`; a targeting change moves the ICP's version and publishes `icp.updated`, so leads scored before can be re-scored. Its screen is `/w/{ws}/icp` ("The screen"); `pnpm icp:draft` drafts it from the Company Knowledge or an admin's brief ("The script").

- **Owns:** `icps` (with its draft's columns) and `criteria` in `core/packages/db/prisma/schema/icp.prisma` ([docs/data.md](docs/data.md)).
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`; the draft on `ai` (`callAgent`), onboarding's `readCompanyKnowledge` and tenancy's workspace lookup; the screen on `@whytide/ui` and the web host's api client.
- **Reviewers:** the owners of this module.

## Public interface

| | |
|---|---|
| `readIcpForScoring(workspaceId)` | `{ icp, criteria }`: the `Icp` (id, name, the targeting fields, `version`, `updatedAt`) and its six `Criterion` rows (`key`, `weight`, `isMust`, `enabled`) in the order of `CRITERION_KEYS`. For qualification's activity, inside its own tenant run (`withTenant`); the first read creates the empty ICP, as `GET` does; another workspace than the run's is `tenant_mismatch` |
| `api` | the routes below |
| `events` | `icp.updated` `{ workspaceId, version }`, on a targeting change only; `icp.draft_requested` `{ workspaceId, icpId, draftRunId }`, which its own subscriber turns into the draft's workflow |

The registries: `ids` (`icp`, `crit`, `idrun` for a draft's run), `errors` (below) and `draftErrors` ("The draft"), each with its key in `messages/en.json`, `permissions` (`icp.read`: Owner, Admin, Member; `icp.write`: Owner, Admin; kept, not evaluated, in alpha), `events`, `settings` (`AI_MODEL_ICP_DRAFT_PROFILE`, the drafter's model) and `workflows/` (`icp_draft_profile`).

## Routes

The api host mounts them under `/v1/workspaces/{ws}/icp`; their requests are in `api-calls/alpha-p4-040-icp-record-and-api.http`.

| Route | Permission | Does |
|---|---|---|
| `GET /v1/workspaces/{ws}/icp` | `icp.read` | the ICP; the first read creates it empty, version 1, with the six default criteria |
| `PUT /v1/workspaces/{ws}/icp` | `icp.write` | saves every field (a full replacement) and answers the saved ICP |
| `GET /v1/workspaces/{ws}/icp/criteria` | `icp.read` | `{ criteria }`, the six |
| `PUT /v1/workspaces/{ws}/icp/criteria` | `icp.write` | saves the six, each key once, and answers them |

A value off a closed list is 400 `icp_unknown_seniority`, `icp_unknown_size_range` or `icp_unknown_country`, `details.fields` naming each one's path (`seniorities.1`), never the value; weights that do not sum to 100 are 400 `icp_weights_must_sum_100` with `details.sum`. A length or a count off the limits is the host's 400 `validation_failed`.

## The record

- `name` (100 characters at most), `titles` (50, each 1 to 100 characters), `seniorities` and `sizeRanges` (the closed lists of `domain/lists.ts`), `industries` (free text, 30, each 1 to 100 characters), `countries` (ISO 3166-1 alpha-2, either case), `mustHaves` and `disqualifiers` (1,000 characters each), `version`, `updatedAt`.
- Seniorities: `owner_founder`, `c_level`, `vp`, `head`, `director`, `manager`, `senior_ic`, `ic`. Size ranges, in employees: `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001+`. Their labels are `icp.seniority.*` and `icp.size.*`, through `ui/labels.ts`.
- Stored trimmed and without duplicates: seniorities and sizes in the list's order, countries upper-case in code order.
- The version moves by one when a targeting field changes (any field but the name; the lists compared as sets), and `icp.updated` is written to the outbox in the same transaction. The name alone, or a criteria save, keeps it.
- The criteria a new ICP gets, with the weights of F04 §4.3 (the planning repository): `title_function` 30 and `location` 10 as musts, `seniority` 15, `company_size` 10, `industry` 15, `must_haves` 20, all enabled.

## The screen

`/w/{ws}/icp`, under the ICP group (`ui/nav.ts`): `ui/edit/page.tsx` reads the ICP and its criteria as the visitor, and `ui/edit/icp-form.tsx` edits them, in cards: the profile's name; the people and the companies, side by side from `lg`; the must-haves and disqualifiers; the criteria (`ui/edit/criteria.tsx`). The kit's `SaveBar` holds Save and the note that a save scores the leads again, and stays in view while the form differs from what the api holds.
- Titles and industries are free-text chips; seniorities, company sizes and countries chips from their lists, the countries named by `Intl.DisplayNames` in the user's locale, stored as upper-case ISO codes.
- Must-haves and disqualifiers: text areas of 1,000 characters with a counter and the hint that the model reads them as data.
- The criteria: weight (a `TextField` with `inputMode="numeric"`, digits only, 100 at most) with a bar of its share, must and enabled (the kit's `Checkbox`), and the sum with its bar, in the danger colour until it is 100. The version badge in the header.
- Save sends `PUT …/icp/criteria`, then, once it passed, `PUT …/icp`: weights the api refuses leave the record as it was. A code of `errors.ts` shows in words next to its field (`ui/labels.ts`), `validation_failed` next to each field of `details.fields` (`icp.screen.invalid`), any other code in an `ErrorState`.
- Its end-to-end test is the web host's `core/apps/web/tests/icp-screen.spec.ts` (`pnpm -F web test`), on the e2e api, which mounts icp.

## The draft

The ICP's draft runs in the worker; nothing reaches the ICP's fields until the script saves it. `domain/draft.ts`, `domain/drafter.ts`, `workflows/`.

- **The request** (`requestDraft`): the brief, trimmed, is 2,000 characters at most (`icp_draft_brief_too_long`); Company Knowledge's content fields and the brief all empty is `icp_draft_no_source`; neither writes. Otherwise, in one transaction, the ICP (created on the first read) becomes `drafting` under a new run (`idrun_`) with the brief, its error and pending draft cleared, and `icp.draft_requested` carries the ids. The version stays and no `icp.updated` is written.
- **The workflow** `icp_draft_profile` (`icp.draft:<ws>:<run>`, so a second delivery starts nothing): the activity `icp_draft_from_sources` (kind `ai`) reads the sources while the run is the ICP's latest, calls the agent [`icp.draft-profile`](agents/draft-profile/README.md) outside any tenant run, then writes, under the ICP's row lock, `drafted` with `pending_draft` (the fields, the model, the prompt version, the decision record), or `failed` with `ai_failed` (an answer off its schema or gate twice) or `icp_draft_no_source` (the sources emptied since). A run a later request replaced writes nothing (`superseded`). Past its three attempts, `icp_draft_failed` marks the run `failed`, `draft_failed`, and the workflow fails.
- **The codes** `draftErrors`: `icp_draft_brief_too_long` 400, `icp_draft_no_source` 409, `icp_draft_agent_not_loaded` 500 (the worker started without the task). No route answers them, so the screen has no label for them.

## The script

`pnpm icp:draft --workspace <id or slug> [--brief <text> | --brief-file <path>] [--dry-run] [--replace]` (`cli/draft.ts`), for an engineer setting a workspace up; the worker must run. It calls no model. A relative `--brief-file` is read from the folder pnpm was called in.

1. Finds the workspace (`workspace_not_found` else). An ICP with any targeting field set is `icp_not_empty` unless `--replace`, before anything is written.
2. Requests the draft and prints `icp_draft_requested: <run> in <ws>`, then reads the ICP every 2 seconds for 10 minutes at most, longer than the drafter's three attempts.
3. Prints the proposal, one line per field, or ends: `icp_draft_failed: <code>` (exit 3), `icp_draft_superseded` (exit 4, a later request's run), `icp_draft_timed_out: … is the worker running?` (exit 5).
4. With `--dry-run`, stops (`icp_draft_not_saved`). Otherwise locks the ICP's row and checks it again (`--replace`), checks the proposal against the PUT body's schema (`icp_draft_invalid`, exit 3) and saves it through `saveIcp`: the version moves on a targeting change and `icp.updated` re-scores the workspace's leads, at 0.2 credit a lead (`icp_saved: version N; …`). The criteria stay as they are.

Exit codes, the script's own (through pnpm, any but 0 is 1): 0 done, 1 refused, 2 usage, 3 failed, 4 superseded, 5 timed out. No line prints the brief or the company's text.

## Commands

`domain/commands.ts`: `getIcp(workspaceId)`, `getCriteria(workspaceId)`, `saveIcp(fields)`, `saveCriteria(rows)` and `readIcpForScoring(workspaceId)`, each inside the caller's tenant run, through `tenantClient`, opening none. Two first reads at once both answer the one ICP (`INSERT … ON CONFLICT DO NOTHING`); two saves at once, of the ICP or of its criteria, are ordered by a lock on the ICP's row, so each reads what the other committed and they cannot deadlock.

## Testing

`pnpm -F icp test` runs the rules' unit tests, the isolation tests of `icps` and `criteria` and `readIcpForScoring`'s, and `tests/draft.test.ts`: the request, and the script end to end with the test writing the draft as the worker would; `pnpm -F icp test:tenancy` the isolation file alone. The drafter and its workflow run on the LLM fake in the worker's `tests/icp-draft.test.ts` (`pnpm -F worker test`); `workflows/__histories__/icp_draft_profile.json` is replayed by `pnpm -F worker test:replay`. The routes end to end are the api host's test, `core/apps/api/tests/icp-api.test.ts`: `pnpm -F icp build`, then `pnpm -F api test`.

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
