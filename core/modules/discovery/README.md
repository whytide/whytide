# discovery

Lead discovery. In alpha, a CSV of LinkedIn profile URLs is uploaded and validated before anything is imported (RB-6.2.1, reduced). The upload stores the file in the files port and answers with a report: how many rows, how many are valid, and the first errors with their row numbers. The run, in the worker, then makes a person and a lead of each valid row through contacts, and tells qualification with an event. The screen, `/w/{workspace}/import`, does all three ("The screen", below).

- **Owns:** `import_jobs` in `core/packages/db/prisma/schema/discovery.prisma` ([docs/data.md](docs/data.md)), and the uploaded files under each workspace's `imports/` folder in the files port.
- **Public interface:** `index.ts`: `api`, the routes below; `events`, `discovery.import_run_requested` (its own subscriber's) and `discovery.people_imported`; and the registries `errors`, `ids` (`job`), `permissions` and `settings`. The worker loads `workflows/index.ts`: the workflow `discovery_import_run` and its activities `discovery_import_rows` and `discovery_import_failed`.
- **Depends on:** `platform`, `db`, `providers` (the files port), `contacts` (its index: the URL rule `normalizeLinkedinUrl`, the hash check `isHashed`, and the batched commands `upsertPersonsFromSource` and `createLeadsForPersons`), `busboy` (multipart), `csv-parse` (CSV) and `@temporalio/workflow` (the workflow, in Temporal's sandbox); the screen on `@whytide/ui`, `next-intl` and `react`, and on the web's `@whytide/web/api/*`, which the web resolves for it (the module does not list the web: core/apps/web/docs/screens.md).
- **Reviewers:** the owners of this module.

## Routes

The api host mounts them under `/v1/workspaces/{workspaceId}/discovery`. Each has a request in `api-calls/alpha-p10-120-discovery.http`.

| Route | Permission | Answers |
|---|---|---|
| `POST /v1/workspaces/{workspaceId}/discovery/imports` | `imports.write` | 201 with the job, or a file code (below) |
| `GET /v1/workspaces/{workspaceId}/discovery/imports` | `imports.read` | `{ jobs }`: the newest 100 jobs |
| `GET /v1/workspaces/{workspaceId}/discovery/imports/{job}` | `imports.read` | the job; 404 `import_not_found` for an id that is not in this workspace |
| `POST /v1/workspaces/{workspaceId}/discovery/imports/{job}/run` | `imports.write` | 202 with the job, `running`; 404 `import_not_found`; 409 `import_not_runnable` |

`imports.read` and `imports.write` are granted to Owner, Admin and Member.

A job is `{ id, fileName, status, rowCount, validCount, errorCount, errors: [{ row, code }], counts, failure, createdBy, createdAt, startedAt, finishedAt }`. `status` is `validated` when at least one row is valid and `invalid` when none is; the run moves it to `running`, then `done` or `failed`. `counts` is null until the run starts, then the counts so far; `failure` is null unless it failed. `createdBy` is the uploader's user id; `startedAt` is when the run was asked for, null before (and for a job run before alpha-p10-120).

### POST …/imports

The body is `multipart/form-data` with exactly one part: the file, whose name ends in `.csv`. Any other field or part is refused. The route runs outside the request's tenant run (`whytide:own-runs`). It reads the client's stream as it arrives, asks contacts which valid URLs are an erased person's in a tenant run of its own, stores the file as `imports/<job>.csv`, then writes the job in a second run.

- **The file:** UTF-8, with or without a byte-order mark. The header row names `linkedin_url` (required) and `name` and `company` (optional), in any order and any case; other columns are ignored.
- **Limits:** at most `IMPORT_MAX_ROWS` data rows (default 5,000; 50,000 at most) and `IMPORT_MAX_BYTES` (default 5 MiB). The whole body, framing included, may be at most twice `IMPORT_MAX_BYTES` and must arrive within two minutes.
- **Reading:** cells are never evaluated. csv-parse runs without casting, so every cell is text, and `=SUM(…)` stays a string. Each byte is checked as it arrives. At the first row or byte past a limit, reading stops, the rest of the request is left unread, and the answer closes the connection.
- **File codes:** a refused file is not stored and creates no job.
  - `import_unsupported_type` (400): the body is not multipart, has no `.csv` file, or has a field or a second part; the file starts with a ZIP signature or holds a NUL byte (as an `.xlsx` or UTF-16 file does); or the CSV is malformed (an unclosed quote, a row whose width differs from the header's, a record over 64 KiB).
  - `import_bad_encoding` (400): the file is not UTF-8.
  - `import_missing_column` (400): no header row names `linkedin_url`.
  - `import_too_many_rows` (400): more than `IMPORT_MAX_ROWS` data rows.
  - `import_too_large` (413): the file is over `IMPORT_MAX_BYTES`. A body declared larger than twice that gets the host's 413 `payload_too_large` and is not read at all.

### The report

Each data row's `linkedin_url` must be a profile URL by contacts' rule (`normalizeLinkedinUrl`): `linkedin.com/in/<slug>` on `linkedin.com` or `www.linkedin.com`, with or without its scheme, in any case, with at most one trailing slash. A country or mobile host, such as `uk.linkedin.com` or `m.linkedin.com`, is refused for now. A row gets the first code that applies:
- `url_invalid`: no profile URL, and no http(s) URL written with its scheme either;
- `url_not_linkedin`: an http(s) URL of something else, such as a company page or another site;
- `duplicate_in_file`: the same profile, once normalized, as an earlier row;
- `person_erased`: the profile of a person erased from the workspace (contacts' `isHashed`, the `erased` kind). A rejected candidate's hash marks no row.

`row` is the record's number in the file, counting the header as 1. A row whose cells are all empty is skipped and not counted. The job keeps the first 100 errors in row order; the counts cover every row.

### POST …/imports/{job}/run

Starts a `validated` job's run in the worker, once, and answers 202 with the job: `running`, `startedAt` set, its counts at zero. `GET …/imports/{job}` gives the counts as the run goes and once it ends. The route runs in the request's tenant run and has no `Idempotency-Key`: the job is the key. In one transaction it moves the job from `validated` to `running` in one statement, so that a second run, or a concurrent one, answers 409 `import_not_runnable`, and writes `discovery.import_run_requested` `{ workspaceId, jobId }` to the outbox. A failure before that commits leaves the job `validated`.

The worker delivers the event to discovery's own subscriber, which starts the workflow `discovery_import_run` as `discovery.import_run:<workspaceId>:<jobId>`, the workspace from the delivery's tenant, never from the payload; a second delivery starts none. Its activity `discovery_import_rows` re-reads the stored file, checks every row again as the upload did, and asks `isHashed` once for the valid URLs still to import. Then:
- **Each valid row**, in file order and chunks of 500, a chunk's rows in one call of `upsertPersonsFromSource` (`source: import`, `provider: csv`, the URL, `name` and `company` as `companyName`, the upload's time as the values' time), then the persons written in one call of `createLeadsForPersons` with the source `{ kind: imported, ref: <job id> }`. A person imported again keeps its lead, its label and its `firstSourceAt`; the lead gets the job as a second source.
- **Each chunk** is a run of its own, with a 60-second limit: its rows, the counts so far, its number as the chunks done and one `discovery.people_imported` `{ workspaceId, jobId, personIds }` commit together. It first updates the job's row only if the chunks done are its number less one, so two attempts at once never import the same chunk (`import_not_runnable`).
- **`counts`** puts every data row in one bucket: `created`, `updated` (a person the workspace had), `skippedDuplicate` (a profile earlier in the file), `skippedErased` (an erased person's, at the upload or since) and `errors` (no profile URL, or a cell over contacts' limits: a name over 200 characters, a company over 300).
- **A failed chunk** fails the attempt; the worker retries the activity (three attempts, its `db` kind), and each attempt goes on after the last committed chunk. Past the attempts, `discovery_import_failed` ends the job `failed` with `failure: { chunk, code }` (`chunk` the first chunk not committed, 1 for the first 500 rows to import; `code` the attempt's, or `import_failed` for an error with none) and the counts so far, and the workflow fails. The chunks before it stay.
- **The end**: the job `done` with its counts and `finishedAt`. The workflow's result, kept in Temporal's history, is `{ status, counts }`: no cell.

## The screen

`/w/{workspace}/import`, in the navigation's Import group (`ui/nav.ts`). `ui/import/page.tsx` renders the title and a sentence of what the screen is for; `import-screen.tsx` does the rest in the browser, through the generated client. An error shows its code in words (the kit's `ErrorState`), with a retry unless the file itself must change: in the report once there is a job, else under the picker.
- **Pick**: a card with the file input (`.csv`), unseen over a drop zone that a click or a dropped file uses, its limit under it and the upload's status line, beside the expected columns and a sample file to download (`ui/import/downloads.ts`: the three columns and three made-up rows, which validate clean). A file over 5 MiB (`IMPORT_MAX_BYTES`'s default, `domain/limits.ts`) shows `import_too_large` with no request. Any other goes at once to `POST …/imports`, one part named `file`, while the screen says it is uploading; a refused file shows its code, with no retry for the five file codes.
- **Report**: a card with the rows, the valid ones and those with an error as tiles over a bar of the two, and the first errors with their row and their code in words (`discovery.errors.*`), with a link that downloads them as a CSV of `row,code` lines. A `validated` job gets the Run button at its foot; an `invalid` one says there is nothing to import.
- **Run**: `POST …/imports/{job}/run`, then `GET …/imports/{job}` every 2 s while the job is `running`, the screen saying it is importing. A refused or cut answer reads the job: still `validated`, the run's code shows with a retry. A job running for more than ten minutes, by its `startedAt` (or with none), may be stuck: the screen says so, names the runbook's "A job left running", and stops reading it.
- **Result**: a card with the five counts as tiles (what was not imported in red when there is any), a failed run's `failure.code` in words, and the link to `/w/{workspace}/leads`.
- **Past imports**: `GET …/imports` in the browser: a loading state, then the list or an empty state, or the read's code with a retry. Each row has the file, the upload's day over its time, who uploaded it, the status as a badge in its colour (with the stuck hint) and the counts; each answer updates it. "You" marks the viewer's own jobs, from `GET /v1/me`; another member's name no uploader, as no read of a workspace's members exists yet.

## Testing

`@whytide/discovery/testing` exports `useDiscoveryClient(asRole("app"))`, which makes the module's own runs use the test file's schema, and `useContactsCommands({ upsertPersonsFromSource?, createLeadsForPersons? })`, which stands in for contacts' commands in the run (a fault, say); called with nothing, it restores them.

`pnpm -F @whytide/discovery test` runs the row validator, the reader's limits, the chunker and the counts; `test:tenancy` runs the isolation test of `import_jobs`. The routes are tested end to end against the slice's MinIO in the api host's `core/apps/api/tests/discovery-upload.test.ts` and `discovery-run.test.ts`; the run in the worker's `core/apps/worker/tests/discovery-import.test.ts`, on the slice's Temporal, and its recorded history, `workflows/__histories__/discovery_import_run.json`, by `pnpm -F worker test:replay`. The screen is tested in the web's `core/apps/web/tests/import-screen.spec.ts` and `discovery-states.spec.ts` (Playwright), on the e2e api, which mounts discovery and contacts with a fixed test salt and runs no worker: a spec answers the run's poll as the worker leaves the job.

## Decided here

- The upload opens its own tenant runs (`whytide:own-runs`): the host leaves the tenant on `req.tenant`, since `withTenant` inside `withTenantContext` fails with `nested_run`.
- A cell that is no profile is `url_not_linkedin` only when it is an http(s) URL written with its scheme. `example.com/in/x` is `url_invalid`.
- `IMPORT_MAX_ROWS` is 50,000 at most: the erased check sends a file's valid URLs in one query, under Postgres' 65,535 parameters.
- The erased check runs before the file is stored, so a failure there stores nothing.
- Invalid UTF-8 is `import_bad_encoding` even in the first bytes, so the screen can ask for a "CSV UTF-8" save. A ZIP signature or a NUL byte is `import_unsupported_type`.
- The route's body limit is twice `IMPORT_MAX_BYTES`. A file a little over the limit then gets `import_too_large` and is read no further than the limit.
- The upload reads a file only when its name ends in `.csv`. The part's media type is ignored, because browsers differ.
- The stored name drops any folders and keeps at most 255 characters.
- A row number counts CSV records, not lines, because a quoted cell may span lines.
- `import_jobs` has no foreign key to `workspaces`, as in identity.
- The module keeps its own `app` client for the upload's runs and the worker's activities; the api closes it at its shutdown. A chunk's run takes up to 60 seconds there: the host's `context.tenant` keeps Prisma's 5.
- The run is idempotent through the job: its claim is the key, so the route takes no `Idempotency-Key`.
- The run is the worker's (alpha-p10-120): the route claims the job and writes `discovery.import_run_requested` in one transaction, and discovery's own subscriber starts the workflow, as a module starts one from a request (decisions.md). A failure before the commit leaves the job `validated`; once claimed, a failure ends it `failed`, as a workflow id never runs twice.
- The run's state, `startedAt`, the chunks done and the failure, lives in the job's `counts` column: no migration.
- A retried attempt goes on after the last committed chunk, and a chunk first checks the chunks done on the job's row: no chunk is imported twice, by a retry or by two attempts at once.
- The event is `discovery.people_imported`, by the platform's `module.event_name` rule (the task's `people.imported` predates it); it carries the chunk's persons, created or updated.
- An imported value's time, in its provenance, is the upload's (the job's `createdAt`), when the tester handed it over; a lead's source time is the run's.
- A row contacts refuses (`contacts_input_invalid`, a cell over its limits) counts in `errors` and does not stop the run; it is not added to the report. A person erased between the hash check and its row counts in `skippedErased`.
- A chunk's rows go through contacts' batched commands (alpha-p10-080), a call for the persons and one for the leads, instead of about six queries a row. Their `INSERT … ON CONFLICT` merges a person or a lead that another run wrote meanwhile, so no unique key's race aborts a chunk any more, and the chunk's retry after one (P2002) is gone. A row contacts refuses with any code but `person_erased` counts in `errors`.
- The screen is `/w/{workspace}/import`, one segment, as the route generator takes (decisions.md, 2026-10-22); the task's `/w/{ws}/sources/import` waits for nested segments (alpha-p6-060).
- The browser checks a file against `IMPORT_MAX_BYTES`'s default, 5 MiB: the web cannot read the api's settings. A file past a lower configured limit still gets the api's 413 `import_too_large`, shown the same way.
- The upload starts when a file is picked, with no Upload button: it imports nothing, so the report still comes before the run.
- The generated client sends the upload's `FormData` as it is; its type takes no body for a route the api's document gives none, hence one `as never` on that call.
- The row codes' words are literal keys in the screen, which the message check reads; the file and run codes go through the kit's `ErrorState`, as registered codes.
- The past imports are read in the browser, not by `page.tsx`, so that their loading and error states show and a spec can stub the read.
- A job running for more than ten minutes shows the stuck hint, and the screen stops reading it: the cap on the poll. A failed run offers no retry, as a job runs once; its words ask for the file again.
- Who uploaded a job: "You" for the viewer's own, from `GET /v1/me`, and nothing for another member's, until a read of the members exists.
- The sample and the error rows are `data:` URLs the browser builds: no route and no stored file. The error rows hold record numbers and codes only, so no cell is written back out.
