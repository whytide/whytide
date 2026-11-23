# playbooks: data

Both tables are tenant tables (`workspace_id` on every row), made in migration `20261105085424_playbooks_initial`. Neither holds personal data, so no eraser needs them; nothing deletes an agent's row.

- **`playbooks`** (`pbk_`): `name` (1 to 80 characters, trimmed), `icp_id` (icp's audience, a plain id, no foreign key), `owner_user_id`, `status` (enum `playbook_status`: `active`, `paused`, `archived`), `paused_reason` (enum `playbook_paused_reason`: `user`, `member_removed`; migration `20261113024829_playbooks_paused_reason`, gamma-p6-075), `created_by`, `created_at`, `updated_at`, `archived_at`.
  - `playbooks_live_icp`: unique `(workspace_id, icp_id) WHERE status <> 'archived'`, one live agent per audience; hand-written SQL, as Prisma's schema cannot say a partial key.
  - CHECK `playbooks_archived_at`: `archived_at` is set exactly when `status = 'archived'`.
  - CHECK `playbooks_paused_reason`: `paused_reason` is set exactly while `status = 'paused'`; the migration gave the rows paused before it `user`. `user` is a member's pause through the PATCH, `member_removed` the owner's removal, which only the owner, a member again, lifts.
  - Index `(workspace_id, status)`; unique `(workspace_id, id)`, the target of the sources' foreign key.
- **`playbook_sources`** (`pbs_`): `playbook_id`, `source_id` (signals' source, a plain id), `created_at`.
  - Unique `(workspace_id, source_id)`: a source on one agent at a time.
  - Foreign key `(workspace_id, playbook_id)` to `playbooks (workspace_id, id)`, ON DELETE RESTRICT: a link never points at another workspace's agent.
  - Archiving an agent deletes its links; signals' `detachSource` deletes a deleted source's.

No grant of their own: `app` reads and writes both through the roles migration's default privileges.
