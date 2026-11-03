// The e2e api's own module (tests/e2e-server.ts), never the api's: routes that set up what a flow of
// core/apps/web/tests needs in the signed-in member's workspace, mounted under
// /v1/workspaces/:workspaceId/e2e. Its price, e2e.batch, joins the price list at the e2e api's start;
// persons are hashed with the e2e api's test salt.
if (process.env.APP_ENV !== "test") throw new Error("the e2e module loads under APP_ENV=test only");

export { E2eApi as api, permissions } from "./e2e.controller.ts";
