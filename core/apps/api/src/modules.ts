// The modules (README "Modules"): every core/modules/<name>/index.ts, loaded at start from the list
// `pnpm modules:generate` writes, never one kept by hand. Loading registers what a module declares,
// since its permissions, events, errors, ids and settings call the platform's define* functions as
// they load; the host takes the rest from the exports: `api`, a NestJS module mounted under
// /v1/workspaces/:workspaceId/<name>; `accountApi`, one mounted under /v1, outside the workspaces
// (GET /v1/me); `workspaceResolver` and `authHooks`, which one module at most exports each;
// `webhooks`, its vendors' calls at /v1/<name>/webhooks/:provider (webhooks.ts); and `onStart`,
// awaited after the migrations and before the api listens (credits' seeder).
import type { Type } from "@nestjs/common";
import { AppError, isAppError, type Logger } from "@whytide/platform";
import type { AuthHooks } from "@whytide/providers";
import { hostErrors } from "./errors.ts";
import { JSON_BODY_LIMIT } from "./protection/body.ts";
import type { ModuleWebhooks } from "./webhooks.ts";
import { denyEveryWorkspace, type WorkspaceResolver } from "./workspace.ts";

export type ModuleLoader = { readonly name: string; readonly load: () => Promise<unknown> };
/** A module's start hook, given the host's logger. */
export type StartHook = (context: { readonly log: Logger }) => Promise<void>;
export type HostModules = {
  readonly apis: readonly { readonly name: string; readonly api: Type }[];
  readonly accountApis: readonly Type[];
  readonly workspaceResolver: WorkspaceResolver;
  /** What start() passes to the authentication port's configure(); none leaves it refusing everyone. */
  readonly authHooks?: AuthHooks;
  readonly starts: readonly { readonly name: string; readonly onStart: StartHook }[];
  /** By module name: the modules that take a vendor's webhooks. */
  readonly webhooks: ReadonlyMap<string, ModuleWebhooks>;
};
/** The exports one module at most may make, with the type each must have. */
const SINGLE = { workspaceResolver: "function", authHooks: "object" } as const;

export async function loadModules(loaders: readonly ModuleLoader[]): Promise<HostModules> {
  const apis: { name: string; api: Type }[] = [];
  const accountApis: Type[] = [];
  const starts: { name: string; onStart: StartHook }[] = [];
  const webhooks = new Map<string, ModuleWebhooks>();
  const single: { -readonly [K in keyof typeof SINGLE]?: { module: string; value: unknown } } = {};
  for (const { name, load } of loaders) {
    const invalid = (field: string, cause?: unknown) =>
      new AppError(hostErrors.module_invalid, { details: { module: name, field }, cause });
    const exports = (await load().catch((error: unknown) => {
      // Settings that fail as a module loads stop the start with the platform's config_invalid as it
      // is: it names the block and the variables, whichever module imported the settings first.
      if (isAppError(error) && error.code === "config_invalid") throw error;
      throw invalid("index", error);
    })) as Record<string, unknown>;
    const { api, accountApi, onStart, webhooks: hooks } = exports;
    if (api !== undefined) {
      if (typeof api !== "function") throw invalid("api");
      apis.push({ name, api: api as Type });
    }
    if (accountApi !== undefined) {
      // RouterModule keeps one path per class: as `api` too, the workspace routes would lose theirs.
      if (typeof accountApi !== "function" || accountApi === api) throw invalid("accountApi");
      accountApis.push(accountApi as Type);
    }
    for (const [field, type] of Object.entries(SINGLE) as [keyof typeof SINGLE, string][]) {
      const value = exports[field];
      if (value === undefined) continue;
      if (typeof value !== type || value === null) throw invalid(field);
      const taken = single[field];
      if (taken) {
        const details = { field, sources: [taken.module, name] };
        throw new AppError(hostErrors.duplicate_registration, { details });
      }
      single[field] = { module: name, value };
    }
    if (hooks !== undefined) {
      const { bodyLimit, receive } = (hooks ?? {}) as Partial<ModuleWebhooks>;
      const limit = typeof bodyLimit === "number" && Number.isInteger(bodyLimit) && bodyLimit > 0;
      if (!limit || bodyLimit > JSON_BODY_LIMIT || typeof receive !== "function") {
        throw invalid("webhooks");
      }
      webhooks.set(name, hooks as ModuleWebhooks);
    }
    if (onStart !== undefined) {
      if (typeof onStart !== "function") throw invalid("onStart");
      starts.push({ name, onStart: onStart as StartHook });
    }
  }
  const resolve = single.workspaceResolver?.value as WorkspaceResolver | undefined;
  const authHooks = single.authHooks?.value as AuthHooks | undefined;
  const workspaceResolver = resolve ?? denyEveryWorkspace;
  return { apis, accountApis, workspaceResolver, authHooks, starts, webhooks };
}

/** Each module's onStart, in the modules' order; a throw is `module_invalid` with the module's name. */
export async function startModules(modules: HostModules, log: Logger): Promise<void> {
  for (const { name, onStart } of modules.starts) {
    try {
      await onStart({ log });
    } catch (cause) {
      const details = { module: name, field: "onStart" };
      throw new AppError(hostErrors.module_invalid, { details, cause });
    }
  }
}
