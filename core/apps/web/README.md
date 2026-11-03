# @whytide/web

The Next.js host for tenants: the App Router with standalone output, the workspace in the URL (`/w/<workspace>/<segment>`). It holds the shell (the layout, the navigation, the error, not-found and loading pages) and the route tree generated from the modules' `ui/nav.ts`; the screens are the modules' own ([docs/screens.md](docs/screens.md)). It never touches the database and calls the api through the generated client only (docs/rules/coding.md §4).

## Commands

| | |
|---|---|
| `pnpm -F web dev` | `client:generate`, `web:routes`, builds `@whytide/ui`, then `next dev` at `127.0.0.1:WEB_PORT` |
| `pnpm -F web build` | the same with `web:routes --production`, then `next build` to `.next/standalone/` |
| `pnpm -F web start` | `next start` at `127.0.0.1:WEB_PORT` on the last build (the image runs `.next/standalone/core/apps/web/server.js`, so Next warns that `start` is not for standalone output) |
| `pnpm -F web test` | the unit tests (`tests/*.test.ts`), then Playwright ([docs/screens.md](docs/screens.md#playwright)) |
| `pnpm -F web serve:e2e` | the web of the Playwright tests: `next build` with the test modules of `tests/fixtures/modules/`, then `next start` |
| `pnpm web:routes` | writes the generated route tree ("Routes") |
| `pnpm client:generate` | writes the api client ("The API client"); it loads every module's build, so a module that a rebase brings needs `pnpm -F <name> build` first |

## Run

Every next command goes through `scripts/next.ts`, which reads the repository's `.env.local` and sets `NEXT_TELEMETRY_DISABLED=1` (Next.js sends no telemetry), `NEXT_DISABLE_SWC_WASM=1` (no download of the WebAssembly compiler) and `NEXT_PUBLIC_API_URL` (`http://127.0.0.1:API_PORT` when empty); never call `next` itself, and set the first two in an image or a pipeline job that does. `next.config.ts` sets `images.unoptimized` (sharp is not installed), `agentRules: false` and `experimental.agentUpgrade: false`. Fonts and assets come from the repository: never `next/font/google`, `next/og` or `--experimental-upload-trace`. `next dev` still asks registry.npmjs.org for next's latest version once at start, with no switch to turn it off; `build` and `start` make no call, so the Playwright tests run on them.

Configuration (`config.ts`, the `apps/web` block of `deploy/.env.example`): `WEB_PORT`, filled per worktree by `pnpm env:create`, which also sets the api's `WEB_DEV_ORIGIN` to `http://127.0.0.1:WEB_PORT`; `NEXT_PUBLIC_API_URL`, inlined at build.

## Routes

`pnpm web:routes` (also run by `dev`, `build` and `typecheck`) reads each module's `ui/nav.ts` and writes, all git-ignored: `app/w/[workspace]/(modules)/<segment>/page.tsx`, one line re-exporting the module's screen; `(modules)/<path>/page.tsx` for each of a module's `pages`, the screen with the `panels` other modules put in its slots; `app/(public)/<path>/page.tsx` for each of a module's `publicPages`, outside the workspaces; `src/shell/slots.generated.tsx`, the components of the modules' `slots` in the header; `src/shell/nav.generated.ts`, the navigation, groups in the order of `src/shell/nav.ts` and entries by `order`, each with its icon imported from `@whytide/ui/icons`; `src/i18n/messages.generated.json`, the merged message bundle of the default locale; and in development `app/dev/ui/page.tsx`, the component gallery of `@whytide/ui` at `/dev/ui`, a 404 anywhere else. A segment, a public path or a slot declared twice fails, naming both files, and so does a panel in a slot its page does not list. `--production` (in `build`) leaves the gallery out and first runs the message-key check, failing on any finding; `--fixtures` adds the test modules.

## The shell

`app/layout.tsx` loads `app/globals.css` ("Styles"), renders `<html data-theme>` from the theme cookie, `whytide_theme`, which the account menu's `ThemeToggle` writes, so that the server renders the chosen theme with no flash, and gives next-intl the bundle (`src/i18n/request.ts`), and `@whytide/ui` next-intl's `t`. `app/w/[workspace]/layout.tsx` reads `GET /v1/me`: with no session it sends the visitor to `/sign-in?next=<the page>`, the page taken from `x-whytide-path`, which `proxy.ts` sets on every request but a prefetch, when it is a page of that workspace (the workspace's address otherwise); `proxy.ts` also sends `/sign-in/confirm`, whose URL holds a link's token, with `Referrer-Policy: no-referrer`; a workspace among the member's own by slug or id shows the sidebar (the logo; the workspace switcher, `src/shell/workspace-switcher.tsx`, a menu of the member's workspaces when there is more than one; the navigation with its icons, the current entry `aria-current`), a drawer with the same under 1024 px (`src/shell/drawer.tsx`, a modal `<dialog>`), and the top bar: the trail and the header slots, `data-slot="balance"` (credits' balance) and `data-slot="sign-out"` (identity's account menu); any other is not found. `/w/<workspace>` alone greets the member and lists the navigation's entries as the steps of the day, each a link to its screen (`app/w/[workspace]/page.tsx`). The host's own text is `web.*` in `messages/en.json`. `/` sends a member to their first workspace and anyone else to `/sign-in` (`app/page.tsx`).

`proxy.ts` sets the page's content security policy, with a fresh nonce per request that Next.js puts on its own scripts: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`, `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; `'unsafe-eval'` is added in development only, where React rebuilds server stack traces with it. Pages render per request, so each gets its nonce.

The header also holds tenancy's feedback link (`src/shell/feedback-link.tsx`, alpha-p10-040): `feedbackUrl` from the layout's own `GET /v1/me` answer, labelled `tenancy.feedback.link`, opened in a new tab with `rel="noopener noreferrer"`; nothing when it is `null`.

## Styles

`postcss.config.mjs` runs Tailwind CSS 4 (`@tailwindcss/postcss`) on `app/globals.css`, the one stylesheet: Inter (`@fontsource-variable/inter`, its files served from this origin), `@import "tailwindcss"`, the theme and the public classes of `@whytide/ui` ([its README](../../packages/ui/README.md#theme)), and `@source` lines for the ui package and every module's `ui/`, so that the classes written there are generated. `browserslist` in `package.json` names browsers with a native `light-dark()` (Chrome and Edge 123, Firefox 120, Safari 17.5), so that the compiler keeps it.

## The API client

`pnpm client:generate` builds the api's OpenAPI document (`pnpm -F api openapi:build`) and writes `src/api/client.generated.ts` (git-ignored): the document's types by `openapi-typescript`, and `createApiClient(options)`, `openapi-fetch`'s `createClient` over them. `client.GET("/v1/workspaces/{workspaceId}/…", { params: { path: { workspaceId } } })` is typed in its input and its answer. The file's second line holds the document's SHA-256: it is rewritten only when the document changed. `pnpm -F web typecheck` builds the document, writes a missing client and fails on a client older than the document, naming `pnpm client:generate`. The pipeline's `openapi:build` step regenerates it.

A screen takes the client from `@whytide/web/api/server` or `@whytide/web/api/browser` ([docs/screens.md](docs/screens.md#the-api)), which the web resolves for a module's screens itself (`next.config.ts`, `tsconfig.json`): the server's calls go to `NEXT_PUBLIC_API_URL` with the request's `cookie` and `Origin`; the browser's go to `/api/v1/*`, which `next.config.ts` rewrites to the api's `/v1/*` (and `/api/auth/*` to the api's `/api/auth/*`, `/api/linkedin/*` to the api's, where the e2e api serves the LinkedIn fake's hosted links); in production Caddy is to route them the same way (alpha-p10-070).
