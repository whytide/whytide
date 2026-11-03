// The rate limits (docs/security.md): a sliding window of one minute in Redis, per workspace on
// /v1/workspaces/… (after the workspace guard, so only a member's requests count) and per client
// address on /api/auth/… (ahead of the authentication handler) and on a module's webhook (webhooks.ts). Each key holds one counter per
// fixed minute; a request counts the current minute plus the previous one weighted by the share of
// the last sixty seconds still inside it, so the limit holds across minute boundaries without a
// list of timestamps. Over the limit: 429 rate_limited with Retry-After, the request not counted.
// When Redis does not answer, the request goes through: the counter (api.rate_limit.decisions) says
// so and /health fails.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { AppError, type Logger } from "@whytide/platform";
import { apiMetrics } from "../metrics.ts";
import { type HostRequest, requestState } from "../request-context.ts";
import { protectionErrors } from "./errors.ts";
import type { RedisClient } from "./redis.ts";

export const WINDOW_MS = 60_000;
/** The sign-in links one email may ask for a minute (src/sign-in.ts). */
export const SIGN_IN_PER_EMAIL_PER_MIN = 3;
export type RateLimitKind = "workspace" | "auth" | "webhook" | "email";
export type WindowState = {
  readonly limit: number;
  readonly windowMs: number;
  /** Time since the current window began. */
  readonly elapsedMs: number;
  /** The requests counted in the previous window, and in the current one before this request. */
  readonly previous: number;
  readonly current: number;
};
export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

/** Whether one more request fits and, when it does not, how long until one would; pure. */
export function slidingWindow(state: WindowState): Decision {
  const { limit, windowMs, elapsedMs, previous, current } = state;
  const estimate = (previous * (windowMs - elapsedMs)) / windowMs + current + 1;
  if (estimate <= limit) return { allowed: true };
  // Within this window, once the previous one's weight has fallen far enough;
  if (current + 1 <= limit) {
    const at = (windowMs * (previous + current + 1 - limit)) / previous;
    return { allowed: false, retryAfterMs: Math.ceil(at - elapsedMs) };
  }
  // otherwise in the next, where this window's count is the previous one.
  const at = (windowMs * (current + 1 - limit)) / current;
  return { allowed: false, retryAfterMs: Math.ceil(windowMs - elapsedMs + at) };
}

export type RateLimiterOptions = {
  readonly redis: RedisClient;
  /** REDIS_PREFIX: the keys are `<prefix>rate:<kind>:<id>:<minute>`. */
  readonly prefix: string;
  readonly limits: Readonly<Record<RateLimitKind, number>>;
  readonly log: Logger;
  /** Date.now unless a test brings its own clock. */
  readonly now?: () => number;
};

export class RateLimiter {
  readonly #options: RateLimiterOptions;
  readonly #now: () => number;
  #warnedAt = Number.NEGATIVE_INFINITY;

  constructor(options: RateLimiterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Counts the request against `id`; over the limit, Retry-After on `res` and rate_limited. */
  async enforce(kind: RateLimitKind, id: string, res: ServerResponse): Promise<void> {
    const decision = await this.#decide(kind, id);
    const outcome =
      decision === undefined ? "unavailable" : decision.allowed ? "allowed" : "limited";
    apiMetrics["api.rate_limit.decisions"].add(1, { kind, outcome });
    if (decision === undefined || decision.allowed) return;
    res.setHeader("retry-after", String(Math.ceil(decision.retryAfterMs / 1000)));
    throw new AppError(protectionErrors.rate_limited);
  }

  /** The decision, or undefined when Redis did not answer. */
  async #decide(kind: RateLimitKind, id: string): Promise<Decision | undefined> {
    const { redis, prefix, limits } = this.#options;
    const now = this.#now();
    const minute = Math.floor(now / WINDOW_MS);
    const key = (index: number) => `${prefix}rate:${kind}:${id}:${index}`;
    let counts: unknown[];
    try {
      counts = await redis
        .multi()
        .incr(key(minute))
        .pExpire(key(minute), 2 * WINDOW_MS)
        .get(key(minute - 1))
        .exec();
    } catch (error) {
      this.#unavailable(kind, error);
      return undefined;
    }
    const [current, , previous] = counts;
    const decision = slidingWindow({
      limit: limits[kind],
      windowMs: WINDOW_MS,
      elapsedMs: now - minute * WINDOW_MS,
      previous: Number(previous ?? 0),
      current: Number(current) - 1,
    });
    // A refused request leaves the count as it was, so Retry-After holds for a client that waits.
    if (!decision.allowed) await redis.decr(key(minute)).catch(() => undefined);
    return decision;
  }

  /** One warning a minute at most while Redis does not answer: the counter has every request. */
  #unavailable(kind: RateLimitKind, error: unknown): void {
    const now = Date.now();
    if (now - this.#warnedAt < WINDOW_MS) return;
    this.#warnedAt = now;
    this.#options.log.warn({ kind, err: error }, "api: rate limit unavailable, requests allowed");
  }
}

/** The authentication routes' limit, per client address, mounted ahead of their handler. */
export function authRateLimit(limiter: RateLimiter) {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (!AUTH_ROUTES.test(req.url ?? "")) return next();
    limiter.enforce("auth", addressKey(req), res).then(() => next(), next);
  };
}

/** The workspace's limit, a guard after the workspace guard: only a member's requests count. */
export class WorkspaceRateLimitGuard implements CanActivate {
  readonly #limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.#limiter = limiter;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const { tenant } = requestState(http.getRequest<HostRequest>());
    if (tenant) {
      await this.#limiter.enforce("workspace", tenant.workspaceId, http.getResponse());
    }
    return true;
  }
}

/** /api/auth and below, in any case: Express routes paths without regard to case. */
const AUTH_ROUTES = /^\/api\/auth(?:[/?#]|$)/i;

/** The client address as Express reads it behind the trusted proxies, hashed: Redis keeps none. */
export function addressKey(req: IncomingMessage & { ip?: string }): string {
  const address = clientNetwork(req.ip ?? req.socket.remoteAddress ?? "");
  return createHash("sha256").update(address).digest("hex").slice(0, 32);
}

/**
 * The client a limit counts: an IPv4 address as it is, an IPv6 one by its /64, which a client holds
 * whole, so that rotating addresses within it does not escape the limit.
 */
export function clientNetwork(address: string): string {
  const bare = (address.split("%")[0] ?? "").toLowerCase();
  if (!bare.includes(":")) return bare;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
  if (mapped) return mapped;
  const [head = "", tail] = bare.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  // A dotted IPv4 tail holds two groups.
  const size = (list: string[]) => list.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  // A malformed address of more than eight groups gets no zeros, never a RangeError.
  const missing = tail === undefined ? 0 : Math.max(0, 8 - size(left) - size(right));
  const zeros = Array<string>(missing).fill("0");
  const prefix = [...left, ...zeros, ...right].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}
