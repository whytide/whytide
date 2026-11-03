# Screens

A screen is a folder under a module's own `ui/`; the web host mounts it under `/w/<workspace>/` and lists it in the navigation. The host holds no screen of its own.

## Adding a screen

1. `ui/nav.ts` exports the module's entries:
   ```ts
   export const nav = [{ group: "leads", labelKey: "contacts.nav.list", segment: "contacts", screen: "list", order: 10, icon: "Users" }];
   ```
   `group` is one of `company`, `icp`, `sources`, `import`, `leads`, `linkedin`, the tester's day in order (`src/shell/nav.ts`); `labelKey` a key of the module's `messages/en.json`; `segment` the address after the workspace, lower-case letters, digits and hyphens, unique across modules; `screen` the folder under `ui/`; `order` sorts the entries of a group; `icon`, optional, names a Lucide icon of `@whytide/ui/icons` (`CircleDot` without), and a name that is not one fails the web's typecheck and build.
2. `ui/<screen>/page.tsx` default-exports the page, with `params: Promise<{ workspace: string }>` and `searchParams` as Next.js passes them.
3. The module's `package.json` lists what its screens import, at the web's versions: `@whytide/ui` (`workspace:*`), `next-intl`, `react` and `@types/react` (and `next` for `next/navigation`, with `react-dom`, its peer). pnpm links a package only into the folders that list it, and the web compiles the screen from the module's folder. It does not list `@whytide/web`: the web depends on the api, so a module listing the web closes a cycle with the api that `pnpm -r` refuses. The web resolves `@whytide/web/api/*` for the screens itself (`next.config.ts` and `tsconfig.json`). The api does not list a module with a screen either: its tests load the module's `dist/index.js` by path, as `src/modules.generated.ts` does. identity and contacts stay in the api's devDependencies, as the api's tests import their hooks, commands and test helpers by name, never a screen, and neither depends on the web; credits does, through qualification and icp (`ERR_PNPM_TASK_CYCLE`), so its tests load it by path too.
4. `pnpm web:routes` writes the route (`dev` and `build` run it); `/w/<workspace>/<segment>` renders the screen in the shell.

A page outside the workspaces, which needs no session (identity's `/sign-in`), is a `publicPages` entry of `ui/nav.ts`, `{ path: "sign-in/sent", screen: "sent" }`, mounted at `/<path>` from `ui/<screen>/page.tsx`, with no navigation entry; no path under `/w`, `/api` or `/dev`. A component of the shell's header is a `slots` entry, `{ slot: "sign-out", screen: "account" }`: `ui/<screen>/slot.tsx` default-exports it, and the shell renders it with `SlotProps`, the member's `email` and the `workspaceId`.

A page of the workspace outside the navigation is a `pages` entry, `{ path: "leads/[personId]", screen: "lead" }`, mounted at `/w/<workspace>/<path>` from `ui/<screen>/page.tsx`; a `[name]` segment is a parameter of `params`. A page with slots lists their names in `ui/<screen>/slots.ts` (`export const slots = [...]`) and takes `panels`, by slot. Another module puts a component in one with a `panels` entry, `{ page: "contacts.lead", slot: "evidence", screen: "evidence" }`, the page named `<module>.<screen>`: `ui/<screen>/panel.tsx` default-exports a server component, which the page renders with its own props (contacts' `PanelProps`, `{ workspace, personId }`). `pnpm web:routes` fails on a slot the page does not list.

## Server and client components

The shell and each screen's `page.tsx` are server components: they read the api with `serverApi()` and the text with `getTranslations`. Lists and forms are client components (`"use client"`, a file beside the page): `DataTable`, `Dialog` and the form components take functions, which a server component cannot pass; they call the api with `browserApi()` and take the text with `useTranslations`.

## The API

```ts
import { data, serverApi } from "@whytide/web/api/server";

const answer = await data((await serverApi()).GET("/v1/workspaces/{workspaceId}/contacts", { params: { path: { workspaceId } } }));
```

`serverApi()` calls `NEXT_PUBLIC_API_URL` with the browser's `cookie` and `Origin`; `browserApi()` from `@whytide/web/api/browser` calls `/api/v1/*` from the browser. Both are the generated client (README "The API client"). `data()` returns the answer's data or throws an `ApiError`. These two entries are the only part of the host a module's `ui/` may import (the lint's `module-boundaries`).

## Errors, not found, loading

A screen that throws, an `ApiError` included, renders `app/w/[workspace]/(modules)/error.tsx`: `web.error.title` and `ErrorState` with the code in words and a retry. The module whose `<module>.errors.<code>` gives the words: the one the API error body names, when it names one; else the first module of the bundle that has the key; else `web`, where `ErrorState` shows `platform.error.generic`. An `ApiError` carries its code to the browser in its digest, which Next.js keeps in production. A `notFound()` and an address no route takes render `app/not-found.tsx`; `loading.tsx` shows `LoadingState` while a screen loads.

## Styles

A screen styles with the Tailwind classes of ui's theme (`bg-surface`, `text-ink-muted`) and its components, logical utilities only (`ms-2`, never `ml-2`: `pnpm lint`), and takes its icons from `@whytide/ui/icons` ([ui's README](../../../packages/ui/README.md#theme)). The shell styles no element of a screen: one without a class keeps Tailwind's reset, no margin and no list marker.

## Text

Every string is a key of the module's `messages/en.json`, `module.screen.purpose`. `pnpm -F platform messages:check` reads the keys of `ui/`, the literals of `nav.ts` included; `pnpm -F web build` runs it first and fails on a key missing from the bundle.

## Playwright

- A test is one flow in `tests/<flow>.spec.ts`; a module's screen test sits here too, as `tests/<module>-<flow>.spec.ts`, since a module's test never imports the host (its sign-in fixture included). A module's flow that needs no fixture of the host, as identity's sign-in through its screens, stays in the module, `core/modules/<name>/tests/*.spec.ts`, with `@playwright/test` in its devDependencies. `pnpm -F web test` runs them all in Chromium; `pnpm -F web exec playwright test --project=all` in Chromium, Firefox and WebKit, for the full pipeline. A failure keeps a screenshot and a video in `test-results/`.
- The servers: the config starts `pnpm -F api serve:e2e` on `API_PORT` and `pnpm -F web serve:e2e` on `WEB_PORT` (both from `.env.local`) unless they already listen there. Start both once in two terminals, and a rerun takes seconds. The e2e api (`core/apps/api/tests/e2e-server.ts`) runs under `APP_ENV=test` with tenancy (`FEEDBACK_URL` set) and identity, whose resolver reads the memberships, the routes of the api's fixture module, the modules whose screens the tests open (icp, onboarding, linkedin with the LinkedIn fake's connect route mounted, signals with the sender accounts, runs and evidence `tests/e2e-signals.ts` seeds, discovery with contacts and a fixed hash salt, and messaging, whose drafts the e2e module seeds), Better Auth beside the fake's test route, its links on the web (`AUTH_BASE_URL`), and `APP_PUBLIC_ORIGIN` the web's origin; a screen task adds its module to that list. Before it listens, it makes the fixture's workspace, `wsp_fixture_a`, a second one, `wsp_e2e_b`, for a screen's two-workspace check, a third, `wsp_e2eimport`, for the import screen, a fourth, `wsp_e2e_review`, for the lead page's review panel, `wsp_e2e_qual` and `wsp_e2e_rescore` for qualification's panel, `wsp_e2e_export` for the lead list's Export button, `wsp_e2e_evidence` for signals' evidence panel, `wsp_e2e_signals` and `wsp_e2e_run_now` for signals' screen states and Run now, and `wsp_e2e_contacts`, `wsp_e2e_noleads` and `wsp_e2e_url` for the lead list's and the lead page's states and the list's address, `wsp_e2e_drafts` and `wsp_e2e_messaging` for messaging's draft panel and its states, and `wsp_e2e_costs` and `wsp_e2e_nocosts` for credits' costs page and cost line, one per spec, all owned by `e2e@example.com`, `e2e-usage@example.com`, `e2e-states@example.com` and `e2e-read-cap@example.com`, each its own user, so that specs running at once never share a LinkedIn account. identity's flows invite emails of their own to `wsp_fixture_a` as `pnpm invite` does and sign in through the screens with the link from Mailpit. It runs no worker: a screen that waits on the worker's work answers its poll with `page.route`, as `tests/onboarding-draft-button.spec.ts` does, or has the e2e module write the row as the worker would, as `tests/messaging-draft-panel.spec.ts` does. `page.route` stubs what the browser asks, never what a server component reads: for a loading state there, the cookie `e2e_hold=<end of a path>` makes the e2e api hold that `GET` three seconds (`tests/e2e-hold.ts`), as `tests/contacts-states.spec.ts` does, and for an error state `e2e_fail=<end of a path>` makes it answer 500, as `tests/messaging-states.spec.ts` does. Stop the e2e api before `pnpm -F api dev`: both take `API_PORT`.
- Signing in: take `test` and `expect` from `tests/sign-in.ts`; `await signInAs()` posts `{ email }` to the api's `POST /api/auth/fake/sign-in` through the web's `/api` rewrite, with the web's `Origin`, so the session cookie lands on the web's host.
- The host's own tests use the test module of `tests/fixtures/modules/fixture`: one screen at `/w/wsp_fixture_a/fixture` (`?name=missing` makes the api answer 404), and two panels of contacts' lead page, one in its `evidence` slot and one in its `draft` slot that throws when the cookie `fixture_panel=throw` is set. Only `serve:e2e` and `typecheck` mount it (`web:routes --fixtures`); `build` never does.
