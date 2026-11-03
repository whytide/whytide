# tenancy

Who a user is and where they belong: users, organizations, workspaces and memberships ([architecture §7.2](../../../docs/architecture.md#72-tenancy-identity-and-credits)). The full schema exists; Core uses one organization with one workspace, and identity's tenant commands add more for testing. `GET /v1/me` tells a signed-in user who they are and where they belong, and module tests make their workspaces with this module's factories.

- **Owns:** `users`, `organizations`, `workspaces` and `memberships` in `core/packages/db/prisma/schema/tenancy.prisma` ([docs/data.md](docs/data.md)), and `GET /v1/me`.
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`; `@nestjs/common` in `api/` only.
- **Reviewers:** the owners of this module; two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

## Public interface

| | |
|---|---|
| `upsertUser({ email, displayName? })` | the user with the email, lowercased, created when there is none; `displayName`, when given, is set either way. Two calls at once make one user: a write a unique index refuses (P2002) runs once more and finds the row |
| `findUser(userId)`, `findUserByEmail(email)` | the user, or `null`; the email lowercased and checked as `upsertUser` does; nothing is created (identity's `allowSignIn`) |
| `disableUser(userId)` | the user with `disabled_at` set, once (a second call keeps the first time); `user_not_found` (404). identity's users hook calls it for the authentication port's `revokeUser` |
| `findWorkspace(workspaceId)` | the workspace with its `organizationId`, or `null` (credits) |
| `findOrganization(organizationId)` | the organization, or `null` (signals reads its name, alpha-p8-030) |
| `findOrganizationBySlug(slug)` | the organization with the slug, or `null` (identity's `pnpm tenant:create` and `pnpm workspace:create`) |
| `findWorkspaceBySlug(slug)` | the one workspace with the slug, or `null` when none has it or two organizations' workspaces do (identity's `pnpm invite`) |
| `hasOrganization()` | whether any organization exists: identity's `pnpm invite` bootstraps the first one when none does |
| `listWorkspaceIds()` | every workspace's id, by id, and nothing else: the fan-out of global work to one run per workspace (linkedin's hourly status refresh) |
| `bootstrapOrganization({ name, workspaceSlug, ownerUserId })` | an organization and its workspace, both named `name` and slugged `workspaceSlug`, and the owner's Owner membership, in one transaction, which also writes the event `tenancy.organization_created` (`organizationId`, `workspaceId`; credits subscribes); `organization_exists` (409) when the slug is taken, `user_not_found` (404) |
| `createWorkspace({ organizationId, name, slug, ownerUserId })` | `{ workspace, membership }`: another workspace of the organization and the owner's Owner membership, in one transaction, a run in the new workspace. No event: credits are the organization's, so the workspace spends its balance. `workspace_exists` (409) when the organization has a workspace with the slug, also when another call wins the race, and nothing is written; `organization_not_found`, `user_not_found` (404) |
| `addMember({ userId, workspaceId, role })` | the user's membership of the workspace with the role, kept as it is, role included, when there is one; two calls at once make one, as `upsertUser`; `workspace_not_found`, `user_not_found` (404) |
| `addOwner({ userId, workspaceId })` | `addMember` with the role `Owner` |
| `listMemberships(userId)` | the user's memberships, oldest first, each with its workspace and organization |
| `resolveMembership({ userId, workspaceIdOrSlug })` | the user's membership of the workspace a URL names, by id or slug, or `null` |

An input off the rules, an empty or missing id included, is `tenancy_input_invalid` (400, `details.fields`). The registries: `ids` (`usr`, `org`, `wsp`, `mem`), `errors`, `permissions` (`workspace.read`, every role) and `settings`. `accountApi` is the NestJS module the api host mounts under `/v1` (core/apps/api README "Modules").

## GET /v1/me

Any signed-in principal, outside the workspaces: 200 `{ user: { id, email, displayName, locale }, memberships: [{ workspaceId, slug, name, organizationName, role }], feedbackUrl }`, `feedbackUrl` being `FEEDBACK_URL` ("Settings") or `null`; 401 `auth_session_invalid` without a session; 404 `user_not_found` when the session's user has no row. The schema is `schemas/me.ts`, which the handler's `whytide:api-route` metadata gives the api's OpenAPI document; the request is in `api-calls/alpha-p3-010-tenancy-tables.http`.

## Settings

The `modules/tenancy` block of `deploy/.env.example`, read by identity's `pnpm invite` on a database with no organization yet: `ORGANIZATION_NAME` (default `My organization`) and `WORKSPACE_SLUG` (default `main`, a slug).

`FEEDBACK_URL`, optional: where testers give feedback, an `https:` URL, kept normalized. `GET /v1/me` answers it as `feedbackUrl`, and the web host's header shows it on every workspace page as "Give feedback" (`tenancy.feedback.link`), opened in a new tab with `rel="noopener noreferrer"` (`core/apps/web/src/shell/feedback-link.tsx`); unset or empty, no link. Any other value stops the api's start with `config_invalid`, `details.variables` naming it, never its value.

## Testing

`@whytide/tenancy/testing`, in a test file that calls `withTestDb()` first; rows are written as `app` in the file's schema:
- `createUser()`, `createOrganizationWithWorkspace({ workspaceId? })`, `createMembership({ userId, workspaceId, role? })`;
- `createTwoWorkspaces()`: two organizations with a workspace and an Owner each, in one batch, under 50 ms;
- `useTenancyClient(asRole("app"))`: this module's commands then run in the file's schema too.

`pnpm -F @whytide/tenancy test` runs the module's tests, `test:tenancy` the isolation test of `memberships`. `GET /v1/me`'s end-to-end test is the api host's, `core/apps/api/tests/me.test.ts`: a module never imports a host.

## Decided here

- A slug is 2 to 40 lowercase letters, digits and single dashes, starting with a letter, so it never reads as an id. The organization takes its first workspace's slug.
- The module keeps one `app` client of its own, made at first use and closed with the api, on three paths only ([docs/security.md](docs/security.md)); the one read across workspaces is a user's own memberships.
- `users.email` is lowercased by `upsertUser` and by the CHECK `users_email_lowercase`.
- The feedback link (alpha-p10-040): `https:` only, and the key `tenancy.feedback.link`, since the message-key check wants `module.screen.purpose`, which `tenancy.feedback` is not.
