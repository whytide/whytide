// The e2e api's hold, test only (core/apps/web/tests/contacts-states.spec.ts,
// messaging-states.spec.ts): a GET whose path ends with the value of the request's cookie `e2e_hold`
// waits three seconds before the routes answer it, and one whose path ends with the value of
// `e2e_fail` answers 500 internal_error, as the api answers a fault. The web's server components
// read the api from the web's server, where Playwright stubs nothing, so a spec slows or fails one
// of their reads this way to see a screen's loading or error state.
import type { IncomingMessage, ServerResponse } from "node:http";

const HOLD_MS = 3_000;

/** The handler the e2e api mounts ahead of the routes. */
export function holdRoute() {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const named = (name: string) => {
      const cookie = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];
      return cookie !== undefined && path.endsWith(decodeURIComponent(cookie));
    };
    if (req.method !== "GET") return next();
    if (named("e2e_fail")) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ code: "internal_error" }));
      return;
    }
    if (!named("e2e_hold")) return next();
    setTimeout(next, HOLD_MS);
  };
}
