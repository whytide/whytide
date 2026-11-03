// The api from a client component (docs/screens.md "The API"): the generated client on /api of the
// page's own origin, rewritten to the api by the web server (next.config.ts) or routed by Caddy in
// production; the browser sends the session cookie itself.
import { createApiClient } from "./client.generated.ts";

export { ApiError, data, errorOwner } from "./errors.ts";

export const browserApi = () => createApiClient({ baseUrl: "/api" });
