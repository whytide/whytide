# identity: data

One table in `core/packages/db/prisma/schema/identity.prisma`, created by the migration `20261022100200_identity_invites`; `20261112103823_identity_invite_expiry` adds the expiry, the revoke and the mail. The id is `inv_<ULID>` (`ids.ts`); the times are `timestamptz`.

| Table | Id | Columns | Keys | Scope |
|---|---|---|---|---|
| `invites` | `inv_` | `workspace_id`, `email`, `role` (`membership_role`, default `Owner`), `invited_by` (a user id; empty for `pnpm invite`), `created_at`, `expires_at` (`IDENTITY_INVITE_TTL_DAYS` days on, 7 unset), `accepted_at`, `revoked_at`, `revoked_by`, `mailed_at` | `(workspace_id, email)` unique; index on `email`; CHECKs `invites_email_lowercase`, `invites_revoked_together` (both revoke columns or neither), `invites_accepted_or_revoked` (never both) | tenant |

No foreign key: `createInvite` checks the workspace, and the first sign-in's `addMember` checks it again.

Personal data: `invites.email`, marked `/// pii`: a person an engineer invited (provenance: the inviting engineer; PII class: business contact). Kept after it is accepted or revoked, as the record of who was let in; a renewal writes over the same row. Nothing is deleted: deleting a workspace is a later task.
