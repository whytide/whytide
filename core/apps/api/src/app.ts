// The NestJS application (docs/request-path.md): Express under NestJS, without NestJS's body parsers;
// the request context, the request protections' middleware and the authentication handler mounted
// first, ahead of NestJS's not-found handler, which it adds at init; each module's `api` under
// /v1/workspaces/:workspaceId/<module> and its `accountApi` under /v1, outside the workspaces: no
// workspace guard, no tenant run; the host's own health and sign-in routes (src/sign-in.ts); then,
// global and in the order of the request path, the principal, workspace, workspace rate limit and
// permission guards, the body reader, the @ApiRoute input check, the tenant run, @Idempotent(), the
// validation pipe and the error filter (docs/security.md). A controller outside those mounts stops
// the start. A module's `webhooks` take POST /v1/<module>/webhooks/:provider ahead of the routes
// (webhooks.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { Module, type Type } from "@nestjs/common";
import { ModulesContainer, NestFactory, RouterModule } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { PrismaClient } from "@whytide/db";
import { AppError, type Logger } from "@whytide/platform";
import type { authPort, PortInstance } from "@whytide/providers";
import { ErrorFilter } from "./error-filter.ts";
import { hostErrors } from "./errors.ts";
import { HEALTH, type Health, HealthController } from "./health.ts";
import type { HostModules } from "./modules.ts";
import { PermissionGuard } from "./permission.ts";
import { PrincipalGuard } from "./principal.ts";
import {
  BodyInterceptor,
  IdempotencyInterceptor,
  type Protection,
  protectRequests,
  WorkspaceRateLimitGuard,
} from "./protection/index.ts";
import { requestContext } from "./request-context.ts";
import { RouteValidationInterceptor } from "./route-validation.ts";
import { SIGN_IN, SignInController } from "./sign-in.ts";
import { validationPipe } from "./validation.ts";
import { moduleWebhooks } from "./webhooks.ts";
import { TenantInterceptor, WorkspaceGuard } from "./workspace.ts";

export type AppOptions = {
  readonly modules: HostModules;
  readonly auth: PortInstance<typeof authPort>;
  /** The `app` client every tenant run opens its transaction on. */
  readonly app: PrismaClient;
  readonly health: Health;
  readonly log: Logger;
  readonly protection: Protection;
  /** Connect-style handlers ahead of the routes, for a test: the LinkedIn fake's connect route. */
  readonly mount?: readonly Handler[];
};
export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

export async function createApp(options: AppOptions): Promise<NestExpressApplication> {
  const { modules, auth, log, protection } = options;
  const signIn = { auth, limiter: protection.limiter, log };
  const root = rootModule({ ...options, signIn });
  const app = await NestFactory.create<NestExpressApplication>(root, {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  await refuseUnmounted(app, [root, ...modules.apis.map(({ api }) => api), ...modules.accountApis]);
  app.disable("x-powered-by");
  app.use(requestContext(log));
  protectRequests(app, protection);
  await auth.mountHandler(app);
  app.use(moduleWebhooks(modules.webhooks, protection.limiter));
  for (const handler of options.mount ?? []) app.use(handler);
  app.useGlobalGuards(
    new PrincipalGuard(auth),
    new WorkspaceGuard(modules.workspaceResolver),
    new WorkspaceRateLimitGuard(protection.limiter),
    new PermissionGuard(),
  );
  // The input check after the body reader, which sets req.body, and ahead of the tenant run.
  app.useGlobalInterceptors(
    new BodyInterceptor(),
    new RouteValidationInterceptor(),
    new TenantInterceptor(options.app),
    new IdempotencyInterceptor(),
  );
  app.useGlobalPipes(validationPipe());
  app.useGlobalFilters(new ErrorFilter(log));
  await app.init();
  return app;
}

/**
 * The host's NestJS module: also what `pnpm openapi:build` reads the routes from, without `signIn`,
 * which only a request reaches.
 */
export function rootModule(
  options: Pick<AppOptions, "modules" | "health"> & { readonly signIn?: unknown },
): Type {
  const { modules, health, signIn = null } = options;
  const routes = [
    ...modules.apis.map(({ name, api }) => ({
      path: `v1/workspaces/:workspaceId/${name}`,
      module: api,
    })),
    ...modules.accountApis.map((api) => ({ path: "v1", module: api })),
  ];
  const apis = [...modules.apis.map(({ api }) => api), ...modules.accountApis];
  @Module({
    imports: [...apis, RouterModule.register(routes)],
    controllers: [HealthController, SignInController],
    providers: [
      { provide: HEALTH, useValue: health },
      { provide: SIGN_IN, useValue: signIn },
    ],
  })
  class ApiHostModule {}
  return ApiHostModule;
}

/**
 * Every controller sits in a module the host mounts: a module's `api` or `accountApi`, or the host's
 * own. A NestJS module that one of them imports would serve its controllers at their own paths,
 * outside /v1/workspaces/…, past the workspace and permission guards: the start stops instead.
 */
async function refuseUnmounted(app: NestExpressApplication, mounted: readonly Type[]) {
  for (const { metatype, controllers } of app.get(ModulesContainer).values()) {
    if (controllers.size === 0 || mounted.includes(metatype)) continue;
    await app.close();
    const details = { field: "controllers", nestModule: metatype.name };
    throw new AppError(hostErrors.module_invalid, { details });
  }
}
