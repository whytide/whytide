// The authentication port (docs/architecture.md §9 "Authentication", docs/15 §5): the API
// resolves a request's principal, signs a user out everywhere, revokes a user, sends a sign-in link
// and asks about a second factor through it, and nothing else knows which library runs. The
// identity module injects the invite-only rule, the mail sender and the users store through
// configure(), so that no adapter imports a module. The session cookie, the lifetimes and the page
// a failed link lands on are set here, for every adapter.
import type { IncomingMessage, ServerResponse } from "node:http";
import { platformConfig } from "@whytide/platform";
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";

export { authConfig } from "./config.ts";

/** What resolvePrincipal reads of a request: its headers, as node:http and Express carry them. */
export type AuthRequest = Pick<IncomingMessage, "headers">;
/** A connect-style handler: Express, NestJS's app.use and a plain node:http server mount it. */
export type AuthHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;
/** What mountHandler mounts on: anything with a connect-style use(), a NestJS app among them. */
export type AuthApp = { use(handler: AuthHandler): unknown };
/** The mail the adapter sends: the input of the app-mail port's send() (alpha-p1-110). */
export type AuthMail = { to: string; subject: string; text: string; html?: string };
/** A user as the users store answers: the id, and since when the user is disabled, if ever. */
export type AuthUser = { id: string; disabledAt?: Date | null };
export type AuthHooks = {
  /** The invite-only rule (alpha-p3-030): true lets the email sign in, anything else refuses it. */
  allowSignIn(email: string): Promise<boolean>;
  /** The app-mail port, or anything with its send(). */
  mail: { send(message: AuthMail): Promise<unknown> };
  /** The users store (tenancy's users, through identity): an adapter reaches users only here. */
  users: {
    /** The user with this email, created at the first sign-in. */
    findOrCreateByEmail(email: string): Promise<AuthUser>;
    /** The user with this email, created by nothing: a disabled one is sent no link. */
    findByEmail?(email: string): Promise<AuthUser | null>;
    /** Sets the user's users.disabled_at: revokeUser calls it. */
    disable?(userId: string): Promise<unknown>;
  };
};

/** A sign-in link works once, within 15 minutes; a session lasts 30 days from the sign-in. */
export const AUTH_LINK_TTL_MS = 15 * 60_000;
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Where a failed link lands, with `?code=auth_link_expired`: the screen of alpha-p3-040. */
export const AUTH_LINK_FAILED_PATH = "/sign-in/expired";
/** Where a link's GET lands, with `?link=` its path and query: the page whose button signs in. */
export const AUTH_LINK_CONFIRM_PATH = "/sign-in/confirm";

const secure = platformConfig.APP_ENV === "production";
/** The session cookie of every adapter (README.md "The session cookie"): `__Host-` when Secure. */
export const authSessionCookie = Object.freeze({
  name: secure ? "__Host-whytide_session" : "whytide_session",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
  secure,
  maxAgeSeconds: AUTH_SESSION_TTL_MS / 1000,
} as const);

const APP_ORIGIN = "http://app.invalid";
/**
 * A path inside the app, resolved as a browser resolves a Location header: printable ASCII after
 * one slash, still on the app's origin and not a `//host` path, so that no scheme, `//host`,
 * `/\host`, `/./` trick or control character makes the redirect after sign-in leave the app. No
 * percent-encoded slash, backslash, control character or DEL, which a host that decodes once would
 * turn back into one, and nothing under `/api/` once percent-decoded, in any case: the redirect
 * never lands on another sign-in link (login CSRF).
 */
function isAppPath(value: string): boolean {
  const plain = /^\/[\x21-\x7e]*$/.test(value) && !/%(?:[01][\da-f]|7f|2f|5c)/i.test(value);
  const url = plain ? URL.parse(value, APP_ORIGIN) : null;
  if (url?.origin !== APP_ORIGIN) return false;
  const path = url.pathname.replace(/%[\da-f]{2}/gi, (hex) =>
    String.fromCharCode(Number.parseInt(hex.slice(1), 16)),
  );
  return !path.startsWith("//") && !/^\/api\//i.test(path);
}

/** Where sign-in lands; alpha-p3-020 checks Better Auth's callbackURL with it too. */
export const authRedirectPath = z.string().max(2048).refine(isAppPath, "a path inside the app");

const isFunction = (value: unknown) => typeof value === "function";
const hasMethod = (name: string) => (value: unknown) =>
  typeof (value as Record<string, unknown> | null)?.[name] === "function";
const hasHeaders = (value: unknown) => {
  const headers = (value as { headers?: unknown } | null)?.headers;
  return typeof headers === "object" && headers !== null;
};
const userId = z.string().min(1);
/** The email every hook sees: trimmed, lowercased, at most 254 characters. */
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Hooks, the app and the request are opaque values: z.custom checks their shape and hands them on.
export const authPort = definePort({
  name: "auth",
  methods: {
    configure: {
      input: z.strictObject({
        allowSignIn: z.custom<AuthHooks["allowSignIn"]>(isFunction),
        mail: z.custom<AuthHooks["mail"]>(hasMethod("send")),
        users: z.custom<AuthHooks["users"]>(hasMethod("findOrCreateByEmail")),
      }),
      output: z.void(),
    },
    mountHandler: { input: z.custom<AuthApp>(hasMethod("use")), output: z.void() },
    resolvePrincipal: {
      input: z.custom<AuthRequest>(hasHeaders),
      output: z.strictObject({ userId, sessionId: z.string().min(1) }).nullable(),
    },
    requestMagicLink: {
      input: z.strictObject({ email, redirectTo: authRedirectPath }),
      output: z.void(),
    },
    signOutEverywhere: { input: userId, output: z.void() },
    revokeUser: { input: userId, output: z.void() },
    isSecondFactorEnrolled: { input: userId, output: z.boolean() },
  },
  errors: {
    /** The fake's create() under APP_ENV=production: the fake never runs there. */
    auth_fake_in_production: { status: 500 },
    /** The users hook returned no id: a host bug, which the handler gives to next(). */
    auth_hook_invalid: { status: 500 },
    /** allowSignIn refused the email: no link, no mail, no user. */
    auth_invite_required: { status: 403 },
    /** A link unknown, used, expired or refused since: AUTH_LINK_FAILED_PATH carries the code. */
    auth_link_expired: { status: 410 },
    /** No live session: the api guard answers it when resolvePrincipal returns null. */
    auth_session_invalid: { status: 401 },
  },
});
