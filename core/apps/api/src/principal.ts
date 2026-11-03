// The principal guard (docs/request-path.md): every route but the host's own @Public() ones needs a
// session, which the authentication port's resolvePrincipal reads from the request's cookie (the fake
// until alpha-p3-020); none is 401 auth_session_invalid. The principal is then a human with a session
// and no workspace yet: the workspace guard adds the membership. It is also left, read-only, on
// `req.principal`, where an account route (README "Modules"), which no tenant run carries, reads it.
import { type CanActivate, type ExecutionContext, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError, type Principal } from "@whytide/platform";
import { authPort, type PortInstance } from "@whytide/providers";
import { type HostRequest, requestState } from "./request-context.ts";

/**
 * The mark of a host route that needs no session: the health routes, never a module's. A symbol, not
 * a string: a module cannot import the host, so it cannot mark its own routes, account routes
 * included, which would skip every guard; `SetMetadata("whytide:public", true)` marks nothing.
 */
export const PUBLIC_METADATA = Symbol("whytide:public");
export const Public = () => SetMetadata(PUBLIC_METADATA, true);

export class PrincipalGuard implements CanActivate {
  readonly #auth: PortInstance<typeof authPort>;
  readonly #reflector = new Reflector();

  constructor(auth: PortInstance<typeof authPort>) {
    this.#auth = auth;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.#reflector.getAllAndOverride<boolean>(PUBLIC_METADATA, targets)) return true;
    const req = context.switchToHttp().getRequest<HostRequest>();
    const session = await this.#auth.resolvePrincipal({ headers: req.headers });
    if (session === null) throw new AppError(authPort.errors.auth_session_invalid);
    const principal: Principal = Object.freeze({
      userId: session.userId,
      actorType: "human",
      authMethod: "session",
      scopes: Object.freeze([]),
    });
    requestState(req).principal = principal;
    Object.defineProperty(req, "principal", { value: principal });
    return true;
  }
}
