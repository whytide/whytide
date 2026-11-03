# identity

Who may sign in, and who may enter a workspace. Access in alpha is invite-only: an engineer invites an email with `pnpm invite`, which makes the first organization on an empty database, and the first sign-in of that email makes its membership. For testing, `pnpm tenant:create` and `pnpm workspace:create` make more tenants, each with an Owner who may sign in at once. The api host reads two hooks from here: the workspace resolver, which its guard asks on every workspace route, and the authentication port's hooks. The sign-in screens and the account menu are here too ("Screens").

- **Owns:** `invites` in `core/packages/db/prisma/schema/identity.prisma` ([docs/data.md](docs/data.md)), `pnpm invite`, `pnpm tenant:create` and `pnpm workspace:create`.
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`, `providers` (the authentication port's `AuthHooks`, the app-mail port), `tenancy` (users, workspaces and memberships, through its commands); the screens on `ui`, `next`, `next-intl`, `react` and the web host's api client.
- **Reviewers:** the owners of this module; two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

## Public interface

| | |
|---|---|
| `workspaceResolver({ principal, workspace })` | the api host's resolver: the principal's membership of the workspace the URL names, by id or slug, as `{ workspaceId, membershipId, role }`, or `null`, which the host answers 403 `forbidden`; tenancy's `resolveMembership`, on every request, never cached |
| `authHooks` | `{ allowSignIn, mail, users: { findOrCreateByEmail, findByEmail, disable } }`, which the api host passes to the authentication port's `configure()` at start ("Sign-in") |
| `createInvite({ workspaceId, email })` | the invite, the email lowercased, the role `Owner`; `invite_exists` (409) when the workspace has one for the email, accepted or not; `workspace_not_found` (404); `identity_input_invalid` (400, `details.fields`) |

The registries: `ids` (`inv`), `errors` (`invite_required` 403, `invite_exists` 409, `identity_input_invalid` 400, each with its key in `messages/en.json`) and `permissions` (`identity.invite`, Owner, for the invite screen, later).

## Sign-in

- `allowSignIn(email)`: true for an email with an invite not accepted yet, in any workspace, or whose user has a membership; false otherwise, and false for a disabled user (`users.disabled_at` set), invited or not, which the port answers 403 `auth_invite_required`. It writes nothing.
- `users.findOrCreateByEmail(email)`, when a link is followed: the first sign-in creates the user (tenancy's `upsertUser`) and accepts each pending invite, oldest first: the membership with the invite's role (`addMember`), then `accepted_at`. A sign-in after that creates nothing. An email with neither an invite nor a user is `invite_required`. A disabled user comes back with its `disabledAt`, which the Better Auth adapter refuses, and accepts no invite.
- `users.findByEmail(email)`, `{ id, disabledAt }` or `null`, creating nothing: the adapter sends a disabled user no link. `users.disable(userId)`: tenancy's `disableUser`, for the port's `revokeUser`.
- `mail`: the app-mail port's instance (`PROVIDER_APP_MAIL`), made at the first mail.
- The flow: `/sign-in` posts the email to the api host's `POST /v1/sign-in` (core/apps/api/README.md "Sign-in"), which answers 202 to any email, then asks the port for the link; the screen goes on to `/sign-in/sent` either way. The mailed link opens `/sign-in/confirm` (its GET spends nothing, so a mail scanner signs no one in), whose button POSTs the link and lands on `next`, or on `/`, the first workspace. A failed link lands on `/sign-in/expired`.

## Screens

`ui/nav.ts` declares no navigation entry: four public pages, `/sign-in`, `/sign-in/sent`, `/sign-in/expired` and `/sign-in/confirm`, and the account menu in the shell's `sign-out` slot, the member's email, the theme (`ThemeToggle` of `@whytide/ui`) and Sign out (`POST /v1/sign-out`, which ends every session of the user), then `/sign-in`. The pages are `PublicPage`s of `@whytide/ui`, the sign-in page with the brand's panel. The text is `identity.sign_in.*` and `identity.account.*`.

## The invite command

`pnpm invite <email> [--workspace <id or slug>]`, from the repository root, builds the module and invites the email to the workspace, tenancy's `WORKSPACE_SLUG` by default. It prints one line that starts with a code:
- `organization_created` first, on a database with no organization and no `--workspace`: tenancy's `bootstrapOrganization` with `ORGANIZATION_NAME` and `WORKSPACE_SLUG`, the email's user its Owner; the invite follows.
- `invite_created`, with the workspace's id and the sign-in page, `APP_PUBLIC_ORIGIN` followed by `/sign-in` (the path alone when it is empty): never a link that signs in. Exit 0.
- `invite_exists`: the email is invited already; exit 0, so a second run is harmless.
- `workspace_not_found` when no workspace has the slug, or workspaces of two organizations do (pass the id then); another refusal prints its code. Exit 1.
- The usage, for a missing or bad email or an unknown option. Exit 2; through pnpm, 1.

It runs as `app`, in a run of the workspace as the service principal `identity`; `invited_by` stays empty.

## The tenant commands

Two commands make a tenant for testing, from the repository root, each building the module first. The admin becomes the new workspace's Owner, and that membership lets them sign in: no invite is made.

- `pnpm tenant:create --name <organization name> --slug <slug> --admin-email <email> [--admin-name <name>] [--no-mail]`: an organization and its default workspace, both with the name and the slug (tenancy's `bootstrapOrganization`, whose event gives the organization its credits). First line: `organization_created: <name>, workspace <slug> (<id>), Owner <email>`. A slug an organization has is `organization_exists`, before any user is made.
- `pnpm workspace:create --org <organization slug or id> --name <workspace name> --slug <slug> --admin-email <email> [--admin-name <name>] [--no-mail]`: another workspace of the organization (tenancy's `createWorkspace`), which spends the organization's credits; an id has an underscore, a slug none. First line: `workspace_created: <organization name>, workspace <slug> (<id>), Owner <email>`. The refusals: `organization_not_found`, `workspace_exists`.
- Both: the admin's user is made when there is none, `--admin-name` its display name; a disabled user is `user_disabled`, before anything is made. Then one mail to the admin through the app-mail port, `identity.mail.admin_added`: the workspace, the organization, the sign-in page and the address to sign in with, never a link that signs in. The line is `mail_sent: <email>`, or `mail_skipped` with `--no-mail` or while `APP_PUBLIC_ORIGIN` is empty, a path alone being no use in a mail. The last line is `sign_in_page: <APP_PUBLIC_ORIGIN>/sign-in`.
- Exit 0 made; 1 refused, with the code and the slug, the email or the fields at fault; 2 the usage, for a missing option, a bad email or an unknown option; 3 the mail failed, its code printed, everything else made. Through pnpm, any failure is 1.

## The smoke test

`pnpm smoke` runs the api's health check, then each module's `smoke` script, identity's first: `pnpm -F identity smoke` (`tests/smoke.ts`) against `API_PUBLIC_URL` or `127.0.0.1:API_PORT`: it invites `SMOKE_EMAIL` (the `modules/identity` block of `deploy/.env.example`, `smoke@example.test` by default) as `pnpm invite` does, asks for a link, reads it from Mailpit (`MAILPIT_API_URL`), follows it as the confirm page does, and expects an Owner membership in `GET /v1/me`. It exits 1 with the step that failed, and stops at once on a database with no organization: the first `pnpm invite`, never the smoke test, makes it and its Owner. Another module's step joins by defining a `smoke` script; `smokeSignIn` from `@whytide/identity/testing` gives it a session, `{ cookie, slug }`.

## Testing

`@whytide/identity/testing`: `useIdentityClient(asRole("app"))`, in a test file that calls `withTestDb()` first, runs this module's commands in the file's schema; tenancy's factories make the workspaces. `smokeSignIn(api, email, print)` is the smoke step, which the api's `tests/smoke.test.ts` runs against an api it starts. `tests/sign-in.spec.ts` holds the flows through the screens, which `pnpm -F web test` runs; the sign-in routes' own tests are the api's `tests/sign-in.test.ts`. `pnpm -F @whytide/identity test` runs the module's tests, `test:tenancy` the isolation test of `invites`. The guard and the first sign-in, end to end, are the api host's tests, `core/apps/api/tests/guard.test.ts`: a module never imports a host.

## Decided here

- An email is trimmed, lowercased and 254 characters at most (`domain/rules.ts`), as tenancy's `users` and the authentication port keep it; the CHECK `invites_email_lowercase` refuses any other writer.
- The module keeps one `app` client of its own, made at first use, on two paths only ([docs/security.md](docs/security.md)). With no NestJS module here, the api does not close it at shutdown: its idle connections end with the pool's timeout.
- No foreign key from `invites` to `workspaces` or `users`: `createInvite` checks the workspace, and `addMember` checks it again at the first sign-in.
- The membership is made before the invite is marked accepted: a failure between the two leaves the invite pending, and the next sign-in finishes it.
- `--workspace <slug>` is resolved by tenancy's `findWorkspaceBySlug`: a slug is unique within an organization only.
- The first organization comes from `pnpm invite`, not from the first sign-in (decisions.md): with no organization, `allowSignIn` would refuse everyone. Its first email is the Owner at once; later emails become Owners when their invite is accepted.
- The confirm step: a link's GET answers the confirm page and spends nothing; only the page's POST, from the app's own origin, signs in, on both adapters (core/packages/providers/auth/README.md).
- The sign-out key is `identity.account.sign_out`: `identity.sign_out` has two segments, which the key convention refuses.
- The tenant commands: `user_disabled` is a line, not a registered code, since nothing throws it; the mail is rendered in `defaultLocale()`, as the sign-in mail is; an `--org` that is neither an id nor a slug is `organization_not_found`.
