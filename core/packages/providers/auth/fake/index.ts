// The authentication fake (README.md "The fake"): sign-in links and sessions in memory, each kept
// under the SHA-256 of its token, the mailed links readable by tests in links(), configure()
// honored. Its handler follows a link and sets the session cookie: module tests and the Compose
// smoke test sign in through it, without the library. Under APP_ENV=test the handler also signs an
// email in on a POST, and createSession() opens a session for signInAs (README.md "Signing in from
// tests"). Never in production.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError, isAppError, platformConfig } from "@whytide/platform";
import { z } from "zod";
import {
  createFake,
  defineAdapter,
  type FakeContext,
  type RecordedCall,
} from "../../_pattern/index.ts";
import { confirmPage, fromOwnPage } from "../confirm.ts";
import {
  AUTH_LINK_FAILED_PATH,
  AUTH_LINK_TTL_MS,
  AUTH_SESSION_TTL_MS,
  type AuthHandler,
  type AuthHooks,
  authPort,
  authSessionCookie,
} from "../port.ts";

/** The path of the fake's links, on the host that mounts its handler. */
export const LINK_PATH = "/api/auth/fake/verify";
/** The test sign-in route, `POST { "email": … }`, on the host that mounts the handler. */
export const SIGN_IN_PATH = "/api/auth/fake/sign-in";
/** The route is mounted under APP_ENV=test exactly: never "not production", never development. */
const TEST_MODE = platformConfig.APP_ENV === "test";
/** The most of a sign-in body the route reads, in bytes. */
const SIGN_IN_BODY_LIMIT = 4096;
/** The sign-in body: the email as the port takes it, trimmed, lowercased, 254 characters at most. */
const signInBody = z.strictObject({ email: authPort.methods.requestMagicLink.input.shape.email });
/** Where every failed link lands, unknown, used, expired or refused: one answer, byte for byte. */
const FAILED = `${AUTH_LINK_FAILED_PATH}?code=${authPort.errors.auth_link_expired}`;
const failed = { status: 303, headers: { location: FAILED } } as const;

export type SentLink = { readonly email: string; readonly url: string };
type PendingLink = {
  readonly email: string;
  readonly redirectTo: string;
  readonly expiresAt: number;
};
type Session = { readonly id: string; readonly userId: string; readonly expiresAt: number };
type State = {
  /** Links not followed yet, by the SHA-256 of their token: the store holds no usable token. */
  readonly pending: Map<string, PendingLink>;
  /** Live sessions, by the SHA-256 of the cookie's token. */
  readonly sessions: Map<string, Session>;
  /** The users revokeUser revoked: no link signs them in again. */
  readonly revoked: Set<string>;
  readonly sent: SentLink[];
};
type Context = FakeContext<typeof authPort, State>;
/** A route's answer; the handler adds `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. */
type Answer = { readonly status: number; readonly headers: Readonly<Record<string, string>> };

const refuse = async (): Promise<never> => {
  throw new AppError(authPort.errors.auth_invite_required);
};
/** Until configure() runs nobody may sign in. Configuration, not state: reset() keeps it. */
let hooks: AuthHooks = {
  allowSignIn: async () => false,
  mail: { send: refuse },
  users: { findOrCreateByEmail: refuse },
};

const newToken = () => randomBytes(32).toString("base64url");
const digest = (token: string) => createHash("sha256").update(token).digest("base64url");

export const authFake = createFake(authPort, {
  state: (): State => ({ pending: new Map(), sessions: new Map(), revoked: new Set(), sent: [] }),
  methods: (fake) => ({
    configure: async (given) => {
      hooks = given;
    },
    mountHandler: async (app) => {
      app.use(handler(fake));
    },
    resolvePrincipal: async ({ headers }) => {
      // createFake recorded this call just now: dropped, since the api makes it on every request
      // and the record would keep the request and its cookie (README.md "The fake").
      (fake.recordedCalls as RecordedCall[]).pop();
      const token = readCookie(headers.cookie);
      const session = token === undefined ? undefined : fake.state.sessions.get(digest(token));
      if (!session || session.expiresAt <= Date.now()) return null;
      return { userId: session.userId, sessionId: session.id };
    },
    requestMagicLink: async ({ email, redirectTo }) => {
      const configured = hooks; // the same hooks for the whole call
      if ((await configured.allowSignIn(email)) !== true) {
        throw new AppError(authPort.errors.auth_invite_required);
      }
      const token = newToken();
      const expiresAt = Date.now() + AUTH_LINK_TTL_MS;
      fake.state.pending.set(digest(token), { email, redirectTo, expiresAt });
      const url = `${LINK_PATH}?token=${token}`;
      const text = `Sign in to Whytide with this link; it works once, within 15 minutes: ${url}\n`;
      await configured.mail.send({ to: email, subject: "Sign in to Whytide", text });
      fake.state.sent.push({ email, url });
    },
    signOutEverywhere: async (userId) => endSessions(fake.state, userId),
    // Disabling the user is the users store's (README.md "The fake"): here no link signs them in.
    revokeUser: async (userId) => {
      fake.state.revoked.add(userId);
      endSessions(fake.state, userId);
    },
    isSecondFactorEnrolled: async () => false,
  }),
  helpers: (fake) => ({
    /** Every link mailed since the last reset, newest last: a test reads one instead of Mailpit. */
    links: (): readonly SentLink[] => [...fake.state.sent],
    /** A new session of the user, no hook asked: the token its cookie carries (signInAs). */
    createSession: (userId: string): string => {
      // As create(): never in production, on a fake mounted by hand either.
      if (platformConfig.APP_ENV === "production") {
        throw new AppError(authPort.errors.auth_fake_in_production);
      }
      if (typeof userId !== "string" || userId === "") {
        throw new AppError(authPort.codes.input, { details: { method: "createSession" } });
      }
      // revokeUser holds here as on every way in: no new session for the user until reset().
      if (fake.state.revoked.has(userId)) throw new AppError(authPort.errors.auth_invite_required);
      return openSession(fake.state, userId);
    },
  }),
});

export const authFakeAdapter = defineAdapter(authPort, {
  name: "fake",
  create: () => {
    // It signs in whomever allowSignIn allows, with no library behind it: never in production.
    if (platformConfig.APP_ENV === "production") {
      throw new AppError(authPort.errors.auth_fake_in_production);
    }
    return authFake;
  },
});

/**
 * GET LINK_PATH lands on the confirm page and POST LINK_PATH, from the app's own pages, follows the
 * link (../confirm.ts); under APP_ENV=test, POST SIGN_IN_PATH signs an email in; any other request,
 * or one whose URL does not parse, goes on.
 */
function handler(fake: Context): AuthHandler {
  return (req, res, next) => {
    const url = URL.parse(req.url ?? "/", "http://fake.invalid");
    let answer: Promise<Answer>;
    if (url?.pathname === LINK_PATH && req.method === "GET") {
      answer = Promise.resolve(confirmPage(req));
    } else if (url?.pathname === LINK_PATH && req.method === "POST") {
      const token = url.searchParams.get("token") ?? "";
      answer = fromOwnPage(req) ? followLink(fake, token) : Promise.resolve(failed);
    } else if (TEST_MODE && url?.pathname === SIGN_IN_PATH && req.method === "POST") {
      answer = signIn(fake, req, res);
    } else return next();
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

/** Where following a link lands, with a new session's cookie when it signs the user in. */
async function followLink(fake: Context, token: string): Promise<Answer> {
  const key = digest(token);
  const link = fake.state.pending.get(key);
  fake.state.pending.delete(key); // gone before the first await, so a second request finds nothing
  if (!link || link.expiresAt <= Date.now()) return failed;
  // A refusal or a revocation since the link was mailed holds: the link fails as an expired one.
  const userId = await allowedUser(fake, link.email);
  if (userId === undefined) return failed;
  const cookie = setCookie(openSession(fake.state, userId));
  return { status: 303, headers: { location: link.redirectTo, "set-cookie": cookie } };
}

/** POST SIGN_IN_PATH: the email's user, found as following a link finds it, signed in. */
async function signIn(fake: Context, req: IncomingMessage, res: ServerResponse): Promise<Answer> {
  const body = signInBody.safeParse(await readBody(req, res));
  if (!body.success) throw badBody();
  const userId = await allowedUser(fake, body.data.email);
  if (userId === undefined) throw new AppError(authPort.errors.auth_invite_required);
  return { status: 204, headers: { "set-cookie": setCookie(openSession(fake.state, userId)) } };
}

/** The user an email signs in as: undefined when allowSignIn refuses it or the user is revoked. */
async function allowedUser(fake: Context, email: string): Promise<string | undefined> {
  const configured = hooks; // the same hooks for the whole call
  if ((await configured.allowSignIn(email)) !== true) return undefined;
  const user = await configured.users.findOrCreateByEmail(email);
  if (typeof user?.id !== "string" || user.id === "") {
    throw new AppError(authPort.errors.auth_hook_invalid); // a host bug, never a session
  }
  // Checked after the await: a revokeUser while the users store answered holds too.
  return fake.state.revoked.has(user.id) ? undefined : user.id;
}

/**
 * The request's JSON body, read here since the route runs before any body parser of the host:
 * `application/json`, SIGN_IN_BODY_LIMIT bytes at most. A body over the limit, declared or sent, is
 * refused at once and the rest never read; a body a parser consumed already is refused, not
 * awaited; a body cut short, the client gone, is refused too.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json" || req.readableEnded) return Promise.reject(badBody());
  if (Number(req.headers["content-length"] ?? 0) > SIGN_IN_BODY_LIMIT) {
    closeAfterAnswer(req, res);
    return Promise.reject(badBody());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= SIGN_IN_BODY_LIMIT) return void chunks.push(chunk);
      req.off("data", onData).pause();
      closeAfterAnswer(req, res);
      reject(badBody());
    };
    req.on("data", onData).on("error", () => reject(badBody()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badBody());
      }
    });
  });
}

/**
 * No more of the request is read: the answer closes the connection or, when the host answered
 * already, on a timeout say, the request ends here; setting a header then would throw.
 */
function closeAfterAnswer(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) req.destroy();
  else res.setHeader("connection", "close");
}

/** A body that is not `{ email }` as JSON within the limit; nothing of the body is in it. */
function badBody(): AppError {
  const expected = `{ email } as application/json, ${SIGN_IN_BODY_LIMIT} bytes at most`;
  return new AppError(authPort.codes.input, { details: { method: "mountHandler", expected } });
}

/** A new session of the user: the token its cookie carries. */
function openSession(state: State, userId: string): string {
  const token = newToken();
  state.sessions.set(digest(token), {
    id: randomUUID(),
    userId,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  });
  return token;
}

/** The Set-Cookie value that carries a session's token (README.md "The session cookie"). */
function setCookie(token: string): string {
  const { name, path, maxAgeSeconds, httpOnly, sameSite, secure } = authSessionCookie;
  const flags = `${httpOnly ? "; HttpOnly" : ""}; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
  return `${name}=${token}; Path=${path}; Max-Age=${maxAgeSeconds}${flags}`;
}

function endSessions(state: State, userId: string): void {
  for (const [key, session] of state.sessions) {
    if (session.userId === userId) state.sessions.delete(key);
  }
}

/** The token of the first session cookie in a Cookie header. */
function readCookie(header: string | undefined): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === authSessionCookie.name)
      return pair.slice(at + 1).trim();
  }
  return undefined;
}
