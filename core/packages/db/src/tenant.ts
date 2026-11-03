// The tenant transaction and the scoped client (docs/rules/security.md §3; architecture §5, §6; the
// context is core/packages/platform/tenant). withTenant opens an interactive transaction on the `app`
// client, sets app.workspace_id and app.user_id for that transaction only with set_config(…, true),
// the bindable form of SET LOCAL, so no id ever enters the SQL text, runs `fn` in the platform's
// tenant context, and commits, or rolls back on a throw. The client `fn` gets, and tenantClient for
// code deep in a module, add the workspace to every where, cursor and new row of a tenant model and
// throw no_tenant_context outside their own run; globalClient() reaches the global tables inside
// withoutTenant(reason), outside any run, and nothing else. Both refuse what they cannot scope: a
// model the generated list does not name (src/tenant-models.ts), a relation in any argument, raw
// SQL in the unsafe forms or, by a tripwire on its text, naming the two settings. Scoping by code:
// the policies reading the settings are zeta's.
import {
  AppError,
  currentTenant,
  currentTenantScope,
  insideTenantRun,
  type TenantContext,
  tenantErrors,
  withTenantContext,
} from "@whytide/platform";
import type { Prisma, PrismaClient } from "../generated/client.ts";
import { modelScopes } from "../generated/tenant-models.ts";
import { createDbClient } from "./client.ts";
import type { ModelScopes } from "./tenant-models.ts";

/** Prisma's transaction client: the guard changes what runs, not the methods. */
export type TenantClient = Prisma.TransactionClient;
export type WithTenantOptions = {
  /** The client to open the transaction on: one `createDbClient("app")` per process by default. */
  readonly client?: PrismaClient;
  /** Prisma's limits on the transaction, in milliseconds: 5 000 to run, 2 000 to start. */
  readonly timeout?: number;
  readonly maxWait?: number;
};
type Args = Record<string, unknown>;

/** The operations whose where gets the workspace: every read, update and delete. */
const WHERE = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
const CREATE = new Set(["create", "createMany", "createManyAndReturn"]);
const UPDATE = new Set(["update", "updateMany", "updateManyAndReturn"]);
/** The keys of a where through which a relation filter can hide. */
const LOGICAL = new Set(["AND", "OR", "NOT"]);
/** The settings withTenant owns, in a tagged raw query's text as bare() leaves it, or a whole value. */
const SETTINGS_TEXT = /app\.(?:workspace_id|user_id)/;
const SETTINGS_VALUE = /^\s*app\.(?:workspace_id|user_id)\s*$/i;
/** A block comment with none inside it, so nested ones go innermost first, or a line comment. */
const COMMENT = /\/\*(?:(?!\/\*)[\s\S])*?\*\/|--[^\n]*/g;

let app: PrismaClient | undefined;
const globalClients = new WeakMap<PrismaClient, TenantClient>();
const transactions = new WeakMap<TenantContext, TenantClient>();
/** The runs setting their context: the only raw SQL naming the settings that runs. */
const opening = new WeakSet<TenantContext>();
const appClient = () => (app ??= createDbClient("app"));

/**
 * Runs `fn` in one transaction for the workspace and the principal, with the scoped client; commits
 * when `fn` resolves, rolls back when it throws. Worker code passes its workflow input's workspace
 * and `servicePrincipal(name)`; the api host the URL's workspace and the request's principal. Inside
 * a run, also through a withoutTenant inside it, it is `tenant_query_refused` (`nested_run`): a second
 * run would hold a second connection, commit on its own and could wait on a lock its outer run holds.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (tx: TenantClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  if (insideTenantRun()) throw refused("nested_run");
  const { timeout, maxWait } = options;
  const client = options.client ?? appClient();
  return withTenantContext(context, () => {
    const tenant = currentTenant();
    return scopedTo(client, tenant).$transaction(
      async (itx) => {
        // A query extension changes what runs, not the methods: the transaction client's own type.
        const tx = itx as unknown as TenantClient;
        opening.add(tenant);
        try {
          await tx.$executeRaw`SELECT set_config('app.workspace_id', ${tenant.workspaceId}, true),
            set_config('app.user_id', ${tenant.principal.userId}, true)`;
        } finally {
          opening.delete(tenant);
        }
        transactions.set(tenant, tx);
        try {
          return await fn(tx);
        } finally {
          transactions.delete(tenant);
        }
      },
      { timeout, maxWait },
    );
  });
}

/**
 * The client of the withTenant around the caller, for code deep in a module:
 * `tenantClient.costEvent.findMany()` runs in that transaction, scoped. Outside withTenant, reading
 * any property throws no_tenant_context.
 */
export const tenantClient: TenantClient = new Proxy({} as TenantClient, {
  get(_target, key) {
    const tx = transactions.get(currentTenant());
    if (!tx) throw new AppError(tenantErrors.no_tenant_context);
    const value: unknown = Reflect.get(tx, key);
    return typeof value === "function" ? value.bind(tx) : value;
  },
});

/**
 * The global tables, outside a transaction, inside withoutTenant(reason) only; never a tenant table.
 * Inside a run, also through a withoutTenant, it is `nested_run`: the run's own client reads them.
 */
export function globalClient(client: PrismaClient = appClient()): TenantClient {
  let global = globalClients.get(client);
  if (!global) {
    global = globalOnly(client) as unknown as TenantClient;
    globalClients.set(client, global);
  }
  return global;
}

/**
 * Ends the default `app` client, for a host's shutdown once its in-flight runs have settled; the
 * next run opens a new one.
 */
export async function disconnectTenantClient(): Promise<void> {
  const client = app;
  app = undefined;
  await client?.$disconnect();
}

/**
 * One model operation's arguments as a guard runs them, or the refusal; pure, for both guards and
 * their tests. With the run's workspace, a tenant model is scoped and a global one runs as written;
 * without one (the global client), a tenant model is no_tenant_context. A model the list does not
 * name, a relation in any argument and a marked model without its column are tenant_query_refused.
 */
export function scopeQuery(
  scopes: ModelScopes,
  model: string,
  operation: string,
  args: Args,
  workspaceId?: string,
): Args {
  const scope = Object.hasOwn(scopes, model) ? scopes[model] : undefined;
  if (scope === undefined) throw refused("unknown_model", { model });
  const relation = relationIn(scope.relations, args);
  if (relation !== undefined) throw refused("relation", { model, field: relation });
  if (!scope.tenant) return args;
  if (workspaceId === undefined) throw new AppError(tenantErrors.no_tenant_context);
  if (scope.field === null) throw refused("no_workspace_column", { model });
  return scoped(model, operation, args, scope.field, workspaceId);
}

/**
 * The client of one withTenant run, its guard on every operation, raw SQL included: inside that
 * run only, a model's query goes through scopeQuery and raw SQL through checkRaw.
 */
function scopedTo(client: PrismaClient, tenant: TenantContext) {
  return client.$extends({
    name: "tenant",
    query: {
      async $allOperations({ model, operation, args, query }) {
        const scope = currentTenantScope();
        if (scope?.kind !== "tenant" || scope.context !== tenant) {
          throw new AppError(tenantErrors.no_tenant_context);
        }
        if (model === undefined) {
          if (!opening.has(tenant)) checkRaw(operation, args);
          return query(args);
        }
        return query(scopeQuery(modelScopes, model, operation, args, tenant.workspaceId));
      },
    },
  });
}

/**
 * The global client's guard: a global model, inside withoutTenant and outside any run only; no raw
 * SQL. Inside a run it would wait on the run's locks and connection and miss its uncommitted rows.
 */
function globalOnly(client: PrismaClient) {
  return client.$extends({
    name: "tenant_global",
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (insideTenantRun()) throw refused("nested_run");
        if (currentTenantScope()?.kind !== "global" || model === undefined) {
          throw new AppError(tenantErrors.no_tenant_context);
        }
        return query(scopeQuery(modelScopes, model, operation, args));
      },
    },
  });
}

/**
 * A tenant model's arguments with the workspace ANDed into the where and set in the cursor, so the
 * caller's own, a workspace_id in them included, can only narrow them; set on every new row; and a
 * row named in another workspace, or moved to one, refused as tenant_mismatch with the run's own
 * workspace. An operation not listed is refused.
 */
function scoped(model: string, operation: string, args: Args, field: string, workspaceId: string) {
  const own = (row: unknown): Args => {
    const value = (row as Args | undefined)?.[field];
    if (value !== undefined && value !== workspaceId) {
      throw new AppError(tenantErrors.tenant_mismatch, { details: { workspace_id: workspaceId } });
    }
    return { ...(row as Args), [field]: workspaceId };
  };
  const next: Args = { ...args };
  if (WHERE.has(operation)) {
    const where = (args.where ?? {}) as Args;
    next.where = { ...where, AND: [...[where.AND ?? []].flat(), { [field]: workspaceId }] };
    if (args.cursor !== undefined) next.cursor = { ...(args.cursor as Args), [field]: workspaceId };
  } else if (!CREATE.has(operation)) {
    throw refused("unknown_operation", { model, operation });
  }
  if (CREATE.has(operation)) {
    next.data = Array.isArray(args.data) ? args.data.map(own) : own(args.data);
  }
  if (UPDATE.has(operation)) own(args.data);
  if (operation === "upsert") {
    next.create = own(args.create);
    own(args.update);
  }
  return next;
}

/**
 * The first relation field an argument names, at any depth of AND, OR and NOT in a where or a cursor,
 * at the top of data, create, update, orderBy, select and include, and `_count` in the last two: the
 * guards scope the queried model only, so a relation would reach another workspace's rows.
 */
function relationIn(relations: readonly string[], args: Args): string | undefined {
  const objects = (value: unknown) =>
    [value].flat().filter((item): item is Args => typeof item === "object" && item !== null);
  const inWhere = (where: unknown): string | undefined => {
    for (const [key, value] of objects(where).flatMap((item) => Object.entries(item))) {
      const found = relations.includes(key) ? key : LOGICAL.has(key) ? inWhere(value) : undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const inKeys = (value: unknown, count = false) =>
    objects(value)
      .flatMap((item) => Object.keys(item))
      .find((key) => relations.includes(key) || (count && key === "_count"));
  return (
    inWhere(args.where) ??
    inWhere(args.cursor) ??
    inKeys(args.data) ??
    inKeys(args.create) ??
    inKeys(args.update) ??
    inKeys(args.orderBy) ??
    inKeys(args.select, true) ??
    inKeys(args.include, true)
  );
}

/**
 * Raw SQL through the tenant client: the tagged `$queryRaw` and `$executeRaw` only, and none that
 * names app.workspace_id or app.user_id in its text, read with and without its comments, or as a
 * whole value. A tripwire for a careless query, not a parser; it runs as written otherwise.
 */
function checkRaw(operation: string, args: unknown): void {
  const { strings, values } = (args ?? {}) as { strings?: unknown; values?: unknown };
  const tagged = operation === "$queryRaw" || operation === "$executeRaw";
  if (!tagged || !Array.isArray(strings) || !Array.isArray(values)) {
    throw refused("raw_unsafe", { operation });
  }
  // Read with the comments too: a `/*` inside a string is none, and cutting from it hides the name.
  const text = strings.join(" ");
  const named =
    [text, withoutComments(text)].some((sql) => SETTINGS_TEXT.test(bare(sql))) ||
    values.some((value) => typeof value === "string" && SETTINGS_VALUE.test(value));
  if (named) throw refused("raw_settings", { operation });
}

/** The text with each comment a space, as Postgres reads it, nested ones innermost first. */
function withoutComments(sql: string): string {
  let text = sql;
  for (let last = ""; text !== last; ) {
    last = text;
    text = text.replace(COMMENT, " ");
  }
  return text;
}

/** Without double quotes, whitespace or case: `SET "App" . workspace_id` reads app.workspace_id. */
function bare(sql: string): string {
  return sql.replace(/["\s]/g, "").toLowerCase();
}

function refused(reason: string, details: Record<string, string> = {}): AppError {
  return new AppError(tenantErrors.tenant_query_refused, { details: { reason, ...details } });
}
