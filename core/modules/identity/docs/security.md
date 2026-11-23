# identity: security

Read before changing the module ([security §8](../../../../docs/rules/security.md#8-conduct)); two reviews.

- **The guard**: a module's workspace route runs only after the api host's workspace guard has asked `workspaceResolver` for the caller's membership of the URL's workspace, on every request, never from a cache; a membership of workspace A gives nothing on B. The host stops its start on a controller outside its mounts, and only its own routes skip the session (core/apps/api/README.md "Modules").
- **The two paths** (`domain/store.ts`), on the module's own `app` client and no other:
  - `invites`, a tenant table, inside `withTenant` for one workspace, as the service principal `identity`;
  - the one read of invites across workspaces, `pendingInvitesOf(email)`: an email's own open invites, never a workspace's list, for `allowSignIn`, the first sign-in and `/v1/invitations`, the expiry and the revoke filtered in its query; listed in core/packages/db README "Limits". It checks the email first: Prisma drops an undefined value from a where, which would list every pending invite. A second such read is a security change, reviewed as one.
- **Users, workspaces and memberships** are tenancy's, read and written through its commands only.
- **Isolation**: `tests/tenancy.test.ts` registers `invites` in the two-workspace harness.
- **Invite-only**: `allowSignIn` is true only for an invited email or a member's, and writes nothing, so a refused email leaves no user row. The api's `POST /v1/sign-in` answers both alike in status, body and time, asking for the link after the answer, and `/sign-in/sent` is one page for both; it is rate-limited per address and per email.
- **Mail scanners and login CSRF**: a link's GET signs no one in; the confirm page's POST does, and only from the app's own origin. `/sign-in/confirm` takes a `link` under `/api/auth/` only.
- **Personal data**: `invites.email`, `/// pii`. No log line carries it; `pnpm invite` prints it back to the engineer who typed it.
- **Who may do what**: `pnpm invite` is an engineer's, with access to the database; `identity.invite` (Owner) guards the invites' routes. The command prints the sign-in page, never a link that signs in.
- **The tenant commands**: `pnpm tenant:create` and `pnpm workspace:create` are an engineer's too. They refuse a disabled user before anything is made, and mail the admin once, after the rows are committed, through the app-mail port: the names, the sign-in page and the address, never a link that signs in or a token. The email is printed back to the engineer, never logged.
- **Input**: every email is parsed with Zod (`domain/rules.ts`); an error names the field, never the value. The CHECK refuses an email not lowercased, whoever writes it.
- **Accepting**: only a session of the invite's own address accepts it, at its first sign-in or on `/invitations`, and only while it is open: the mail carries no token, and a forwarded mail lets no one else in. Another user's invite id is `invite_not_found`, as an unknown one. The invite mail's names are cut to one line, so an inviter's name cannot add lines to it.
