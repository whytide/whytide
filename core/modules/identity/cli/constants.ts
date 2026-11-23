// The fixed values of identity's commands (README.md "The invite command", "The tenant commands"):
// `pnpm invite`, `pnpm tenant:create` and `pnpm workspace:create`.

/** The web's sign-in page, after APP_PUBLIC_ORIGIN, as `pnpm invite` prints it. */
export const SIGN_IN_PATH = "/sign-in";

/** The exit codes: made, refused, a usage error, the mail failed once the rows were made. */
export const EXIT = { done: 0, refused: 1, usage: 2, mailFailed: 3 } as const;

export const TENANT_CREATE_USAGE =
  "usage: pnpm tenant:create --name <organization name> --slug <slug> --admin-email <email> [--admin-name <name>] [--no-mail]";
export const WORKSPACE_CREATE_USAGE =
  "usage: pnpm workspace:create --org <organization slug or id> --name <workspace name> --slug <slug> --admin-email <email> [--admin-name <name>] [--no-mail]";
