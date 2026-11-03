# identity: data

One table in `core/packages/db/prisma/schema/identity.prisma`, created by the migration `20261022100200_identity_invites`. The id is `inv_<ULID>` (`ids.ts`); the times are `timestamptz`.

| Table | Id | Columns | Keys | Scope |
|---|---|---|---|---|
| `invites` | `inv_` | `workspace_id`, `email`, `role` (`membership_role`, default `Owner`), `invited_by` (a user id; empty for `pnpm invite`), `created_at`, `accepted_at` | `(workspace_id, email)` unique; index on `email`; CHECK `invites_email_lowercase` | tenant |

No foreign key: `createInvite` checks the workspace, and the first sign-in's `addMember` checks it again.

Personal data: `invites.email`, marked `/// pii`: a person an engineer invited (provenance: the inviting engineer; PII class: business contact). Kept after it is accepted, as the record of who was let in. Nothing is deleted in alpha: revoking an invite and deleting a workspace are later tasks.
