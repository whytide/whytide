// `pnpm openapi:build` (README "OpenAPI and the client"): the document of every route the host
// mounts, validated with Redocly's `minimal` rules, then the .http coverage check: every route needs
// a request in api-calls/*.http (docs/rules/delivery.md §4). It writes openapi.generated.json, which
// git ignores; the package script then runs the secret-shape check of tools/ci over it. The
// document is self-contained, no `$ref`, so that neither the validator nor the client's generator
// reads anything but the file. Run from dist/ (the controllers are decorated):
//   node dist/openapi/build.js
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createConfig, lintFromString } from "@redocly/openapi-core";
import { AppError, createLogger, isAppError } from "@whytide/platform";
import { rootModule } from "../src/app.ts";
import { moduleLoaders } from "../src/modules.generated.ts";
import { loadModules, type ModuleLoader } from "../src/modules.ts";
import { mountedRoutes, type OpenApiDocument, openApiDocument } from "./document.ts";
import { openapiErrors } from "./errors.ts";
import { parseHttpFile, routesWithoutRequest } from "./http-file.ts";

/** core/apps/api, from dist/openapi/ where this runs. */
export const apiDir = resolve(import.meta.dirname, "..", "..");
const repoDir = resolve(apiDir, "..", "..", "..");
const version = (
  JSON.parse(readFileSync(join(apiDir, "package.json"), "utf8")) as { version: string }
).version;

/** Every api-calls/*.http file, sorted. */
export function apiCallFiles(repo = repoDir): string[] {
  const dir = join(repo, "api-calls");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".http"))
    .sort()
    .map((name) => join(dir, name));
}

export async function buildOpenApi(options: {
  readonly modules: readonly ModuleLoader[];
  readonly httpFiles: readonly string[];
}): Promise<OpenApiDocument> {
  const modules = await loadModules(options.modules);
  const health = { checks: new Map(), log: createLogger() };
  const routes = await mountedRoutes(rootModule({ modules, health }));
  const document = openApiDocument(routes, version);
  const problems = await validate(document);
  if (problems.length) {
    throw new AppError(openapiErrors.openapi_document_invalid, { details: { problems } });
  }
  const requests = options.httpFiles.flatMap((file) =>
    parseHttpFile(readFileSync(file, "utf8"), relative(repoDir, file)),
  );
  const missing = routesWithoutRequest(routes, requests);
  if (missing.length) {
    throw new AppError(openapiErrors.openapi_route_without_request, {
      details: { routes: missing },
    });
  }
  return document;
}

/** Redocly's problems, errors and warnings alike, as `rule: message at pointer`. */
async function validate(document: OpenApiDocument): Promise<string[]> {
  // The `minimal` rules but three: no operationId, servers or security scheme, by design (README).
  const rules = {
    "operation-operationId": "off",
    "no-empty-servers": "off",
    "security-defined": "off",
  } as const;
  const config = await createConfig({ extends: ["minimal"], rules });
  const source = JSON.stringify(document);
  if (source.includes('"$ref"')) return ["self-contained: a $ref, which this build never writes"];
  const absoluteRef = join(apiDir, "openapi.generated.json");
  const problems = await lintFromString({ source, absoluteRef, config });
  return problems.map((p) => `${p.ruleId}: ${p.message} at ${p.location[0]?.pointer ?? "#"}`);
}

if (import.meta.main) {
  const say = (text: string) => process.stdout.write(`${text}\n`);
  try {
    const document = await buildOpenApi({ modules: moduleLoaders, httpFiles: apiCallFiles() });
    const out = join(apiDir, "openapi.generated.json");
    writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
    say(
      `openapi: ${Object.keys(document.paths).length} paths written to ${relative(repoDir, out)}`,
    );
  } catch (error) {
    if (!isAppError(error)) throw error;
    say(`openapi: ${error.code} ${JSON.stringify(error.details ?? {})}`);
    process.exitCode = 1;
  }
}
