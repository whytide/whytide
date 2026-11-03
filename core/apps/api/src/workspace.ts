// The workspace guard and the tenant run (docs/request-path.md). A route under
// /v1/workspaces/:workspaceId/… is reached through the workspaceResolver only, which one module
// registers by exporting it (identity, alpha-p3-030); without one, every workspace is 403 forbidden.
// The guard asks it for the principal's membership in the workspace the URL names, an id or a slug,
// on every request and never from a cache; the interceptor then runs the pipes and the handler inside
// withTenant, on the host's `app` client, with the workspace and the actor on every log line. A route
// with @OwnRuns() gets no run: it reads the client's stream or calls a provider, which a run must not
// wait on, and opens withTenant(req.tenant, …) for each of its database steps.
import {
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type PrismaClient, withTenant } from "@whytide/db";
import { AppError, type Principal, permissionErrors, withLogContext } from "@whytide/platform";
import { authPort } from "@whytide/providers";
import { from, lastValueFrom, type Observable } from "rxjs";
import { z } from "zod";
import { hostErrors } from "./errors.ts";
import { type HostRequest, requestState } from "./request-context.ts";

const membership = z
  .strictObject({
    workspaceId: z.string().min(1),
    membershipId: z.string().min(1),
    role: z.enum(["Owner", "Admin", "Member"]),
  })
  .nullable();

const OWN_RUNS_METADATA = "whytide:own-runs";
/** A workspace route that opens its own tenant runs (README "Request protection"). */
export const OwnRuns = () => SetMetadata(OWN_RUNS_METADATA, true);

/** The principal's membership in the workspace the URL names, or null: what a resolver answers. */
export type WorkspaceMembership = z.infer<typeof membership>;
/** A module's `workspaceResolver` export (README "Modules"); `workspace` is the URL's, an id or a slug. */
export type WorkspaceResolver = (input: {
  readonly principal: Principal;
  readonly workspace: string;
}) => Promise<WorkspaceMembership>;

/** The host's default, until a module exports a resolver: no membership anywhere. */
export const denyEveryWorkspace: WorkspaceResolver = async () => null;

export class WorkspaceGuard implements CanActivate {
  readonly #resolve: WorkspaceResolver;

  constructor(resolve: WorkspaceResolver) {
    this.#resolve = resolve;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HostRequest>();
    const workspace = req.params?.workspaceId;
    if (workspace === undefined) return true;
    const state = requestState(req);
    if (!state.principal) throw new AppError(authPort.errors.auth_session_invalid);
    const answer = membership.safeParse(
      await this.#resolve({ principal: state.principal, workspace }),
    );
    if (!answer.success) throw new AppError(hostErrors.workspace_resolver_invalid);
    if (answer.data === null) throw new AppError(permissionErrors.forbidden);
    const { workspaceId, membershipId, role } = answer.data;
    const principal = Object.freeze({ ...state.principal, workspaceId, membershipId, role });
    state.tenant = Object.freeze({ workspaceId, principal });
    return true;
  }
}

export class TenantInterceptor implements NestInterceptor {
  readonly #client: PrismaClient;
  readonly #reflector = new Reflector();

  constructor(client: PrismaClient) {
    this.#client = client;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<HostRequest>();
    const tenant = requestState(req).tenant;
    if (!tenant) return next.handle();
    const scope = { workspace_id: tenant.workspaceId, actor: tenant.principal.userId };
    const handle = () => lastValueFrom(next.handle(), { defaultValue: undefined });
    const targets = [context.getHandler(), context.getClass()];
    if (this.#reflector.getAllAndOverride<boolean>(OWN_RUNS_METADATA, targets) === true) {
      // No context either: withTenant refuses to open inside one (nested_run).
      Object.defineProperty(req, "tenant", { value: tenant });
      return from(withLogContext(scope, handle));
    }
    return from(withLogContext(scope, () => withTenant(tenant, handle, { client: this.#client })));
  }
}
