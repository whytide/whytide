// The authentication port's Better Auth adapter (README.md): Better Auth with its magic-link plugin,
// on this adapter's tables through its Prisma adapter (store.ts) and on the port's hooks. A link is
// requested through requestMagicLink only and followed through the one route the handler serves; a
// session is read from its cookie, signed with AUTH_SECRET. Better Auth's router, rate limiter,
// logger and telemetry stay off: the api host limits /api/auth/* per address and reports the errors
// the adapter throws.
import type { IncomingMessage } from "node:http";
import { createDbClient } from "@whytide/db";
import {
  AppError,
  defaultLocale,
  defineIds,
  isAppError,
  newId,
  platformConfig,
  renderMail,
} from "@whytide/platform";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { type BetterAuthOptions, betterAuth } from "better-auth/minimal";
import { magicLink } from "better-auth/plugins/magic-link";
import { defineAdapter } from "../../_pattern/index.ts";
import { confirmPage, fromOwnPage } from "../confirm.ts";
import {
  AUTH_LINK_FAILED_PATH,
  AUTH_LINK_TTL_MS,
  AUTH_SESSION_TTL_MS,
  type AuthHandler,
  type AuthHooks,
  authPort,
  authRedirectPath,
  authSessionCookie,
} from "../port.ts";
import { betterAuthSettings } from "./config.ts";
import { givenAuthDatabase } from "./database.ts";
import { LinkRefused, wrapAdapter } from "./store.ts";

/** The link's route: the one path under /api/auth/ the handler serves. */
export const VERIFY_PATH = "/api/auth/magic-link/verify";
/** Where every failed link lands, unknown, used, expired or refused: one answer, as the fake's. */
const FAILED = `${AUTH_LINK_FAILED_PATH}?code=${authPort.errors.auth_link_expired}`;
const failed = { status: 303, headers: { location: FAILED } } as const;
/** The header that brings Better Auth the client's address as the host sees it, never a client's. */
const CLIENT_ADDRESS = "x-whytide-client-address";
/** The most of a user agent a session row keeps. */
const USER_AGENT_LIMIT = 512;

export const ids = defineIds({
  ses: "auth_session",
  acc: "auth_account",
  ver: "auth_verification",
});
const prefixOf: Readonly<Record<string, string>> = {
  session: ids.auth_session,
  account: ids.auth_account,
  verification: ids.auth_verification,
};

const refuse = async (): Promise<never> => {
  throw new AppError(authPort.errors.auth_invite_required);
};
/** Until configure() runs nobody may sign in. */
const NOBODY: AuthHooks = {
  allowSignIn: async () => false,
  mail: { send: refuse },
  users: { findOrCreateByEmail: refuse },
};

/** A route's answer; the handler adds `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. */
type Answer = { readonly status: number; readonly headers: Readonly<Record<string, string>> };

export const betterAuthAdapter = defineAdapter(authPort, {
  name: "better-auth",
  create: () => {
    const settings = betterAuthSettings();
    let hooks = NOBODY;
    /** The users revokeUser revoked, per users store: no link signs them in again. */
    const revocations = new WeakMap<object, Set<string>>();
    const revokedOf = (store: object) => {
      const revoked = revocations.get(store) ?? new Set<string>();
      revocations.set(store, revoked);
      return revoked;
    };
    const prisma = givenAuthDatabase() ?? createDbClient("app");
    const users = { hooks: () => hooks, revoked: (id: string) => revokedOf(hooks.users).has(id) };

    /** A link goes to an email allowSignIn allows, unless the users store has it disabled. */
    async function allowLink(email: string): Promise<void> {
      const configured = hooks; // the same hooks for the whole check
      const allowed = (await configured.allowSignIn(email)) === true;
      const user = allowed ? await configured.users.findByEmail?.(email) : undefined;
      if (!allowed || user?.disabledAt || (user && revokedOf(configured.users).has(user.id))) {
        throw new AppError(authPort.errors.auth_invite_required);
      }
    }

    const auth = betterAuth({
      appName: "Whytide",
      baseURL: settings.baseURL,
      basePath: "/api/auth",
      secret: settings.secret,
      trustedOrigins: [settings.baseURL],
      database: (options: BetterAuthOptions) =>
        wrapAdapter(prismaAdapter(prisma, { provider: "postgresql" })(options), users),
      // An absolute lifetime: a session is never extended on use.
      session: { expiresIn: AUTH_SESSION_TTL_MS / 1000, disableSessionRefresh: true },
      // The api host limits every /api/auth/* request per address (alpha-p2-030).
      rateLimit: { enabled: false },
      telemetry: { enabled: false },
      logger: { disabled: true },
      advanced: {
        // The port's cookie, whose name carries __Host- when it is Secure: no prefix of Better Auth's.
        useSecureCookies: false,
        cookies: {
          session_token: {
            name: authSessionCookie.name,
            attributes: { secure: authSessionCookie.secure, sameSite: "lax", path: "/" },
          },
        },
        ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS] },
        database: {
          generateId: ({ model }) => (prefixOf[model] ? newId(prefixOf[model]) : false),
          validateSchema: false,
        },
      },
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/sign-in/magic-link") await allowLink(String(ctx.body?.email));
        }),
      },
      plugins: [
        magicLink({
          storeToken: "hashed",
          expiresIn: AUTH_LINK_TTL_MS / 1000,
          sendMagicLink: async ({ email, url }) => {
            const mail = renderMail("identity.mail.sign_in", { url }, defaultLocale());
            await hooks.mail.send({ to: email, subject: mail.subject, text: mail.body });
          },
        }),
      ],
    });

    /** Where following a link lands, with the new session's cookie when it signs the user in. */
    async function follow(url: URL, req: IncomingMessage): Promise<Answer> {
      const token = url.searchParams.get("token") ?? "";
      // The first callbackURL is the one mailed; one outside the app fails the link, unspent.
      const target = authRedirectPath.safeParse(url.searchParams.get("callbackURL") ?? "/");
      if (token === "" || !target.success) return failed;
      const agent = String(req.headers["user-agent"] ?? "").slice(0, USER_AGENT_LIMIT);
      const headers = new Headers({ "user-agent": agent });
      const address = (req as { ip?: string }).ip ?? req.socket.remoteAddress;
      if (address) headers.set(CLIENT_ADDRESS, address);
      try {
        const query = { token, callbackURL: target.data };
        const answer = await auth.api.magicLinkVerify({ query, headers, asResponse: true });
        const cookie = sessionCookie(answer);
        return cookie
          ? { status: 303, headers: { location: target.data, "set-cookie": cookie } }
          : failed;
      } catch (error) {
        if (error instanceof LinkRefused) return failed;
        throw error;
      }
    }

    const handler: AuthHandler = (req, res, next) => {
      // The raw path, exactly, as the host's rate limit reads it: `/./api/…`, `/x/../api/…` or a
      // backslash would reach the route past that limit once normalized, so they go on to the host.
      const path = (req.url ?? "").split("?")[0];
      const url = URL.parse(req.url ?? "/", "http://auth.invalid");
      if (path !== VERIFY_PATH || !url || (req.method !== "GET" && req.method !== "POST")) {
        return next();
      }
      // A GET, a mail scanner's say, spends nothing (../confirm.ts): the confirm page's POST signs in.
      const answer =
        req.method === "GET"
          ? Promise.resolve<Answer>(confirmPage(req))
          : fromOwnPage(req, [settings.baseURL])
            ? follow(url, req)
            : Promise.resolve<Answer>(failed);
      answer
        .then(({ status, headers }) => {
          if (res.headersSent) return; // the host answered already, on a timeout say
          const policy = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
          res.writeHead(status, { ...headers, ...policy }).end();
        })
        .catch((error: unknown) => {
          if (!res.headersSent) next(portError(error));
        });
    };

    const endSessions = async (userId: string) =>
      (await auth.$context).internalAdapter.deleteUserSessions(userId);

    return {
      configure: async (given) => {
        hooks = given;
      },
      mountHandler: async (app) => {
        app.use(handler);
      },
      resolvePrincipal: async ({ headers }) => {
        const cookie = headers.cookie;
        if (typeof cookie !== "string" || !cookie.includes(`${authSessionCookie.name}=`)) {
          return null;
        }
        const query = { disableRefresh: true };
        const found = await auth.api.getSession({ headers: new Headers({ cookie }), query });
        return found ? { userId: found.session.userId, sessionId: found.session.id } : null;
      },
      requestMagicLink: async ({ email, redirectTo }) => {
        const body = { email, callbackURL: redirectTo };
        await auth.api.signInMagicLink({ body, headers: new Headers() });
      },
      signOutEverywhere: endSessions,
      revokeUser: async (userId) => {
        const configured = hooks;
        revokedOf(configured.users).add(userId); // first: a link followed meanwhile fails too
        await endSessions(userId);
        await configured.users.disable?.(userId);
      },
      isSecondFactorEnrolled: async () => false,
    };
  },
});

/** Better Auth's session cookie with the port's attributes (../README.md "The session cookie"). */
function sessionCookie(answer: Response): string | undefined {
  const { name, path, maxAgeSeconds, httpOnly, sameSite, secure } = authSessionCookie;
  const set = answer.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  const value = set?.slice(name.length + 1).split(";")[0];
  if (!value) return undefined;
  const flags = `${httpOnly ? "; HttpOnly" : ""}; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}${flags}`;
}

/** What next() receives: one of the port's codes, wrapped as bindPort wraps an error. */
function portError(error: unknown): AppError {
  const { errors, codes } = authPort;
  if (isAppError(error) && (Object.hasOwn(errors, error.code) || error.code === codes.input)) {
    return error;
  }
  const cause = platformConfig.APP_ENV === "production" ? undefined : error;
  return new AppError(codes.error, { details: { method: "mountHandler" }, cause });
}
