# icp: data

Two tenant tables in `core/packages/db/prisma/schema/icp.prisma`, created by the migration `20261022151000_icp_initial`; `20261029021500_icp_draft` adds the draft's columns. The ids are `icp_<ULID>` and `crit_<ULID>`, a draft's run `idrun_<ULID>` (`ids.ts`); the time is `timestamptz`.

| Table | Id | Columns | Keys | Scope |
|---|---|---|---|---|
| `icps` | `icp_` | `workspace_id`, `name`, `titles`, `seniorities`, `industries`, `size_ranges` and `countries` (text arrays), `must_haves`, `disqualifiers`, `version` (from 1), `updated_at`; the draft's: `draft_status` (`none`, `drafting`, `drafted`, `failed`), `draft_error` (a code), `draft_run_id`, `draft_brief` (the brief, empty when none), `pending_draft` (JSON: the proposed fields, the model, the prompt version, the decision record's id) | `(workspace_id)` unique | tenant |
| `criteria` | `crit_` | `workspace_id`, `icp_id` (references `icps`, deleted with it), `key`, `weight`, `is_must`, `enabled` | `(workspace_id, icp_id, key)` unique | tenant |

No foreign key to `workspaces`: Prisma would need the opposite relation in `tenancy.prisma`. The closed lists and the limits are checked by the commands, the only writer, not by the database.

Personal data: none; the ICP describes a market, not a person, and the brief what the admin sells to. The draft's columns are overwritten by the next request; the decision record keeps the call (core/packages/ai). Retention: configuration, kept with the workspace; nothing is deleted in alpha.
