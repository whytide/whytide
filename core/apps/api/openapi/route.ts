// @ApiRoute (README "OpenAPI and the client"): one place that validates a handler's input and documents
// its route, with the Zod schemas of the module's schemas/. The host collects it twice: the route
// validation checks params, query and body before the handler (src/route-validation.ts), and
// `pnpm openapi:build` writes the route into the OpenAPI document with its error codes. A module cannot
// import the host: it writes `SetMetadata("whytide:api-route", { … })` from @nestjs/common, the same.
import { SetMetadata } from "@nestjs/common";
import { z } from "zod";

export const API_ROUTE_METADATA = "whytide:api-route";
/** The extra request headers a route documents; ApiHeader appends to it. */
export const API_HEADERS_METADATA = "whytide:api-headers";

const schema = z.custom<z.ZodType>((value) => value instanceof z.ZodType, "a Zod schema");
const object = z.custom<z.ZodObject>((value) => value instanceof z.ZodObject, "a Zod object");

/** What @ApiRoute takes; the document's build checks it on every route. */
export const apiRouteSpec = z.strictObject({
  summary: z.string().min(1),
  /** The route's own path parameters; the host's `workspaceId` is the workspace guard's. */
  params: object.optional(),
  query: object.optional(),
  body: schema.optional(),
  /** The success body; none for an empty answer. */
  response: schema.optional(),
  /** The codes the handler throws; the host adds its own (auth, forbidden, validation_failed). */
  errors: z.array(z.string()).readonly().optional(),
});
export type ApiRouteSpec = z.infer<typeof apiRouteSpec>;

export const apiHeaderSpec = z.strictObject({
  name: z.string().min(1),
  required: z.boolean().optional(),
  schema: schema.optional(),
  description: z.string().optional(),
});
export type ApiHeaderSpec = z.infer<typeof apiHeaderSpec>;

export const ApiRoute = (route: ApiRouteSpec) => SetMetadata(API_ROUTE_METADATA, route);

/**
 * A request header the route reads, documented as a header parameter; several stack. The document
 * adds @Idempotent()'s Idempotency-Key by itself, from the metadata `whytide:idempotent`.
 */
export function ApiHeader(header: ApiHeaderSpec): MethodDecorator {
  return (_target, _key, descriptor) => {
    const handler = descriptor.value as object;
    const headers = (Reflect.getMetadata(API_HEADERS_METADATA, handler) ?? []) as ApiHeaderSpec[];
    Reflect.defineMetadata(API_HEADERS_METADATA, [...headers, header], handler);
  };
}
