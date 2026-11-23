# tenancy

Who a user is and where they belong: users, organizations, workspaces and memberships ([architecture §7.2](../../../docs/architecture.md#72-tenancy-identity-and-credits)). The full schema exists; Core uses one organization with one workspace, and identity's tenant commands add more for testing. `GET /v1/me` tells a signed-in user who they are and where they belong, and module tests make their workspaces with this module's factories. An Owner manages the workspace's members on the Members screen: their role, Owner or Member, and their removal ("Members").

- **Owns:** `users`, `organizations`, `workspaces` and `memberships` in `core/packages/db/prisma/schema/tenancy.prisma` ([docs/data.md](docs/data.md)), `GET /v1/me`, the members routes and the Members screen.
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`; `@nestjs/common` in `api/` only; `@whytide/ui`, `next-intl` and React in `ui/` only.
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
| `addMember({ userId, workspaceId, role })` | the user's membership of the workspace with the role: an active one is kept as it is, role included; a removed one is made active again with the role given, `removed_at` and `removed_by` cleared (identity's invites reach a removed member through it); two calls at once make one, as `upsertUser`; `workspace_not_found`, `user_not_found` (404) |
| `addOwner({ userId, workspaceId })` | `addMember` with the role `Owner` |
| `listMemberships(userId)` | the user's active memberships, oldest first, each with its workspace and organization; a removed one is not listed |
| `resolveMembership({ userId, workspaceIdOrSlug })` | the user's active membership of the workspace a URL names, by id or slug, or `null`: a removed member is refused as a stranger is |
| `workspaceOwner(workspaceId)` | the user of the workspace's oldest active `Owner` membership, or `null`; an `Admin` or a `Member` never answers. Read in the caller's tenant run for the workspace, as the four commands below, which open no run of their own (campaigns' seeded campaign, gamma-p3-030) |
| `listMembers()` | the run's workspace's active members, `{ membershipId, userId, email, displayName, role, joinedAt }`: Owners first, then by name (the display name, else the email; case and accents aside), then by id |
| `changeRole({ membershipId, role, changedBy })` | another member's role, `Owner` or `Member`, answered as a member; anything else, `Admin` included, is `tenancy_input_invalid` (`details.fields: ["role"]`); the same role answers it unchanged, nothing written. Refusals: `membership_not_found`, `member_is_self`, `last_owner` ("Members") |
| `removeMember({ membershipId, removedBy })` | the membership with `removed_at` and `removed_by` set, and `tenancy.member_removed` in the outbox, in the same run; a removed one is answered unchanged, with no second event. Refusals: `membership_not_found`, `member_is_self`, `last_owner` |
| `findActiveMembership(userId)` | the user's active membership of the run's workspace, or `null`: a removed member's and another workspace's are `null` (campaigns' gate asks before every send, gamma-p6-040) |
| `sharingGroupOf()` | the sharing group of the run's workspace, or `null` for a workspace tenancy does not have: the organization's id today, the group whose workspaces share what contacts' company index learns (gamma-rf-010). Read in the caller's tenant run from the run's own workspace, so no caller names the workspace or the group; it opens no run of its own |

An input off the rules, an empty or missing id included, is `tenancy_input_invalid` (400, `details.fields`). The registries: `ids` (`usr`, `org`, `wsp`, `mem`), `errors`, `events` (`tenancy.organization_created`, `tenancy.member_removed`), `permissions` (`workspace.read`, every role; `members.manage`, Owner) and `settings`. `accountApi` is the NestJS module the api host mounts under `/v1` (core/apps/api README "Modules"), and `api` the members routes, which it mounts under `/v1/workspaces/:workspaceId/tenancy`.

## GET /v1/me

Any signed-in principal, outside the workspaces: 200 `{ user: { id, email, displayName, locale }, memberships: [{ workspaceId, slug, name, organizationName, role }], feedbackUrl }`, `feedbackUrl` being `FEEDBACK_URL` ("Settings") or `null`; 401 `auth_session_invalid` without a session; 404 `user_not_found` when the session's user has no row. The schema is `schemas/me.ts`, which the handler's `whytide:api-route` metadata gives the api's OpenAPI document; the request is in `api-calls/alpha-p3-010-tenancy-tables.http`.

## Members

An Owner sees the workspace's members, changes a member's role between Owner and Member and removes a member (gamma-p6-030). The routes, under `/v1/workspaces/{workspaceId}/tenancy` (`api/members.controller.ts`; the schemas in `schemas/members.ts`; the requests in `api-calls/gamma-p6-030-members-and-roles.http`):
- `GET /members` (`workspace.read`): `{ members: [{ membershipId, userId, email, displayName, role, joinedAt, isSelf }] }`, in `listMembers`' order, `isSelf` on the caller's own row.
- `PATCH /members/{membershipId}` `{ role }`, strict (`members.manage`): 200 with the member; a role other than `Owner` or `Member` is 400 `validation_failed` naming `role`.
- `DELETE /members/{membershipId}` (`members.manage`): 204, and 204 again for a removed one.

The refusals, in this order: `membership_not_found` (404) for an id the workspace does not hold, or a removed one in a role change; `member_is_self` (409) when the caller changes their own role or removes themselves; `last_owner` (409) when the change would leave the workspace with no active Owner. The last check locks the target and the workspace's active Owner rows (`SELECT … FOR UPDATE`, in id order) before it counts them, so two Owners demoting each other at once leave one Owner: the second waits for the first's commit, then reads the rows as it left them.

A removed membership keeps its row, with `removed_at` and `removed_by`, so the ids other tables hold stay valid, and every read of memberships skips it: the member's next request to the workspace finds no membership and identity's resolver refuses it (403), `GET /v1/me` no longer lists the workspace, their other workspaces still answer, and a user with no membership left gets no sign-in link until invited again. The role is read on every request too, so a role change holds from the member's next request, with no cache to clear. The event `tenancy.member_removed` `{ workspaceId, membershipId, userId }`, ids only, is written once, in the removal's transaction. Its subscribers come in other tasks: linkedin pauses the member's account (gamma-p6-070), campaigns ends the enrollments that send from it (gamma-p6-040), email disconnects the member's mailbox and playbooks pauses their agents (gamma-p6-075).

The screen "Members", `/w/{workspace}/members`, in the Company group after the company page (`ui/nav.ts`, `ui/members/`): each member's name, email and role, "You" on the caller's row. An Owner has a role menu and Remove on every other row; Remove asks for confirmation and says that the member's LinkedIn account is paused, their mailbox disconnected, their agents paused and their campaigns stopped; a refusal, `last_owner` or `member_is_self` among them, shows in words above the list; a link leads to identity's Invites, `/w/{workspace}/invites` (gamma-p6-020). A Member reads the list only. Loading, empty and error states with a retry.

Tests: the commands in `tests/members.test.ts`, two concurrent demotions on two connections among them; the routes end to end in the api host's `core/apps/api/tests/tenancy-members.test.ts`; the screen in `core/apps/web/tests/tenancy-members.spec.ts`, on members the e2e api seeds (`POST …/e2e/members`).

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
- The module keeps one `app` client of its own, made at first use and closed with the api, on four paths only ([docs/security.md](docs/security.md)), the fourth the caller's own run (`workspaceOwner`, the members commands and `sharingGroupOf`); the one read across workspaces is a user's own memberships.
- `users.email` is lowercased by `upsertUser` and by the CHECK `users_email_lowercase`.
- The feedback link (alpha-p10-040): `https:` only, and the key `tenancy.feedback.link`, since the message-key check wants `module.screen.purpose`, which `tenancy.feedback` is not.
- Removing a member is a soft delete (gamma-p6-030): the row stays, with `removed_at` and `removed_by`, both set or neither (the CHECK `memberships_removed_together`), so campaigns', approvals', inbox's and linkedin's rows keep valid ids; `addMember` makes it active again. The data model's status enum is reduced to these two columns.
- `member_is_self`: no one changes their own role or removes themselves, so an Owner never locks themselves out by mistake; another Owner does it.
- `last_owner`, counted under a lock on the active Owner rows: a workspace always keeps an active Owner, under concurrency too.
- The route takes `Owner` or `Member` only: `Admin` is the host's `validation_failed` there and `tenancy_input_invalid` in `changeRole`. Names order with the `en` collation (`domain/constants.ts`), the same on every server.
