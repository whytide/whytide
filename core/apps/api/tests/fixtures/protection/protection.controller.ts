// The request protections' fixture module (tests/protection.test.ts): routes to send requests to, an
// @Idempotent() one that counts its runs, and one with its own body limit.
import { randomUUID } from "node:crypto";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { currentTenant, definePermissions } from "@whytide/platform";
import { Permission } from "../../../src/permission.ts";
import { BodyLimit, Idempotent } from "../../../src/protection/index.ts";

export const permissions = definePermissions(
  [
    { action: "protect.read", roles: ["Owner", "Admin", "Member"] },
    { action: "protect.write", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);

/** How many times the @Idempotent() handler ran, per workspace. */
export const runs = new Map<string, number>();

@Controller()
export class ProtectionController {
  @Get()
  @Permission(permissions["protect.read"])
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  @Permission(permissions["protect.write"])
  create(@Body() body: unknown): { received: boolean } {
    return { received: body !== undefined };
  }

  /** A new charge id on every run, so that a replay shows the stored answer. */
  @Post("charges")
  @Idempotent()
  @Permission(permissions["protect.write"])
  charge(@Body() body: unknown): { charge: string; body: unknown } {
    const { workspaceId } = currentTenant();
    runs.set(workspaceId, (runs.get(workspaceId) ?? 0) + 1);
    return { charge: randomUUID(), body };
  }

  @Post("imports")
  @BodyLimit(4 * 1024 * 1024)
  @Permission(permissions["protect.write"])
  import(@Body() body: { pad?: string }): { bytes: number } {
    return { bytes: body.pad?.length ?? 0 };
  }
}

@Module({ controllers: [ProtectionController] })
export class ProtectionApi {}
