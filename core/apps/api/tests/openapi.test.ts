// The end-to-end test of alpha-p2-020: the OpenAPI document of the fixture module, the client
// generated from it into a temporary folder and called against the worktree's api (started as
// main.ts starts it, in a schema of the slice's database), the fixture's .http file run with the dev
// environment and a cookie from session:token, the .http coverage check and the secret checks; and
// alpha-p2-030's @Idempotent() fixture route, whose Idempotency-Key the document adds.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import { authPort, getAdapter } from "@whytide/providers";
import { signInAs } from "@whytide/providers/auth/testing";
import { z } from "zod";
import { API_HEADERS_METADATA, API_ROUTE_METADATA } from "../openapi/route.ts";
import { loadModules, type ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";
import { FixtureController } from "./fixtures/module/fixture.controller.ts";
import { FIXTURE_WORKSPACE } from "./fixtures/module/index.ts";
import { apiDir, envFile, loadVariables, repoDir, runHttpFile } from "./http-run.ts";
import { sessionToken } from "./session-token.ts";

const dev = loadVariables({ envFile, privateFile: "", environment: "dev" });
// The api takes a cookie-carrying change from the dev environment's appOrigin. The host reads
// APP_PUBLIC_ORIGIN as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = dev.appOrigin;
const { apiCallFiles, buildOpenApi } = await import("../openapi/build.ts");
const { mountedRoutes, openApiDocument } = await import("../openapi/document.ts");
const { rootModule } = await import("../src/app.ts");
const { start } = await import("../src/start.ts");
const { ProtectionController } = await import("./fixtures/protection/protection.controller.ts");

const db = withTestDb({ fixtures: ["20261021000800_db_test_tenant_settings"] });
const fixture: ModuleLoader = { name: "fixture", load: () => import("./fixtures/module/index.ts") };
const fixtureHttp = join(apiDir, "tests", "fixtures", "module", "api", "fixture.http");
const httpFiles = [...apiCallFiles(), fixtureHttp];
const generator = join(repoDir, "core", "apps", "web", "scripts", "client-generate.ts");
const build = () => buildOpenApi({ modules: [fixture], httpFiles });
const fixturePath = "/v1/workspaces/{workspaceId}/fixture";
let api: Api;
let tmp: string;

/** The test's own value of an @ApiRoute or @ApiHeader metadata on a fixture handler, restored after. */
async function withMetadata(
  key: string,
  value: unknown,
  handler: object,
  run: () => Promise<void>,
) {
  const saved: unknown = Reflect.getMetadata(key, handler);
  Reflect.defineMetadata(key, value, handler);
  try {
    await run();
  } finally {
    if (saved === undefined) Reflect.deleteMetadata(key, handler);
    else Reflect.defineMetadata(key, saved, handler);
  }
}

const node = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
const appError = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, details ?? error.details], [code, error.details]);
  return true;
};

before(async () => {
  const url = new URL(databaseUrl("owner"));
  url.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [fixture],
    migrations: { url: url.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
  mkdirSync(join(apiDir, ".tmp"), { recursive: true });
  tmp = mkdtempSync(join(apiDir, ".tmp", "openapi-"));
});
after(async () => {
  await api?.close();
  if (tmp?.startsWith(join(apiDir, ".tmp"))) rmSync(tmp, { recursive: true, force: true });
});

test("openapi:build writes a valid 3.1 document of the fixture routes; one without @ApiRoute fails, named", async () => {
  const document = await build();
  assert.equal(document.openapi, "3.1.0");
  const post = document.paths[fixturePath]?.post as Record<string, any>;
  const body = post.requestBody.content["application/json"].schema;
  assert.deepEqual(Object.keys(body.properties), ["name", "items"]);
  assert.deepEqual(post.responses["200"].content["application/json"].schema.required, ["items"]);
  const codes = (status: string) => post.responses[status].content["application/json"].schema;
  assert.deepEqual(codes("400").properties.code.enum, ["invalid_request", "validation_failed"]);
  assert.deepEqual(codes("401").properties.code.enum, ["auth_session_invalid"]);
  assert.deepEqual(codes("413").properties.code.enum, ["payload_too_large"]);
  const named = document.paths[`${fixturePath}/{name}`]?.get as Record<string, any>;
  assert.deepEqual(named.responses["404"].content["application/json"].schema.properties.code.enum, [
    "fixture_not_found",
  ]);
  assert.deepEqual(
    named.parameters.map((p: { in: string; name: string }) => `${p.in} ${p.name}`),
    ["path workspaceId", "path name", "query greeting"],
  );

  await withMetadata(API_ROUTE_METADATA, undefined, FixtureController.prototype.read, () =>
    assert.rejects(
      build(),
      appError("openapi_route_undocumented", { routes: [`GET ${fixturePath}`] }),
    ),
  );

  // alpha-p2-030's @Idempotent() route: its Idempotency-Key, a required UUID, and the codes it answers.
  const loader = { name: "protect", load: () => import("./fixtures/protection/index.ts") };
  const modules = await loadModules([loader]);
  const health = {
    checks: new Map(),
    log: createLogger({ destination: collectLogs().destination }),
  };
  const routes = await mountedRoutes(rootModule({ modules, health }));
  const charges = routes.filter(({ path }) => path.endsWith("/charges"));
  const spec = { summary: "Charges once per key" };
  await withMetadata(API_ROUTE_METADATA, spec, ProtectionController.prototype.charge, async () => {
    const paths = openApiDocument(charges, "0.0.0").paths;
    const charge = paths["/v1/workspaces/{workspaceId}/protect/charges"]?.post as Record<
      string,
      any
    >;
    const header = charge.parameters.find((p: { in: string }) => p.in === "header");
    assert.deepEqual(
      [header.name, header.required, header.schema],
      ["Idempotency-Key", true, { type: "string", format: "uuid" }],
    );
    const codesOf = (status: string) =>
      charge.responses[status].content["application/json"].schema.properties.code.enum;
    assert.deepEqual(
      [codesOf("400"), codesOf("409"), codesOf("422")],
      [
        ["idempotency_key_required", "invalid_idempotency_key"],
        ["idempotency_key_conflict"],
        ["idempotency_key_reused"],
      ],
    );
  });
});

test("the generated client calls the fixture route, typed; a changed schema without regenerating fails web's check", async () => {
  const document = join(tmp, "openapi.json");
  const client = join(tmp, "client.generated.ts");
  writeFileSync(document, JSON.stringify(await build()));
  const generated = node(generator, document, client);
  assert.equal(generated.status, 0, generated.stderr);

  // Typed input and output: tsc refuses a wrong body, a route that does not exist and a wrong read.
  writeFileSync(
    join(tmp, "call.ts"),
    `import { createApiClient } from "./client.generated.ts";
const client = createApiClient({ baseUrl: "http://127.0.0.1" });
const params = { path: { workspaceId: "wsp" } };
export async function call(): Promise<number | undefined> {
  const { data } = await client.POST("${fixturePath}", { params, body: { name: "a", items: [{ qty: 1 }] } });
  // @ts-expect-error: qty is a number
  await client.POST("${fixturePath}", { params, body: { name: "a", items: [{ qty: "1" }] } });
  // @ts-expect-error: no such route
  await client.GET("/v1/workspaces/{workspaceId}/nowhere", { params });
  // @ts-expect-error: items is a number
  const wrong: string | undefined = data?.items;
  return wrong === undefined ? data?.items : 0;
}
`,
  );
  const tsc = join(repoDir, "node_modules", "typescript", "bin", "tsc");
  const flags = [
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--allowImportingTsExtensions",
  ];
  const typed = node(
    tsc,
    ...flags,
    "--module",
    "nodenext",
    "--target",
    "es2024",
    join(tmp, "call.ts"),
  );
  assert.equal(typed.status, 0, typed.stdout);

  const { createApiClient } = await import(pathToFileURL(client).href);
  const cookie = signInAs("usr_fixture")
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  // A cookie-carrying change sends the app's origin (alpha-p2-030's origin check).
  const headers = { cookie, origin: dev.appOrigin };
  const answer = await createApiClient({ baseUrl: api.url, headers }).POST(fixturePath, {
    params: { path: { workspaceId: FIXTURE_WORKSPACE } },
    body: { name: "a", items: [{ qty: 1 }, { qty: 2 }] },
  });
  assert.deepEqual([answer.response.status, answer.data], [200, { items: 2 }]);
  // The body reader answers before the @ApiRoute check: a body it does not read is 415, not 400.
  const url = new URL(fixturePath.replace("{workspaceId}", FIXTURE_WORKSPACE), api.url);
  const text = { ...headers, "content-type": "text/plain" };
  const unread = await fetch(url, { method: "POST", headers: text, body: "{}" });
  assert.equal(unread.status, 415);

  const route = Reflect.getMetadata(API_ROUTE_METADATA, FixtureController.prototype.create);
  const changed = { ...route, response: z.strictObject({ items: z.string() }) };
  await withMetadata(API_ROUTE_METADATA, changed, FixtureController.prototype.create, async () => {
    writeFileSync(document, JSON.stringify(await build()));
  });
  const stale = node(generator, "--check", document, client);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /older than the api's document: run pnpm client:generate/);
});

test("http:run runs fixture.http against the api with the dev environment, 200 each, with session:token's cookie", async () => {
  const auth = await getAdapter(authPort, "fake");
  await auth.configure({
    allowSignIn: async (email) => email === "dev@example.test",
    mail: { send: async () => undefined },
    users: { findOrCreateByEmail: async () => ({ id: "usr_fixture" }) },
  });
  const privateFile = join(tmp, "http-client.private.env.json");
  await sessionToken({ baseUrl: api.url, email: "dev@example.test", file: privateFile });
  assert.equal(
    readFileSync(privateFile, "utf8").includes('"sessionCookie": "whytide_session='),
    true,
  );

  const overrides = { baseUrl: api.url };
  const variables = loadVariables({ envFile, privateFile, environment: "dev", overrides });
  const results = await runHttpFile(fixtureHttp, variables);
  assert.deepEqual(
    results.map(({ method, status }) => `${method} ${status}`),
    ["GET 200", "POST 200", "GET 200"],
  );
});

test("a fixture route missing from every .http file fails openapi:build, named", async () => {
  const text = readFileSync(fixtureHttp, "utf8");
  const partial = join(tmp, "partial.http");
  writeFileSync(partial, text.slice(0, text.indexOf(`### GET ${fixturePath}/{name}`)));
  await assert.rejects(
    buildOpenApi({ modules: [fixture], httpFiles: [...apiCallFiles(), partial] }),
    appError("openapi_route_without_request", { routes: [`GET ${fixturePath}/{name}`] }),
  );
});

test("the document has no cookie or authorization and passes the secret-shape check; both outputs are git-ignored", async () => {
  const document = join(tmp, "openapi.json");
  const text = JSON.stringify(await build());
  writeFileSync(document, text);
  assert.doesNotMatch(text, /cookie|authori[sz]ation/i);
  const shapes = node(join(repoDir, "tools", "ci", "secret-shapes.ts"), document);
  assert.equal(shapes.stdout, "secret-shapes: ok, 1 file checked\n", shapes.stdout);

  const header = [{ name: "Cookie" }];
  await withMetadata(API_HEADERS_METADATA, header, FixtureController.prototype.read, () =>
    assert.rejects(build(), appError("openapi_secret_example")),
  );

  const outputs = [
    "core/apps/api/openapi.generated.json",
    "core/apps/web/src/api/client.generated.ts",
  ];
  const ignored = spawnSync("git", ["check-ignore", ...outputs], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.deepEqual(ignored.stdout.split("\n").filter(Boolean), outputs);
});
