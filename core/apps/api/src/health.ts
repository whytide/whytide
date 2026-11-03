// GET /health and GET /health/live (README "Health"). registerHealthCheck is the registration point:
// a check is built per app from the host's clients, runs with a timeout and once at a time, however
// many callers wait on it. The host registers its own two here, the database as `app` and the
// migrations; alpha-p2-030 adds Redis and alpha-p2-050 Temporal, each with its client. /health
// answers 200 with the checks and the build version, 503 naming the failing ones; /health/live runs
// no check.
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { PrismaClient } from "@whytide/db";
import { AppError, type Logger } from "@whytide/platform";
import { z } from "zod";
import { ApiRoute } from "../openapi/route.ts";
import { hostErrors } from "./errors.ts";
import { Public } from "./principal.ts";
import type { RedisClient } from "./protection/redis.ts";

export type HealthCheck = () => Promise<void>;
/** What a check is built from: the host's clients and the migrations applied when it started. */
export type HealthHost = {
  readonly app: PrismaClient;
  readonly owner: PrismaClient;
  readonly migrations: number;
  readonly redis: RedisClient;
};
type Registration = { readonly create: (host: HealthHost) => HealthCheck; readonly source: string };
export type Health = { readonly checks: ReadonlyMap<string, HealthCheck>; readonly log: Logger };

const TIMEOUT_MS = 2000;
const registry = new Map<string, Registration>();
/** The build's version: the api package's, which the release's changesets set. */
const version = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
export const HEALTH = Symbol("health");
const outcome = z.enum(["ok", "failing"]);
const healthAnswer = z.strictObject({
  status: outcome,
  version: z.string(),
  checks: z.record(z.string(), outcome),
  failing: z.array(z.string()).optional(),
});

/** Registers a check under `name`; `source` is the registering file's import.meta.url. */
export function registerHealthCheck(
  name: string,
  create: (host: HealthHost) => HealthCheck,
  source: string,
): void {
  const existing = registry.get(name);
  if (existing) {
    const sources = [existing.source, source];
    throw new AppError(hostErrors.duplicate_registration, { details: { check: name, sources } });
  }
  registry.set(name, { create, source });
}

export const registeredHealthChecks = (): ReadonlyMap<string, Registration> => registry;

/** The registered checks built for one app, each one at a time. */
export function healthChecks(host: HealthHost): ReadonlyMap<string, HealthCheck> {
  return new Map([...registry].map(([name, { create }]) => [name, oneAtATime(create(host))]));
}

/** Applied and unfinished (failed or running) migrations, read as the owner: `app` cannot. */
export async function migrationState(owner: PrismaClient) {
  const [row] = await owner.$queryRaw<{ applied: number; unfinished: number }[]>`
    SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,
           count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished
    FROM _prisma_migrations`;
  return row ?? { applied: 0, unfinished: 0 };
}

registerHealthCheck(
  "database",
  ({ app }) =>
    async () => {
      await app.$queryRaw`SELECT 1`;
    },
  import.meta.url,
);
// Current: none failed or half-applied, and none of those applied at start gone (a restore).
registerHealthCheck(
  "migrations",
  ({ owner, migrations }) =>
    async () => {
      const { applied, unfinished } = await migrationState(owner);
      if (unfinished > 0 || applied < migrations) throw new AppError(hostErrors.migration_failed);
    },
  import.meta.url,
);

@Public()
@Controller("health")
export class HealthController {
  readonly #health: Health;

  constructor(@Inject(HEALTH) health: Health) {
    this.#health = health;
  }

  @Get()
  @ApiRoute({
    summary:
      "Runs the registered checks: 200 with each one and the version, 503 naming the failing",
    response: healthAnswer,
  })
  async health(@Res() res: ServerResponse): Promise<void> {
    const results = await Promise.all(
      [...this.#health.checks].map(async ([name, check]) => [name, await this.#run(name, check)]),
    );
    const failing = results.filter(([, outcome]) => outcome === "failing").map(([name]) => name);
    const status = failing.length ? "failing" : "ok";
    const body = { status, version, checks: Object.fromEntries(results) };
    send(res, failing.length ? 503 : 200, failing.length ? { ...body, failing } : body);
  }

  @Get("live")
  @ApiRoute({
    summary: "Answers while the process runs, without running a check",
    response: z.strictObject({ status: z.literal("ok") }),
  })
  live(@Res() res: ServerResponse): void {
    send(res, 200, { status: "ok" });
  }

  async #run(name: string, check: HealthCheck): Promise<"ok" | "failing"> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(hostErrors.internal_error)), TIMEOUT_MS);
    });
    try {
      await Promise.race([check(), timeout]);
      return "ok";
    } catch (error) {
      this.#health.log.warn({ check: name, err: error }, "api: health check failing");
      return "failing";
    } finally {
      clearTimeout(timer);
    }
  }
}

function oneAtATime(check: HealthCheck): HealthCheck {
  let running: Promise<void> | undefined;
  return () => {
    running ??= check().finally(() => {
      running = undefined;
    });
    return running;
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
