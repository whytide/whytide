// The OpenAPI 3.1 document (README "OpenAPI and the client"): every route the host mounts, read from
// NestJS's container the way its router reads it, each documented by its handler's @ApiRoute. A
// mounted route without one, or with one the document cannot say, fails the build naming the route.
// The host's codes join a route's own: 401 auth_session_invalid but on @Public() routes; 403
// forbidden and 429 rate_limited under a workspace; 403 origin_rejected on a change; 400
// validation_failed when there is an input to check; the body reader's 400, 413 and 415 when there is
// a body; and on an @Idempotent() route its Idempotency-Key header with its codes. Each status
// answers `{ code, details }` listing its codes. No cookie, no authorization, no example of either.
import { RequestMethod, type Type } from "@nestjs/common";
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_PATH,
  PATH_METADATA,
} from "@nestjs/common/constants.js";
import { MetadataScanner, ModulesContainer, NestFactory } from "@nestjs/core";
import { AppError, httpStatus, permissionErrors, registeredErrors } from "@whytide/platform";
import { authPort } from "@whytide/providers";
import { z } from "zod";
import { hostErrors } from "../src/errors.ts";
import { PUBLIC_METADATA } from "../src/principal.ts";
import { protectionErrors } from "../src/protection/errors.ts";
import { IDEMPOTENT_METADATA } from "../src/protection/idempotency.ts";
import { openapiErrors } from "./errors.ts";
import { API_HEADERS_METADATA, API_ROUTE_METADATA, apiHeaderSpec, apiRouteSpec } from "./route.ts";

export type MountedRoute = {
  /** `GET`, `POST`, …; `ALL` and the rarer methods are refused when documented. */
  readonly method: string;
  /** The template, `/v1/workspaces/{workspaceId}/fixture`. */
  readonly path: string;
  /** The prototype's function, which the decorators carry their metadata on. */
  readonly handler: object;
  readonly controller: Type;
};
type Json = Record<string, unknown>;
export type OpenApiDocument = {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Json>>;
};

const DOCUMENTED = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SECRET_NAME = /cookie|authori[sz]ation/i;
const EXAMPLE_KEYS = new Set(["example", "examples", "default"]);
/** What @Idempotent() reads (src/protection/idempotency.ts), and the codes it and withIdempotency answer. */
const IDEMPOTENCY_KEY = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
  description:
    "A UUID the client makes for the request and sends again on a retry: the same key with the same request answers the stored response, marked Idempotent-Replayed: true.",
};
const IDEMPOTENCY_CODES = [
  protectionErrors.idempotency_key_required,
  "invalid_idempotency_key",
  "idempotency_key_conflict",
  "idempotency_key_reused",
];

/** Every route of the app `root` builds: module path, controller path and handler path, joined. */
export async function mountedRoutes(root: Type): Promise<MountedRoute[]> {
  const options = { logger: false, abortOnError: false } as const;
  const context = await NestFactory.createApplicationContext(root, options);
  try {
    const container = context.get(ModulesContainer);
    const scanner = new MetadataScanner();
    const routes: MountedRoute[] = [];
    for (const module of container.values()) {
      const modulePath: unknown =
        Reflect.getMetadata(MODULE_PATH + container.applicationId, module.metatype) ??
        Reflect.getMetadata(MODULE_PATH, module.metatype);
      for (const { metatype } of module.controllers.values()) {
        const controller = metatype as Type;
        const prototype = controller.prototype as Record<string, object>;
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[name] as object;
          const own: unknown = Reflect.getMetadata(PATH_METADATA, handler);
          if (own === undefined) continue;
          const verb: number = Reflect.getMetadata(METHOD_METADATA, handler);
          const method = RequestMethod[verb] ?? String(verb);
          for (const base of [Reflect.getMetadata(PATH_METADATA, controller) as unknown].flat()) {
            for (const path of [own].flat()) {
              routes.push({ method, path: template(modulePath, base, path), handler, controller });
            }
          }
        }
      }
    }
    return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  } finally {
    await context.close();
  }
}

/** The paths joined as NestJS joins them, `:name` written `{name}`; a pattern is refused. */
function template(...parts: unknown[]): string {
  const raw = parts.filter((part) => typeof part === "string").join("/");
  const segments = raw.split("/").filter(Boolean);
  const path = `/${segments.map((s) => (s.startsWith(":") ? `{${s.slice(1)}}` : s)).join("/")}`;
  if (!segments.every((s) => /^:?[A-Za-z0-9._~-]+$/.test(s))) {
    throw new AppError(openapiErrors.openapi_route_invalid, {
      details: { route: raw, field: "path" },
    });
  }
  return path;
}

export function openApiDocument(routes: readonly MountedRoute[], version: string): OpenApiDocument {
  const named = (route: MountedRoute) => `${route.method} ${route.path}`;
  const undocumented = routes.filter((route) => !metadata(API_ROUTE_METADATA, route.handler));
  if (undocumented.length) {
    const details = { routes: undocumented.map(named) };
    throw new AppError(openapiErrors.openapi_route_undocumented, { details });
  }
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const item = (paths[route.path] ??= {});
    const method = route.method.toLowerCase();
    if (item[method]) throw invalid(named(route), "mounted twice");
    item[method] = operation(route, named(route));
  }
  const document = { openapi: "3.1.0", info: { title: "Whytide API", version }, paths } as const;
  refuseSecretExamples(document);
  return document;
}

function operation(route: MountedRoute, where: string): Json {
  if (!DOCUMENTED.has(route.method)) throw invalid(where, "method");
  const spec = apiRouteSpec.safeParse(metadata(API_ROUTE_METADATA, route.handler));
  if (!spec.success) {
    throw invalid(where, spec.error.issues.map((i) => i.path.join(".")).join(", "));
  }
  const headers = z
    .array(apiHeaderSpec)
    .safeParse(metadata(API_HEADERS_METADATA, route.handler) ?? []);
  if (!headers.success) throw invalid(where, "headers");
  const { summary, params, query, body, response, errors = [] } = spec.data;
  const idempotent = Boolean(
    metadata(IDEMPOTENT_METADATA, route.handler) ?? metadata(IDEMPOTENT_METADATA, route.controller),
  );
  const names = [...route.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name ?? "");
  const stray = Object.keys(params?.shape ?? {}).filter((name) => !names.includes(name));
  if (stray.length) throw invalid(where, `params.${stray.join(", params.")}`);
  const queryJson = query ? jsonSchema(query, "input", where, "query") : {};
  const required = (queryJson.required ?? []) as string[];
  const parameters = [
    ...names.map((name) => {
      const own = params?.shape[name] as z.ZodType | undefined;
      const schema = own ? jsonSchema(own, "input", where, `params.${name}`) : { type: "string" };
      return { name, in: "path", required: true, schema };
    }),
    ...Object.entries((queryJson.properties ?? {}) as Json).map(([name, schema]) => ({
      name,
      in: "query",
      required: required.includes(name),
      schema,
    })),
    ...(idempotent ? [IDEMPOTENCY_KEY] : []),
    ...headers.data.map(({ name, required = false, schema, description }) => ({
      name,
      in: "header",
      required,
      schema: schema ? jsonSchema(schema, "input", where, `headers.${name}`) : { type: "string" },
      ...(description ? { description } : {}),
    })),
  ];
  const status = (metadata(HTTP_CODE_METADATA, route.handler) ??
    (route.method === "POST" ? 201 : 200)) as number;
  const json = (schema: Json) => ({ content: { "application/json": { schema } } });
  return {
    summary,
    ...(parameters.length ? { parameters } : {}),
    ...(body
      ? { requestBody: { required: true, ...json(jsonSchema(body, "input", where, "body")) } }
      : {}),
    responses: {
      [status]: {
        description: "Success",
        ...(response ? json(jsonSchema(response, "output", where, "response")) : {}),
      },
      ...errorResponses(route, where, errors, {
        input: Boolean(params || query || body),
        body: Boolean(body),
        idempotent,
      }),
    },
  };
}

/** Per status, the codes a caller may get, as `{ code, details }`; details below 500 only. */
function errorResponses(
  route: MountedRoute,
  where: string,
  own: readonly string[],
  has: { readonly input: boolean; readonly body: boolean; readonly idempotent: boolean },
) {
  const unknown = own.filter((code) => !registeredErrors().has(code));
  if (unknown.length) throw invalid(where, `errors.${unknown.join(", errors.")}`);
  const byStatus = new Map<number, Set<string>>();
  const add = (code: string, status = httpStatus(code)) =>
    byStatus.set(status, (byStatus.get(status) ?? new Set()).add(code));
  for (const code of own) add(code);
  const open =
    metadata(PUBLIC_METADATA, route.handler) ?? metadata(PUBLIC_METADATA, route.controller);
  if (!open) add(authPort.errors.auth_session_invalid);
  if (route.path.startsWith("/v1/workspaces/{workspaceId}/")) {
    add(permissionErrors.forbidden);
    add(protectionErrors.rate_limited);
  }
  if (route.method !== "GET") add(protectionErrors.origin_rejected);
  if (has.input) add(hostErrors.validation_failed);
  if (has.body) {
    // The body reader's answers (src/protection/body.ts), under the error filter's codes.
    add("invalid_request", 400);
    add("payload_too_large", 413);
    add("invalid_request", 415);
  }
  if (has.idempotent) for (const code of IDEMPOTENCY_CODES) add(code);
  return Object.fromEntries(
    [...byStatus].map(([status, set]) => {
      const list = [...set].sort();
      const properties = {
        code: { type: "string", enum: list },
        ...(status < 500 ? { details: { type: "object" } } : {}),
      };
      const schema = {
        type: "object",
        properties,
        required: ["code"],
        additionalProperties: false,
      };
      return [
        status,
        { description: list.join(", "), content: { "application/json": { schema } } },
      ];
    }),
  );
}

/** JSON Schema 2020-12, OpenAPI 3.1's dialect, without `$schema`; never a `$ref` (README). */
function jsonSchema(schema: z.ZodType, io: "input" | "output", route: string, part: string): Json {
  let converted: Json;
  try {
    converted = z.toJSONSchema(schema, { io }) as Json;
  } catch (cause) {
    throw new AppError(openapiErrors.openapi_schema_unsupported, {
      details: { route, part },
      cause,
    });
  }
  const { $schema, ...rest } = converted;
  if (JSON.stringify(rest).includes('"$ref"')) {
    const details = { route, part, reason: "a schema with an id or a cycle" };
    throw new AppError(openapiErrors.openapi_schema_unsupported, { details });
  }
  return rest;
}

/**
 * No parameter is a cookie or named like one or an authorization, and no example or default sits
 * under a property so named (docs/rules/security.md §4): the document never shows a secret's shape.
 */
function refuseSecretExamples(
  value: unknown,
  pointer = "",
  secret = false,
  properties = false,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, at) => refuseSecretExamples(item, `${pointer}/${at}`, secret));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Json;
  const parameter = !properties && typeof node.in === "string" && typeof node.name === "string";
  if (parameter && (node.in === "cookie" || SECRET_NAME.test(node.name as string))) {
    throw new AppError(openapiErrors.openapi_secret_example, { details: { pointer } });
  }
  for (const [key, child] of Object.entries(node)) {
    const at = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (secret && !properties && EXAMPLE_KEYS.has(key)) {
      throw new AppError(openapiErrors.openapi_secret_example, { details: { pointer: at } });
    }
    const named = properties && SECRET_NAME.test(key);
    refuseSecretExamples(child, at, secret || named, !properties && key === "properties");
  }
}

function metadata(key: string | symbol, target: object): unknown {
  return Reflect.getMetadata(key, target);
}

function invalid(route: string, field: string): AppError {
  return new AppError(openapiErrors.openapi_route_invalid, { details: { route, field } });
}
