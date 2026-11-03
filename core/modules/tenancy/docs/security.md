# tenancy: security

Read before changing the module ([security §8](../../../../docs/rules/security.md#8-conduct)); two reviews.

- **The three paths** (`domain/store.ts`), on the module's own `app` client and no other:
  - `memberships`, a tenant table, inside `withTenant` for one workspace, as the service principal `tenancy`: the tenant client adds `workspace_id` to every query;
  - `users`, `organizations` and `workspaces`, global tables, outside any run through `withoutTenant("tenancy")`, which logs the reason;
  - the one read of a tenant table across workspaces, `membershipsOfUser(userId)`: a user's own memberships, never a workspace's members. `listMemberships` and `resolveMembership` are built on it. It refuses an empty or missing user id, which Prisma would drop from the where, listing every membership. A second such read is a security change, reviewed as one.
- **Isolation**: `tests/tenancy.test.ts` registers `memberships` in the two-workspace harness.
- **Personal data**: `users.email` and `users.display_name`, the account holder's own. `users` is global, so the `/// pii` marking, which needs a tenant table, is not used (an Open question of alpha-p3-010). `GET /v1/me` answers them to their owner only; no log line carries them.
- **The feedback link**: `FEEDBACK_URL`, the operator's, reaches every signed-in user through `GET /v1/me` and every page's header. It must be `https:`, checked at start, so the link is never `javascript:`, `data:` or plain http; the web opens it in a new tab with `rel="noopener noreferrer"`, so the page it opens gets neither the app's window nor its address.
- **Who may do what**: `GET /v1/me` needs a session and returns the caller's own data. `workspace.read` is every role's; the roles are enforced from alpha-p3-030.
- **Input**: every command parses its input with Zod (`domain/rules.ts`); an error names the fields at fault, never a value. The email CHECK refuses an address not lowercased, whoever writes it.
