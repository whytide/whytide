// The input check of @ApiRoute (docs/request-path.md, step 8): the handler's own path parameters,
// query and body against the schemas its @ApiRoute gives, ahead of the tenant run, so that a bad
// input opens no transaction. An input off them is 400 validation_failed with the paths at fault,
// as the pipe answers; otherwise the handler reads the parsed values, coerced and defaulted.
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { AppError } from "@whytide/platform";
import type { Observable } from "rxjs";
import type { z } from "zod";
import { API_ROUTE_METADATA, type ApiRouteSpec } from "../openapi/route.ts";
import { hostErrors } from "./errors.ts";
import { fieldPaths } from "./validation.ts";

type Input = { params: Record<string, unknown>; query: unknown; body: unknown };

export class RouteValidationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route: ApiRouteSpec | undefined = Reflect.getMetadata(
      API_ROUTE_METADATA,
      context.getHandler(),
    );
    const req = context.switchToHttp().getRequest<Input>();
    if (route?.params) {
      const keys = Object.keys(route.params.shape);
      const own = Object.fromEntries(keys.map((key) => [key, req.params[key]]));
      req.params = { ...req.params, ...(parse(route.params, own) as object) };
    }
    if (route?.query) {
      // Express 5 reads `query` through a getter: the parsed value is set on the request itself.
      const value = parse(route.query, req.query);
      Object.defineProperty(req, "query", { value, configurable: true, enumerable: true });
    }
    if (route?.body) req.body = parse(route.body, req.body);
    return next.handle();
  }
}

function parse(schema: z.ZodType, value: unknown): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = { fields: fieldPaths(result.error.issues) };
  throw new AppError(hostErrors.validation_failed, { details });
}
