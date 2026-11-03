// The request protections (docs/security.md), wired by createApp: the security headers, the origin
// check and the authentication routes' rate limit as the first middleware after the request context,
// ahead of the authentication handler; the workspace's rate limit as a guard after the workspace
// guard; the body reader and @Idempotent() as interceptors around the tenant run.
import type { NestExpressApplication } from "@nestjs/platform-express";
import { type Logger, platformConfig } from "@whytide/platform";
import { protectionConfig } from "./config.ts";
import { securityHeaders } from "./headers.ts";
import { originCheck } from "./origin.ts";
import { authRateLimit, RateLimiter, SIGN_IN_PER_EMAIL_PER_MIN } from "./rate-limit.ts";
import type { RedisClient } from "./redis.ts";

export { BodyInterceptor, BodyLimit, JSON_BODY_LIMIT, Multipart } from "./body.ts";
export { IdempotencyInterceptor, Idempotent } from "./idempotency.ts";
export { WorkspaceRateLimitGuard } from "./rate-limit.ts";
export { closeRedis, connectRedis, type RedisClient } from "./redis.ts";

export type Protection = {
  readonly limiter: RateLimiter;
  /** The origins a cookie-carrying change may come from: the app's, the web's in development. */
  readonly origins: ReadonlySet<string>;
  readonly production: boolean;
};

export function createProtection(options: {
  readonly redis: RedisClient;
  readonly log: Logger;
  /** The rate limits' clock, Date.now unless a test brings its own. */
  readonly now?: () => number;
}): Protection {
  const config = protectionConfig;
  const env = platformConfig.APP_ENV;
  const origins = [config.APP_PUBLIC_ORIGIN, env === "development" ? config.WEB_DEV_ORIGIN : ""];
  const limiter = new RateLimiter({
    ...options,
    prefix: config.REDIS_PREFIX,
    limits: {
      workspace: config.RATE_LIMIT_WORKSPACE_PER_MIN,
      auth: config.RATE_LIMIT_AUTH_PER_IP_PER_MIN,
      webhook: config.RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN,
      email: SIGN_IN_PER_EMAIL_PER_MIN,
    },
  });
  return {
    limiter,
    origins: new Set(origins.filter((origin): origin is string => Boolean(origin))),
    production: env === "production",
  };
}

/** The middleware part, mounted after the request context and before the authentication handler. */
export function protectRequests(app: NestExpressApplication, protection: Protection): void {
  // req.ip is the client's behind a proxy TRUST_PROXY names, else the peer: in production Caddy only.
  app.set("trust proxy", protectionConfig.TRUST_PROXY);
  app.use(securityHeaders(protection.production));
  app.use(originCheck(protection.origins));
  app.use(authRateLimit(protection.limiter));
}
