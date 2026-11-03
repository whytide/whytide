# privacy: data

`erasure_log` (`core/packages/db/prisma/schema/privacy.prisma`, migration `20261027140000_privacy_erasure_log`), a tenant table, `era_` ids:

| Column | |
|---|---|
| `id` | `era_…` |
| `workspace_id` | the workspace the person was erased from |
| `person_hash` | the erased hash of the person's normalized URL, as contacts' `person_hashes` keeps it: pseudonymous (PII class personal, provenance: the request) |
| `requested_at` | when the command started |
| `completed_at` | when the erasers had all run, just before the commit |
| `counts` | jsonb, the rows deleted by module and table: `{ "signals": { "signal_events": 2, "evidence": 2 }, … }` |
| `performed_by` | the operator, from `--operator` |

Index `(workspace_id, completed_at)`. No foreign key. No name, URL, person id or text of the person: the scan of `tests/erase.test.ts` proves it.

Append-only: the migration revokes `UPDATE` and `DELETE` from `app`, so a row is never changed or removed by the api or the worker (`tests/tenancy.test.ts`). Retention: kept, with no expiry in alpha; it is the record that the request was met.
