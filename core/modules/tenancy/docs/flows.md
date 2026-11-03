# tenancy: flows

- **GET /v1/me**: the api host's principal guard reads the session and leaves the principal on the request; the controller reads the user (`users`, global), then `listMemberships`: the user's memberships across workspaces, then their workspaces and organizations (global), joined in code. No tenant run, no permission.
- **The first sign-in** (alpha-p3-040): `upsertUser`, then `bootstrapOrganization` with the settings; the three rows in one run in the new workspace, with the event `tenancy.organization_created` in the outbox, from which credits grants the organization its first period.
- **Another workspace** (identity's `pnpm workspace:create`): `createWorkspace` checks the organization, the user and the slug, then writes the workspace and the Owner membership in one run in the new workspace. No event: the organization's credits exist already.
- **A workspace URL** (alpha-p3-030): the workspace resolver calls `resolveMembership({ userId, workspaceIdOrSlug })` on every request.
