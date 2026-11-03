// can() as a decorator (docs/request-path.md): `@Permission("leads.read")` on a handler or its
// controller, checked after the workspace guard, with the URL's workspace as the resource. A workspace
// route that declares none is refused, permission_undeclared, so that no route is open by omission; a
// route outside the workspaces (GET /v1/me) needs the principal only, unless it declares one.
import { type CanActivate, type ExecutionContext, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError, can } from "@whytide/platform";
import { hostErrors } from "./errors.ts";
import { type HostRequest, requestState } from "./request-context.ts";

/** The metadata key the decorator sets (README "Permissions"). */
export const PERMISSION_METADATA = "whytide:permission";
export const Permission = (action: string) => SetMetadata(PERMISSION_METADATA, action);

export class PermissionGuard implements CanActivate {
  readonly #reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const action = this.#reflector.getAllAndOverride<string | undefined>(
      PERMISSION_METADATA,
      targets,
    );
    const { principal, tenant } = requestState(context.switchToHttp().getRequest<HostRequest>());
    if (tenant === undefined && action === undefined) return true;
    if (action === undefined) throw new AppError(hostErrors.permission_undeclared);
    const subject = tenant?.principal ?? principal;
    const resource = tenant ? { workspaceId: tenant.workspaceId } : undefined;
    const decision = subject ? can(subject, action, resource) : "forbidden";
    if (decision !== "allow") throw new AppError(decision);
    return true;
  }
}
