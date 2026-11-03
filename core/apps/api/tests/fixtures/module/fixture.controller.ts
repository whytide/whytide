// The fixture module's one controller, for the host's tests only: it reports the tenant it runs in,
// as the platform and the database see it, validates a body, a parameter and a query, and throws a
// module's AppError. Each route has its @ApiRoute and its request in api/fixture.http.
import { Body, Controller, Get, HttpCode, Module, Param, Post, Query } from "@nestjs/common";
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, defineErrors, definePermissions } from "@whytide/platform";
import { z } from "zod";
import { ApiRoute } from "../../../openapi/route.ts";
import { Permission } from "../../../src/permission.ts";

export const errors = defineErrors({ fixture_not_found: {} });
export const permissions = definePermissions(
  [
    { action: "fixture.read", roles: ["Owner", "Admin", "Member"] },
    { action: "fixture.write", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);

const fixtureBody = z.strictObject({
  name: z.string().min(1),
  items: z.array(z.strictObject({ qty: z.number().int() })),
});
type FixtureBody = z.infer<typeof fixtureBody>;
const nameParams = z.strictObject({ name: z.string().regex(/^[a-z0-9-]{1,40}$/) });
const greetingQuery = z.strictObject({ greeting: z.string().max(40).optional() });

@Controller()
export class FixtureController {
  /** The settings come through db's fixture function: the tenant client refuses SQL naming them. */
  @Get()
  @Permission(permissions["fixture.read"])
  @ApiRoute({
    summary: "The tenant the handler runs in, as the platform and the database see it",
    response: z.strictObject({ workspaceId: z.string(), setting: z.string().nullable() }),
  })
  async read(): Promise<{ workspaceId: string; setting: string | null }> {
    const rows = await tenantClient.$queryRaw<{ workspace_id: string | null }[]>`
      SELECT * FROM db_test_tenant_settings()`;
    return { workspaceId: currentTenant().workspaceId, setting: rows[0]?.workspace_id ?? null };
  }

  @Post()
  @HttpCode(200)
  @Permission(permissions["fixture.write"])
  @ApiRoute({
    summary: "Counts the items of a valid body",
    body: fixtureBody,
    response: z.strictObject({ items: z.number().int() }),
  })
  create(@Body() body: FixtureBody): { items: number } {
    return { items: body.items.length };
  }

  @Get(":name")
  @Permission(permissions["fixture.read"])
  @ApiRoute({
    summary: "Greets a fixture by its name; `missing` is not found",
    params: nameParams,
    query: greetingQuery,
    response: z.strictObject({ name: z.string(), greeting: z.string() }),
    errors: [errors.fixture_not_found],
  })
  named(
    @Param("name") name: string,
    @Query() query: z.infer<typeof greetingQuery>,
  ): { name: string; greeting: string } {
    if (name === "missing") throw new AppError(errors.fixture_not_found);
    return { name, greeting: query.greeting ?? "hello" };
  }
}

@Module({ controllers: [FixtureController] })
export class FixtureApi {}
