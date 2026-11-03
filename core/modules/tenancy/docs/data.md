# tenancy: data

Four tables in `core/packages/db/prisma/schema/tenancy.prisma`, created by the migration `20261022100100_tenancy_initial`. Every id is `<prefix>_<ULID>` (`ids.ts`); every `created_at` is a `timestamptz`.

| Table | Id | Columns | Keys | Scope |
|---|---|---|---|---|
| `users` | `usr_` | `email`, `display_name`, `locale`, `created_at`, `disabled_at` | `email` unique; CHECK `users_email_lowercase` | global |
| `organizations` | `org_` | `name`, `slug`, `created_at` | `slug` unique | global |
| `workspaces` | `wsp_` | `organization_id`, `name`, `slug`, `created_at` | `(organization_id, slug)` unique | global |
| `memberships` | `mem_` | `workspace_id`, `user_id`, `role`, `created_at` | `(workspace_id, user_id)` unique; index on `user_id` | tenant |

`role` is the enum `membership_role` (`Owner`, `Admin`, `Member`). Foreign keys: `workspaces.organization_id`, `memberships.workspace_id` and `memberships.user_id`.

Personal data: `users.email` and `users.display_name`, the account holder's own, given at sign-in (provenance: the user; PII class: business contact). Kept while the account exists; nothing here is a lead's. Nothing is deleted in alpha: the deletion of a user or a workspace is a later task.
