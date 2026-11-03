// The origin check (docs/security.md): a request that may change something (any method but GET, HEAD
// and OPTIONS) and carries the session cookie comes from the app, or it is 403 origin_rejected. The
// browser says where it comes from with `Sec-Fetch-Site: same-origin`, or with an Origin header equal
// to APP_PUBLIC_ORIGIN or, under APP_ENV=development, WEB_DEV_ORIGIN. A request without the cookie
// carries no session to abuse and is not checked. Mounted ahead of the authentication handler, so
// sign-out is covered too. The cookie itself stays SameSite=Lax; no CORS headers are sent in alpha.
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "@whytide/platform";
import { authSessionCookie } from "@whytide/providers";
import { protectionErrors } from "./errors.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `origins`: the origins besides the api's own a cookie-carrying change may come from. */
export function originCheck(origins: ReadonlySet<string>) {
  return (req: IncomingMessage, _res: ServerResponse, next: (error?: unknown) => void): void => {
    if (SAFE_METHODS.has(req.method ?? "GET") || !hasSessionCookie(req.headers.cookie)) {
      return next();
    }
    const { origin, "sec-fetch-site": site } = req.headers;
    if (site === "same-origin" || (origin !== undefined && origins.has(origin))) return next();
    next(new AppError(protectionErrors.origin_rejected));
  };
}

/** Whether a Cookie header carries the session cookie, whatever its value. */
function hasSessionCookie(header: string | undefined): boolean {
  return (header ?? "")
    .split(";")
    .some((pair) => pair.split("=", 1)[0]?.trim() === authSessionCookie.name);
}
