// The settings of env-settings-b through the api host (core/modules/identity/README.md, credits',
// enrichment's, signals' and onboarding's README "Settings"): the host started with identity and
// onboarding, on the fake authentication adapter, in a schema of the worktree's database, with an
// invite open 14 days and 10 documents of 20 MB set before anything loads. The answers the two
// screens read carry them: the invites' list its ttlDays, the Company Knowledge its documentLimits;
// a Draft takes ten documents and refuses eleven, and seven of 50,000 three-byte characters, past the
// 1 MB of the other routes, start one: the Draft's own body limit is 10 MB (draft-body-10mb). Then the OpenAPI document of the five modules' routes,
// built in a process of its own with the sixteen module settings and the lookup at find's switch unset, set small and set large, is the
// same: no schema or summary reads them. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const APP_ORIGIN = "https://app.whytide.test";
const MB = 1024 * 1024;
// The host and the modules read them as they load: set before anything of them is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
process.env.IDENTITY_INVITE_TTL_DAYS = "14";
process.env.ONBOARDING_MAX_FILES = "10";
process.env.ONBOARDING_MAX_FILE_BYTES = String(20 * MB);
const { databaseUrl } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger } = await import("@whytide/platform");
const { signInAs } = await import("@whytide/providers/auth/testing");
const { createTwoWorkspaces, useTenancyClient } = await import("@whytide/tenancy/testing");
const { start } = await import("../src/start.ts");

// onboarding and the others by their builds' paths, as src/modules.generated.ts loads them.
const build = (path: string) => new URL(`../../../../modules/${path}`, import.meta.url).href;
const db = withTestDb();
useTenancyClient(asRole("app"));
let api: Awaited<ReturnType<typeof start>>;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "onboarding", load: () => import(build("onboarding/dist/index.js")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** A call of the user's to /v1/workspaces/:ws`path`; a POST with the app's Origin and a new key. */
async function call(userId: string, workspaceId: string, path: string, body?: object) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const write = { origin: APP_ORIGIN, "content-type": "application/json" };
  const res = await fetch(new URL(`/v1/workspaces/${workspaceId}${path}`, api.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      ...(body === undefined ? {} : { ...write, "idempotency-key": randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("set to 14 days and 10 files of 20 MB, the answers the two screens read carry them: the invites' list its ttlDays, the Company Knowledge its documentLimits", async () => {
  const [a] = await createTwoWorkspaces();
  const list = await call(a.user.id, a.workspace.id, "/identity/invites");
  assert.deepEqual([list.status, list.body.ttlDays], [200, 14]);
  const record = await call(a.user.id, a.workspace.id, "/onboarding/company-knowledge");
  assert.deepEqual(
    [record.status, record.body.documentLimits],
    [200, { files: 10, bytes: 20 * MB }],
  );
});

test("10 files: a Draft of ten documents starts, eleven are documents_too_many; seven of 50,000 three-byte characters, past 1 MB, start a Draft: its body takes 10 MB", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const docs = (count: number, text: (at: number) => string) =>
    Array.from({ length: count }, (_, at) => ({
      ...{ name: `part-${at}.txt`, mediaType: "text/plain", status: "read", text: text(at) },
    }));
  const draft = (documents: object[]) =>
    call(a.user.id, workspaceId, "/onboarding/company-knowledge/draft", { documents });
  const app = asRole("app");
  const drafts = () =>
    app.outboxEntry.count({ where: { workspaceId, eventName: "onboarding.draft_requested" } });
  const ten = await draft(docs(10, (at) => `Part ${at}`));
  assert.deepEqual([ten.status, ten.body.fetchStatus, await drafts()], [202, "fetching", 1]);
  const eleven = await draft(docs(11, (at) => `Part ${at}`));
  const tooMany = { code: "documents_too_many", details: { files: 10 } };
  assert.deepEqual([eleven.status, eleven.body], [400, tooMany]);
  const wide = await draft(docs(7, () => "中".repeat(50_000)));
  assert.deepEqual([wide.status, wide.body.fetchStatus, await drafts()], [202, "fetching", 2]);
  const stored = await app.companyDocument.count({ where: { workspaceId } });
  assert.equal(stored, 7, "the second Draft's seven documents replace the first's ten");
});

/** The variables of env-settings-b the api's modules read; ALERTS_REPEAT_MINUTES is the worker's. */
const NAMES = [
  "IDENTITY_INVITE_TTL_DAYS",
  "CREDITS_ALERT_THRESHOLDS",
  "CREDITS_PRICE_CHANGE_NOTICE_DAYS",
  "ENRICHMENT_EMAIL_VALID_DAYS",
  "ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS",
  "SIGNALS_READS_KEPT_FOR_SENDS",
  "SIGNALS_RATE_MAX_EVENTS_PER_RUN",
  "SIGNALS_RESEARCH_EVERY_DAYS",
  "SIGNALS_RESEARCH_RECHECK_DAYS",
  "SIGNALS_RESEARCH_SEARCHES_PER_RUN",
  "SIGNALS_RESEARCH_PAGES_PER_RUN",
  "SIGNALS_RESEARCH_COMPANIES_PER_RUN",
  "SIGNALS_RESEARCH_SITE_MAX_PAGES",
  "SIGNALS_CREDITS_PER_RESEARCHED_COMPANY",
  "SIGNALS_RESEARCH_PEOPLE_PER_COMPANY",
  "ONBOARDING_MAX_FILES",
  "ONBOARDING_MAX_FILE_BYTES",
  "ENRICHMENT_LOOKUP_AT_FIND",
] as const;
/** The page-reading agent's model (gamma-wr-046): a name the agent's task reads, never a route's. */
const MODEL = "AI_MODEL_SIGNALS_RESEARCH_READ_PAGE";
/** The result-reading agent's model (gamma-wr-090), the same. */
const RESULT_MODEL = "AI_MODEL_SIGNALS_RESEARCH_READ_RESULT";
const MODULES = ["identity", "credits", "enrichment", "signals", "onboarding"] as const;

test("the OpenAPI document of identity's, credits', enrichment's, signals' and onboarding's routes is the same with the sixteen settings, the enrichment switch and the page-reading agent's model unset, set small and set large: no schema or summary reads them", () => {
  const href = (path: string) => JSON.stringify(build(path));
  /** The document a process with `set` builds, and the settings it read: openapi:build's own steps. */
  const built = (
    set: Partial<Record<(typeof NAMES)[number] | typeof MODEL | typeof RESULT_MODEL, string>>,
  ) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...set };
    for (const name of [...NAMES, MODEL, RESULT_MODEL]) if (!(name in set)) delete env[name];
    const script = [
      `const { apiCallFiles, buildOpenApi } = await import(${JSON.stringify(new URL("../openapi/build.js", import.meta.url).href)});`,
      "const modules = [",
      ...MODULES.map(
        (name) => `  { name: "${name}", load: () => import(${href(`${name}/dist/index.js`)}) },`,
      ),
      "];",
      "const document = await buildOpenApi({ modules, httpFiles: apiCallFiles() });",
      "const read = {};",
      ...MODULES.map(
        (name) =>
          `Object.assign(read, (await import(${href(`${name}/dist/settings.js`)})).settings);`,
      ),
      `const settings = ${JSON.stringify(NAMES)}.map((name) => read[name]);`,
      "process.stdout.write(JSON.stringify({ settings, document: JSON.stringify(document) }));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { settings: unknown[]; document: string };
  };
  const unset = built({});
  const small = built({
    IDENTITY_INVITE_TTL_DAYS: "1",
    CREDITS_ALERT_THRESHOLDS: "50",
    CREDITS_PRICE_CHANGE_NOTICE_DAYS: "1",
    ENRICHMENT_EMAIL_VALID_DAYS: "1",
    ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS: "1",
    SIGNALS_READS_KEPT_FOR_SENDS: "1",
    SIGNALS_RATE_MAX_EVENTS_PER_RUN: "1",
    SIGNALS_RESEARCH_EVERY_DAYS: "1",
    SIGNALS_RESEARCH_RECHECK_DAYS: "1",
    SIGNALS_RESEARCH_SEARCHES_PER_RUN: "1",
    SIGNALS_RESEARCH_PAGES_PER_RUN: "1",
    SIGNALS_RESEARCH_COMPANIES_PER_RUN: "1",
    SIGNALS_RESEARCH_SITE_MAX_PAGES: "1",
    SIGNALS_CREDITS_PER_RESEARCHED_COMPANY: "1",
    SIGNALS_RESEARCH_PEOPLE_PER_COMPANY: "1",
    ONBOARDING_MAX_FILES: "1",
    ONBOARDING_MAX_FILE_BYTES: "1",
    ENRICHMENT_LOOKUP_AT_FIND: "false",
    [MODEL]: "a-small-model",
    [RESULT_MODEL]: "a-small-model",
  });
  const large = built({
    IDENTITY_INVITE_TTL_DAYS: "1000",
    CREDITS_ALERT_THRESHOLDS: "1,50,99,100",
    CREDITS_PRICE_CHANGE_NOTICE_DAYS: "1000",
    ENRICHMENT_EMAIL_VALID_DAYS: "1000",
    ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS: "1000",
    SIGNALS_READS_KEPT_FOR_SENDS: "1000",
    SIGNALS_RATE_MAX_EVENTS_PER_RUN: "1000",
    SIGNALS_RESEARCH_EVERY_DAYS: "1000",
    SIGNALS_RESEARCH_RECHECK_DAYS: "1000",
    SIGNALS_RESEARCH_SEARCHES_PER_RUN: "1000",
    SIGNALS_RESEARCH_PAGES_PER_RUN: "1000",
    SIGNALS_RESEARCH_COMPANIES_PER_RUN: "1000",
    SIGNALS_RESEARCH_SITE_MAX_PAGES: "1000",
    SIGNALS_CREDITS_PER_RESEARCHED_COMPANY: "100",
    SIGNALS_RESEARCH_PEOPLE_PER_COMPANY: "10",
    ONBOARDING_MAX_FILES: "1000",
    ONBOARDING_MAX_FILE_BYTES: String(1000 * MB),
    ENRICHMENT_LOOKUP_AT_FIND: "true",
    [MODEL]: "a-large-model",
    [RESULT_MODEL]: "a-large-model",
  });
  assert.deepEqual(
    [unset.settings, small.settings, large.settings],
    [
      [7, [80, 95, 100], 30, 120, 30, 20, 100, 7, 180, 60, 40, 25, 5, 1, 3, 5, 10 * MB, true],
      [1, [50], 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, false],
      [
        1000,
        [1, 50, 99, 100],
        1000,
        1000,
        1000,
        1000,
        1000,
        1000,
        1000,
        1000,
        1000,
        1000,
        1000,
        100,
        10,
        1000,
        1000 * MB,
        true,
      ],
    ],
  );
  assert.equal(small.document, unset.document);
  assert.equal(large.document, unset.document);
  const draft = JSON.parse(unset.document).paths[
    "/v1/workspaces/{workspaceId}/onboarding/company-knowledge/draft"
  ].post.requestBody.content["application/json"].schema;
  assert.equal(draft.properties.documents.maxItems, undefined, "the count is requestDraft's");
});
