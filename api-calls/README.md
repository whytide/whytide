# api-calls: a request for every endpoint

Every task that adds an HTTP endpoint writes its requests here, in one `.http` file named after the task: `<task ID>-<slug>.http`, the name of its branch without `task/`. For example, `task/alpha-p3-010-tenancy-tables` writes `alpha-p3-010-tenancy-tables.http`. The files use the format that the VS Code REST Client and the JetBrains HTTP Client read.

- **One request per endpoint**, with an example body. Each request follows a `### <METHOD> <path>: <what it does>` line.
- **Variables, never literals:** `{{baseUrl}}`, `{{workspaceId}}` and `{{sessionCookie}}`, never a literal host, id or cookie. The worker's health server is `{{workerHealthUrl}}` (core/apps/worker/README.md "Health").
  - Their values come from two files next to this one:
    - `http-client.env.json`, committed: the `dev` environment, with the stack's default ports;
    - `http-client.private.env.json`, git-ignored: the session cookie.
  - `dev` holds `baseUrl`, `workspaceId`, the api tests' fixture workspace, and `appOrigin`, the web app's origin; put your own values, your workspace's id among them, in the private file, which wins.
  - **A write request** (any method but GET, HEAD and OPTIONS) that sends the cookie also sends `Origin: {{appOrigin}}`: the api refuses a cookie-carrying change from any origin but `APP_PUBLIC_ORIGIN` (core/apps/api/docs/security.md). Set `APP_PUBLIC_ORIGIN` in `.env.local`; `pnpm http:run` then sends it as `appOrigin`.
  - `pnpm session:token <email>` writes `dev.sessionCookie` into the private file and never prints it (core/apps/api/README.md "The .http file"), from the worktree's api under `APP_ENV=test`, for an email invited with `pnpm invite <email>` or a member already.
- **No secrets:** never a secret, a token or a real person's data in a committed file.
- **Changing an endpoint later:** a task that changes an endpoint updates the request in the file that holds it. Its new endpoints go in its own file.
- **Running the files:** `pnpm http:run <file>` runs one against the worktree's api and prints each status. In the alpha speed mode ([delivery §7](../docs/rules/delivery.md#7-alpha-speed-mode)), a task writes its file and does not run it.
- **Coverage:** `pnpm openapi:build` fails, naming the route, when a route of the OpenAPI document has no request in a file here.
