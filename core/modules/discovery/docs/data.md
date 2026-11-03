# discovery: data

One table, in `core/packages/db/prisma/schema/discovery.prisma`, created by the migration `20261022170000_discovery_import_jobs`. Ids are `job_<ULID>` (`ids.ts`); times are `timestamptz`.

| Table | Id | Columns | Keys | Scope |
|---|---|---|---|---|
| `import_jobs` | `job_` | `workspace_id`, `file_key`, `file_name`, `status` (`import_job_status`), `row_count`, `valid_count`, `error_count`, `report` (jsonb: `[{ row, code }]`, at most 100), `counts` (jsonb, the run's: `{ created, updated, skippedDuplicate, skippedErased, errors }`, with `startedAt` (when the run was asked for), `chunks` (the chunks committed) and, once it failed, `failure: { chunk, code }`), `created_by` (a user id), `created_at`, `finished_at` (the run's end) | index `(workspace_id, created_at)` | tenant |

There is no foreign key: the job's workspace is the request's, checked by the api host's guard.

**The file**: stored in the files port as `w/<workspace_id>/imports/<job id>.csv` (`file_key`), byte for byte as uploaded, with `text/csv; charset=utf-8`. Under `imports/` it lives 30 days at most (the port's lifecycle hint). It is personal data: profile URLs, names and companies of people the tester chose (provenance: the uploading member; PII class: business contact). The run copies its cells into contacts' persons only, through contacts' commands, with `import` and `csv` as their provenance; the job row keeps only record numbers, codes, counts and the file's name. Temporal's history of a run (`discovery.import_run:<workspace>:<job>`) holds the two ids, a code and the counts.
