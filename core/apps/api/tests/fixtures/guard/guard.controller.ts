// The guard's fixture module (tests/host.test.ts, alpha-p3-030): a workspace route without
// @Permission, and one with @OwnRuns() (alpha-p5-030); an account controller with a permission and a
// route marked public the way a module would mark it; and an `api` that imports a NestJS module with
// a controller of its own.
import { Controller, Get, Module, Req, SetMetadata } from "@nestjs/common";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import {
  currentTenant,
  definePermissions,
  isAppError,
  type TenantContext,
} from "@whytide/platform";
import { Permission } from "../../../src/permission.ts";
import { OwnRuns } from "../../../src/workspace.ts";

/** The code `read` throws, or null. */
function refusal(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return isAppError(error) ? error.code : String(error);
  }
}

export const permissions = definePermissions(
  [{ action: "guard.read", roles: ["Owner", "Admin", "Member"] }],
  import.meta.url,
);

@Controller()
class GuardController {
  /** No @Permission: the permission guard answers 500 permission_undeclared. */
  @Get("undeclared")
  undeclared(): Record<string, never> {
    return {};
  }

  /** Outside any run, the tenant on the request; inside its own, the workspace's settings. */
  @Get("own-runs")
  @Permission(permissions["guard.read"])
  @OwnRuns()
  async ownRuns(@Req() req: { readonly tenant?: TenantContext }) {
    const outside = {
      tenant: refusal(currentTenant),
      client: refusal(() => tenantClient.$queryRaw),
    };
    if (req.tenant === undefined) throw new Error("no tenant on the request");
    const inside = await withTenant(
      req.tenant,
      async (tx) => {
        const rows = await tx.$queryRaw<{ workspace_id: string | null }[]>`
          SELECT * FROM db_test_tenant_settings()`;
        return { workspaceId: currentTenant().workspaceId, setting: rows[0]?.workspace_id ?? null };
      },
      { client: asRole("app") },
    );
    return { outside, inside };
  }
}

@Controller("guard")
class GuardAccountController {
  @Get("declared")
  @Permission(permissions["guard.read"])
  declared(): Record<string, never> {
    return {};
  }

  /** The host's mark, as a module can write it: it marks nothing. */
  @Get("open")
  @SetMetadata("whytide:public", true)
  open(): Record<string, never> {
    return {};
  }
}

@Module({ controllers: [GuardController] })
export class GuardApi {}

@Module({ controllers: [GuardAccountController] })
export class GuardAccountApi {}

@Controller("stray")
class StrayController {
  @Get()
  stray(): Record<string, never> {
    return {};
  }
}

@Module({ controllers: [StrayController] })
class StrayModule {}

/** An `api` that imports a NestJS module with a controller: its route would sit at /stray. */
@Module({ imports: [StrayModule] })
export class StrayApi {}
