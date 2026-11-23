# privacy: data

`erasure_log` (`core/packages/db/prisma/schema/privacy.prisma`, migrations `20261027140000_privacy_erasure_log`, `20261101124448_privacy_erasure_reason` and `20261104101759_privacy_lead_deleted`), a tenant table, `era_` ids:

| Column | |
|---|---|
| `id` | `era_…` |
| `workspace_id` | the workspace the person was erased from |
| `person_hash` | the erased hash of the person's normalized URL, else of their first email address for a person without a LinkedIn profile (gamma-rf-050), as contacts' `person_hashes` keeps it: pseudonymous (PII class personal, provenance: the request); null for a deletion of the 30-day rule or of a lead, which keep no hash |
| `reason` | enum `erasure_reason`: `request`, a request run through `pnpm erase` (the default), `retention_never_contacted`, the 30-day rule's job (README.md "The 30-day rule"), or `lead_deleted`, `pnpm lead:delete` (README.md "Deleting a lead") |
| `requested_at` | when the command started |
| `completed_at` | when the erasers had all run, just before the commit |
| `counts` | jsonb, the rows deleted by module and table: `{ "signals": { "signal_events": 2, "evidence": 2 }, … }` |
| `performed_by` | the operator, from `--operator`; `retention` for the job |

Index `(workspace_id, completed_at)`. No foreign key. No name, URL, person id or text of the person: the scan of `tests/erase.test.ts` proves it. The CHECK `erasure_log_reason_hash`, written by hand in the migration, ties the hash to the reason: a `request` row has one, a `retention_never_contacted` or `lead_deleted` row has none (`tests/tenancy.test.ts`). The third migration adds the value `lead_deleted` alone, expand only: the CHECK already holds for it.

Append-only: the migration revokes `UPDATE` and `DELETE` from `app`, so a row is never changed or removed by the api or the worker (`tests/tenancy.test.ts`); the second migration keeps those grants. Retention: kept, with no expiry in alpha; it is the record that the request was met, or that the 30-day rule or `pnpm lead:delete` deleted someone: the job's rows name no one, and are read by their workspace, time and counts (docs/runbook.md "The 30-day rule").
