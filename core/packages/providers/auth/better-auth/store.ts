// The database Better Auth runs on (README.md "Provider refs"): its Prisma adapter for sessions,
// accounts and verifications, wrapped so that its user model never reaches a table. Users are the
// port's users hook's: Better Auth finds none by email, so following a link creates one, and
// creating one asks allowSignIn again, takes the hook's user and refuses a disabled or revoked one;
// a session's user is its id. A session is stored under the SHA-256 of its token, and read back
// with the token asked for. Every adapter Better Auth gets, a transaction's included, is wrapped
// the same way.
import { createHash } from "node:crypto";
import { AppError } from "@whytide/platform";
import type { DBAdapter, Where } from "better-auth/types";
import { type AuthHooks, authPort } from "../port.ts";

/** Thrown inside Better Auth when a link's email is refused or its user revoked: the link fails. */
export class LinkRefused extends Error {}

export type Users = {
  /** The hooks configure() set last. */
  readonly hooks: () => AuthHooks;
  /** Whether revokeUser revoked the user of the users store in use. */
  readonly revoked: (userId: string) => boolean;
};

type Row = Record<string, unknown>;
type Args = { model: string; where?: Where[]; data?: Row; join?: Record<string, unknown> };
type Method = (args: Args) => Promise<unknown>;

export const digest = (token: string) => createHash("sha256").update(token).digest("base64url");

/** The where with each session token replaced by its digest. */
const hashed = (where: Where[] = []): Where[] =>
  where.map((w) => {
    if (w.field !== "token") return w;
    const value = Array.isArray(w.value)
      ? w.value.map(String).map(digest)
      : digest(String(w.value));
    return { ...w, value };
  });

/** The token a where asks for by equality, to put back in place of the digest. */
const tokenIn = (where: Where[] = []): string | undefined => {
  const match = where.find((w) => w.field === "token" && (w.operator ?? "eq") === "eq");
  return typeof match?.value === "string" ? match.value : undefined;
};

/** A session's user as Better Auth reads it back: the id, and its schema's required fields. */
const userOf = (session: Row): Row => ({
  id: session.userId,
  email: "",
  name: "",
  emailVerified: true,
  image: null,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

export function wrapAdapter(inner: DBAdapter, users: Users): DBAdapter {
  /** The user a followed link signs in: the hook's, asked as the fake asks it. */
  async function signIn(data: Row): Promise<Row> {
    const email = String(data.email);
    const hooks = users.hooks(); // the same hooks for the whole call
    if ((await hooks.allowSignIn(email)) !== true) throw new LinkRefused();
    const user = await hooks.users.findOrCreateByEmail(email);
    if (typeof user?.id !== "string" || user.id === "") {
      throw new AppError(authPort.errors.auth_hook_invalid); // a host bug, never a session
    }
    if (user.disabledAt || users.revoked(user.id)) throw new LinkRefused();
    const name = typeof data.name === "string" ? data.name : "";
    return { ...userOf({ userId: user.id, ...data }), email, name };
  }

  const wrap = (a: DBAdapter): DBAdapter => {
    const call = (method: keyof DBAdapter) => a[method] as unknown as Method;
    /** A session operation: the where hashed, the token asked for put back, the user joined. */
    const onSessions =
      (method: keyof DBAdapter): Method =>
      async ({ join, ...args }) => {
        const result = await call(method)({ ...args, where: hashed(args.where) });
        const token = tokenIn(args.where);
        const back = (row: Row) => ({
          ...row,
          ...(token === undefined ? {} : { token }),
          ...(join?.user ? { user: userOf(row) } : {}),
        });
        if (Array.isArray(result)) return result.map(back);
        return result !== null && typeof result === "object" ? back(result as Row) : result;
      };
    const createSession: Method = async (args) => {
      const data = args.data ?? {};
      const userId = String(data.userId);
      // revokeUser marks the user before it ends the sessions: one opened meanwhile goes too.
      if (users.revoked(userId)) throw new LinkRefused();
      const token = String(data.token);
      const row = (await call("create")({
        ...args,
        data: { ...data, token: digest(token) },
      })) as Row;
      if (users.revoked(userId)) {
        await call("delete")({ model: "session", where: [{ field: "id", value: String(row.id) }] });
        throw new LinkRefused();
      }
      return { ...row, token };
    };
    /** One method for every model: the user model's own answer, sessions hashed, the rest as is. */
    const route =
      (method: keyof DBAdapter, user: Method, session = onSessions(method)): Method =>
      (args) => {
        if (args.model === "user") return user(args);
        return args.model === "session" ? session(args) : call(method)(args);
      };
    const refused: Method = async () => {
      throw new Error("the users table is tenancy's: Better Auth writes nothing there");
    };
    const transaction = a.transaction;
    return {
      ...a,
      create: route("create", async (args) => signIn(args.data ?? {}), createSession),
      findOne: route("findOne", async () => null),
      findMany: route("findMany", async () => []),
      count: route("count", async () => 0),
      update: route("update", refused),
      updateMany: route("updateMany", refused),
      delete: route("delete", refused),
      deleteMany: route("deleteMany", refused),
      consumeOne: route("consumeOne", refused),
      incrementOne: route("incrementOne", refused),
      ...(transaction && {
        transaction: (callback: (trx: DBAdapter) => Promise<unknown>) =>
          transaction((trx) => callback(wrap(trx as DBAdapter))),
      }),
    } as unknown as DBAdapter;
  };
  return wrap(inner);
}
