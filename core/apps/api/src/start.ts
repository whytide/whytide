// start() (README "Start"): the migrations first, as the owner, then the modules and their onStart,
// the clients, the authentication adapter, Redis and the app; the api listens once all of them stood
// up, never before.
// Redis may be down: the api starts and its health says so (docs/security.md). A failure is logged
// with its code, a failed migration with its name, and thrown: main.ts exits 1.
import type { AddressInfo } from "node:net";
import {
  createDbClient,
  disconnectTenantClient,
  type PrismaClient,
  type RunMigrationsOptions,
  runMigrations,
} from "@whytide/db";
import { AppError, createLogger, isAppError, type Logger, platformConfig } from "@whytide/platform";
import { authConfig, authPort, getAdapter, type PortInstance } from "@whytide/providers";
import { createApp, type Handler } from "./app.ts";
import { apiConfig } from "./config.ts";
import { hostErrors } from "./errors.ts";
import { healthChecks, migrationState } from "./health.ts";
import { moduleLoaders } from "./modules.generated.ts";
import { loadModules, type ModuleLoader, startModules } from "./modules.ts";
import {
  closeRedis,
  connectRedis,
  createProtection,
  type RedisClient,
} from "./protection/index.ts";

/** The host's clients: `app` for the tenant runs and the database check, the owner for the migrations check. */
export type HostClients = { readonly app: PrismaClient; readonly owner: PrismaClient };
export type StartOptions = {
  /** API_PORT by default; 0 picks a free one. */
  readonly port?: number;
  /** For a test: another database or migration set than the owner's variable and db's own. */
  readonly migrations?: RunMigrationsOptions;
  /** The generated list by default. */
  readonly modules?: readonly ModuleLoader[];
  /** Kept open by the caller; the host otherwise makes its own and closes them with the app. */
  readonly clients?: HostClients;
  readonly log?: Logger;
  /** Kept open by the caller; the host otherwise connects its own to REDIS_URL and closes it. */
  readonly redis?: RedisClient;
  /** The rate limits' clock, Date.now unless a test brings its own. */
  readonly now?: () => number;
  /** The authentication adapter, bound: the one PROVIDER_AUTH names unless a test brings its own. */
  readonly auth?: PortInstance<typeof authPort>;
  /** For a test: connect-style handlers ahead of the routes (the e2e api's LinkedIn connect route). */
  readonly mount?: readonly Handler[];
};
export type Api = { readonly url: string; close(): Promise<void> };

/** The migration Prisma names as failed in runMigrations' message; `unknown` when it names none. */
export function failedMigration(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  const named = /^Migration name: (\S+)$/m.exec(text)?.[1];
  const applying = [...text.matchAll(/^Applying migration `([^`]+)`/gm)].at(-1)?.[1];
  const name = named ?? applying;
  return name !== undefined && /^\d{14}_[a-z0-9_]+$/.test(name) ? name : "unknown";
}

export async function start(options: StartOptions = {}): Promise<Api> {
  const log = options.log ?? createLogger();
  let ownRedis: RedisClient | undefined;
  try {
    await migrate(options.migrations, log);
    const modules = await loadModules(options.modules ?? moduleLoaders);
    await startModules(modules, log);
    const clients = options.clients ?? {
      app: createDbClient("app"),
      owner: createDbClient("owner"),
    };
    const auth = options.auth ?? (await getAdapter(authPort, authConfig.PROVIDER_AUTH));
    // The invite-only rule, the mail and the users store (identity's): the port checks their shape.
    if (modules.authHooks) await auth.configure(modules.authHooks);
    const redis = options.redis ?? (await connectRedis(log));
    if (redis !== options.redis) ownRedis = redis;
    const { applied } = await migrationState(clients.owner);
    const checks = healthChecks({ ...clients, migrations: applied, redis });
    const protection = createProtection({ redis, log, now: options.now });
    const health = { checks, log };
    const { mount } = options;
    const app = await createApp({
      modules,
      auth,
      app: clients.app,
      health,
      log,
      protection,
      mount,
    });
    // A laptop's api answers itself only; a container's, its proxy (alpha-p10-070).
    const host = platformConfig.APP_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
    await app.listen(options.port ?? apiConfig.API_PORT, host);
    const { port } = app.getHttpServer().address() as AddressInfo;
    log.info({ port }, "api: listening");
    return {
      url: `http://127.0.0.1:${port}`,
      // The server stops taking requests and lets the running ones end; then the clients close,
      // with db's default one, which a module's own withTenant may have opened.
      close: async () => {
        await app.close();
        if (ownRedis) closeRedis(ownRedis);
        if (options.clients) return;
        const own = [clients.app.$disconnect(), clients.owner.$disconnect()];
        await Promise.all([...own, disconnectTenantClient()]);
      },
    };
  } catch (error) {
    if (ownRedis) closeRedis(ownRedis);
    const logged = isAppError(error) && error.code === hostErrors.migration_failed;
    if (!logged) log.fatal({ err: error }, "api: the start failed, so the api does not listen");
    throw error;
  }
}

async function migrate(options: RunMigrationsOptions | undefined, log: Logger): Promise<void> {
  try {
    const applied = await runMigrations(options);
    log.info({ applied_count: applied.length }, "api: migrations applied");
  } catch (error) {
    const migration = failedMigration(error);
    const failure = new AppError(hostErrors.migration_failed, { details: { migration } });
    log.fatal({ err: failure, migration }, "api: a migration failed, so the api does not listen");
    throw failure;
  }
}
