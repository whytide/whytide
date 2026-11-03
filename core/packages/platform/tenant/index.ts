// The tenant context (docs/rules/security.md §3; architecture §5, §6): every request and every
// background job runs for one workspace, set per transaction from the URL or a workflow's input and
// never from a cache. This is the half that needs no database: what runs on this async path
// (AsyncLocalStorage), currentTenant() for code deep in a module, and withoutTenant(reason), the one
// logged way to the few global tables. A run's scope ends when its function settles, so a timer or a
// promise it leaves behind finds none. The transaction that sets the context and the client that
// refuses to run without it are core/packages/db's (src/tenant.ts); the platform never imports it.
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError, defineErrors } from "../errors/index.ts";
import { createLogger, type Logger } from "../logging/index.ts";
import type { Principal } from "../principal/index.ts";

/** One workspace and who acts in it, from the URL or a workflow's input. */
export type TenantContext = { readonly workspaceId: string; readonly principal: Principal };
/** What runs on this async path: one workspace, or global tables only, for a logged reason. */
export type TenantScope =
  | { readonly kind: "tenant"; readonly context: TenantContext }
  | { readonly kind: "global"; readonly reason: string };

/** Each one is a bug in the calling code, so 500; `tenant_query_refused` names why in `details.reason`. */
export const tenantErrors = defineErrors({
  no_tenant_context: {},
  tenant_mismatch: {},
  tenant_query_refused: {},
  invalid_tenant_reason: { status: 500 },
});

/**
 * A scope while its function runs: `active` turns false when it settles. `outer` is the nearest run
 * around it still open, checked again when it ends: an ended run never reopens, so skipping one
 * changes no answer, and a loop that starts each step inside the last one keeps no chain of them.
 */
type Run = { readonly scope: TenantScope; outer: Run | undefined; active: boolean };
const runs = new AsyncLocalStorage<Run>();
/** `tenancy` or `tenancy.sign_in`: the reason is logged, so it is an identifier, never data. */
const REASON = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
let sharedLog: Logger | undefined;

/**
 * Runs `fn` in the workspace: currentTenant() returns the context on this async path until `fn`
 * settles. This is the context half of withTenant (core/packages/db), which opens the transaction
 * around it; on its own it opens none, so the tenant client still refuses to run. It checks no
 * membership, `can()` does: an empty workspace or user is `no_tenant_context`, and a principal
 * resolved for another workspace `tenant_mismatch`, with no details.
 */
export function withTenantContext<T>(context: TenantContext, fn: () => T): T {
  const { workspaceId, principal } = context;
  if (!isText(workspaceId) || !isText(principal?.userId)) {
    throw new AppError(tenantErrors.no_tenant_context);
  }
  if (principal.workspaceId !== undefined && principal.workspaceId !== workspaceId) {
    throw new AppError(tenantErrors.tenant_mismatch);
  }
  return inScope({ kind: "tenant", context: Object.freeze({ workspaceId, principal }) }, fn);
}

/** The workspace and the principal this code runs for; `no_tenant_context` outside withTenant. */
export function currentTenant(): TenantContext {
  const scope = currentTenantScope();
  if (scope?.kind === "tenant") return scope.context;
  throw new AppError(tenantErrors.no_tenant_context);
}

/** The scope on this async path while its function runs, for the tenant client's guard (core/packages/db). */
export function currentTenantScope(): TenantScope | undefined {
  const run = runs.getStore();
  return run?.active ? run.scope : undefined;
}

/**
 * Whether a tenant run is still open around this code, also through a withoutTenant inside it:
 * withTenant (core/packages/db) refuses a second run there.
 */
export function insideTenantRun(): boolean {
  for (let run = runs.getStore(); run !== undefined; run = run.outer) {
    if (run.active && run.scope.kind === "tenant") return true;
  }
  return false;
}

/**
 * Runs `fn` outside any workspace, for the global tables only (users, organizations, workspaces),
 * and logs the reason: the tenant client refuses every tenant table and raw SQL in it, and
 * currentTenant() throws. The reason names the module or the purpose, `tenancy`, never data.
 */
export function withoutTenant<T>(reason: string, fn: () => T, options: { log?: Logger } = {}): T {
  if (typeof reason !== "string" || !REASON.test(reason)) {
    throw new AppError(tenantErrors.invalid_tenant_reason);
  }
  const log = options.log ?? (sharedLog ??= createLogger());
  log.info({ reason }, "tenant: running without a tenant context");
  return inScope({ kind: "global", reason }, fn);
}

/** Runs `fn` in the scope until it settles: at once for a value or a throw, else with its promise. */
function inScope<T>(scope: TenantScope, fn: () => T): T {
  const run: Run = { scope, outer: nearestOpen(runs.getStore()), active: true };
  const end = () => {
    run.active = false;
    run.outer = nearestOpen(run.outer);
  };
  return runs.run(run, () => {
    let result: T;
    try {
      result = fn();
    } catch (error) {
      end();
      throw error;
    }
    if (!isThenable(result)) {
      end();
      return result;
    }
    return Promise.resolve(result).finally(end) as T;
  });
}

/** The run if it is still open, else the nearest open run around it. */
function nearestOpen(run: Run | undefined): Run | undefined {
  let found = run;
  while (found !== undefined && !found.active) found = found.outer;
  return found;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
