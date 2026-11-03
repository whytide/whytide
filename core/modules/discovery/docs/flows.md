# discovery: flows

- **Upload** (`POST …/imports`). The api host runs its guards, the workspace's rate limit and `can(imports.write)`. Its body reader lets the multipart body through unread. The route has `whytide:own-runs`, so the host opens no tenant run and leaves the tenant on `req.tenant`. Then, in order:
  1. busboy reads the request as it arrives, counting the body's bytes, and hands over the one `.csv` part.
  2. `readCsv` checks each chunk (bytes, ZIP signature, NUL byte, UTF-8) and feeds it to csv-parse. `RowCheck` checks each data row's URL by contacts' `normalizeLinkedinUrl`.
  3. When a row is valid, a `withTenant` run on the module's client asks contacts' `isHashed` about the file's valid URLs, in one query. The `erased` ones become `person_erased`.
  4. The file's bytes go to the files port with `put` (`maxBytes: IMPORT_MAX_BYTES`).
  5. A second `withTenant` run writes the job with the report.
  The answer is 201 with the job. A refusal at steps 1 or 2 stops the reading, closes the connection, and leaves no file and no job. A failure at step 3 leaves no file and no job either.
- **Read** (`GET …/imports`, `GET …/imports/{job}`). These run inside the request's tenant run: one query through the tenant client, scoped to the workspace.
- **Run** (`POST …/imports/{job}/run`, `domain/import/run.ts`). The guards check `can(imports.write)`; the route runs in the request's tenant run, one transaction:
  1. It reads the job: `import_not_found`.
  2. It claims the job: `UPDATE … SET status = 'running', counts = <zeros, startedAt, chunks 0> WHERE id = … AND status = 'validated'`. No row is `import_not_runnable`: not validated, or another run was first.
  3. It writes `discovery.import_run_requested` `{ workspaceId, jobId }` through the outbox.
  The answer is 202 with the job, `running`. A failure before the commit leaves the job `validated` and no event.
- **The run in the worker** (`events.ts`, `workflows/`). The outbox loop delivers the event in the job's workspace; discovery's subscriber starts `discovery_import_run` as `discovery.import_run:<workspaceId>:<jobId>`, the workspace from `currentTenant()`; a second start of that id starts nothing. The workflow calls `discovery_import_rows`, whose steps are tenant runs on the module's client, as the worker's service:
  1. It reads the job; one no longer `running` is answered as it is.
  2. The files port's `get` reads the stored file; `readCsv` and `RowCheck` check every row as the upload did. One query asks contacts' `isHashed` about the valid URLs of the chunks still to import.
  3. The rows to import go in chunks of 500 (`domain/import/chunks.ts`), from the chunk after the last committed one. Each chunk is a run of its own, with a 60-second limit: the job's row updated only if its chunks done are the chunk's number less one (else `import_not_runnable`); the rows not erased in one call of `upsertPersonsFromSource`, then the persons written in one call of `createLeadsForPersons`; one `discovery.people_imported` through the outbox; the counts and the chunk's number on the job.
  4. A last run ends the job `done` with the counts and `finished_at`; the activity answers `{ status, counts }`.
  The host's wrapper heartbeats every 20 seconds, and a failed attempt is retried, three in all, each from the chunk after the last committed one. Past them, the workflow calls `discovery_import_failed`, which ends the job `failed` with `failure: { chunk, code }`, and the workflow fails. The worker delivers the `discovery.people_imported` events; qualification (alpha-p6-040) subscribes to them.
- **Screen** (`/w/{workspace}/import`, `ui/import/`). The web renders `page.tsx` on the server: the title. In the browser, `import-screen.tsx` then:
  1. reads `GET …/imports`, the past imports: a loading state, then the list, an empty state, or the code with a retry; and `GET /v1/me`, the viewer, whose own jobs say "You";
  2. checks a picked file's size against 5 MiB and, past it, shows `import_too_large` with no request;
  3. sends the file to `POST …/imports` through the web's `/api` rewrite, as one multipart part named `file`, and shows the report of the job it answers, or the code it refuses the file with;
  4. on Run, sends `POST …/imports/{job}/run`. On a 202, or when a refused or cut answer's job is `running`, it reads `GET …/imports/{job}` every 2 s until the job leaves `running`, then shows its counts or its failure's code; a job running for more than ten minutes shows the stuck hint, and the reads stop. A job still `validated` shows the run's code with a retry;
  5. puts each job it gets first in the past imports.
  The sample and the report's error rows download as `data:` URLs the browser builds; no request.
