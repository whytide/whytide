// The production environment end to end (README.md "Production"), `pnpm -F deploy smoke`: the images
// of images:build, then the Compose project with the production profile as a server runs it, from
// .env.production.example with its secrets filled, on Caddy's own authority and free localhost
// ports, as a project of its own next to the laptop's stack, which it never touches. In order: the
// smoke (health, the migrations, a web page, a sign-in followed through Caddy), the containers, the
// master keys and the images, the webhook path and the closed admin endpoint, then the backup
// drill. The project goes at the end with its volumes, whatever happened; PRODTEST_KEEP=1 leaves it
// running.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "../scripts/deploy-check.ts";
import { deployDir, filledProductionEnv, readDeployFile } from "./env-fixture.ts";

const project = "whytide-prodtest";
const tag = "prodtest";
const domain = "whytide.test";
const email = "owner@whytide.test";
const root = join(deployDir, "..");
const work = join(root, ".tmp", "prodtest");
const copy = join(work, "deploy");
const words = (text: string) => text.split(" ");

let env: NodeJS.ProcessEnv = process.env;
let ports = { http: 0, https: 0 };
let ca = Buffer.alloc(0);
let fixture = { workspaceId: "", link: "" };
let session = "";

function run(command: string, ...args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", env, maxBuffer: 1 << 26 });
  return { status: result.status, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
}
const compose = (...args: string[]) =>
  run("docker", "compose", "-f", join(copy, "compose.yaml"), ...args);
/** docker compose in the test's project; the test fails unless it exits 0. */
function dc(...args: string[]): string {
  const result = compose(...args);
  assert.equal(result.status, 0, `docker compose ${args.join(" ")}:\n${result.err}${result.out}`);
  return result.out.trim();
}
const inspect = (ref: string, format: string) =>
  run("docker", "inspect", "-f", format, ref).out.trim();
const psql = (sql: string) => dc(...words("exec -T postgres psql -U postgres -d app -At -c"), sql);
/** A script that Node runs in the api's container; its last line of output, parsed as JSON. */
const inApi = (script: string) =>
  JSON.parse(
    dc("exec", "-T", "api", "node", "--input-type=module", "-e", script).split("\n").at(-1) ?? "",
  );
const removeProject = () => compose(...words("--profile * down --volumes --remove-orphans -t 5"));

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
type Init = { method?: string; headers?: Record<string, string>; body?: string };
/** A request to Caddy's published port, for APP_DOMAIN, over TLS checked against Caddy's authority. */
function call(secure: boolean, path: string, init: Init = {}): Promise<Answer> {
  const port = secure ? ports.https : ports.http;
  const headers = { host: `${domain}:${port}`, ...init.headers };
  const options = {
    host: "127.0.0.1",
    port,
    path,
    method: init.method,
    headers,
    servername: domain,
    ca,
  };
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(options, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject).setTimeout(15_000, () => req.destroy(new Error(`${path}: no answer`)));
    req.end(init.body);
  });
}
const https = (path: string, init?: Init) => call(true, path, init);

async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  const listening = servers.map(
    (server) =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
      ),
  );
  const found = await Promise.all(listening);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return found;
}

/** A /28 under 10.250.0.0/16 that no Docker network here overlaps, for the edge network. */
function freeEdgePrefix(): string {
  const networks = run("docker", "network", "ls", "-q").out.split("\n").filter(Boolean);
  const subnets = run(
    "docker",
    "network",
    "inspect",
    "-f",
    "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
    ...networks,
  );
  const span = (cidr: string) => {
    const [address = "", bits = "32"] = cidr.split("/");
    const value = address.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
    const size = 2 ** (32 - Number(bits));
    return [value - (value % size), value - (value % size) + size - 1];
  };
  const taken = subnets.out
    .split(/\s+/)
    .filter((cidr) => /^[\d.]+\/\d+$/.test(cidr))
    .map(span);
  for (let third = 70; third < 255; third++) {
    const [start = 0, end = 0] = span(`10.250.${third}.0/28`);
    if (taken.every(([from = 0, to = 0]) => to < start || from > end)) return `10.250.${third}`;
  }
  throw new Error("no free /28 under 10.250.0.0/16");
}

/** Caddy's root certificate, made at its first start in its volume. */
async function rootCertificate(): Promise<Buffer> {
  const file = join(work, "root.crt");
  for (let attempt = 0; attempt < 30; attempt++) {
    fs.rmSync(file, { force: true });
    compose("cp", "caddy:/data/caddy/pki/authorities/local/root.crt", file);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    await delay(1000);
  }
  throw new Error("Caddy made no root certificate");
}

/** Every table of `app` by its row count and a hash of its rows, and the fixture file's hash. */
function state() {
  const tables = psql(
    "select format('%I.%I', schemaname, tablename) from pg_tables " +
      "where schemaname in ('public', 'mastra') order by 1",
  ).split("\n");
  const sums = tables.map(
    (table) =>
      `select '${table}' t, count(*), md5(string_agg(r::text, '|' order by r::text)) from ${table} r`,
  );
  const file = inApi(`
    import { createHash } from "node:crypto";
    const providers = await import("/app/core/packages/providers/dist/index.js");
    const files = await providers.getAdapter(providers.filesPort, providers.filesConfig.PROVIDER_FILES);
    const file = await files.get({ workspaceId: "${fixture.workspaceId}", key: "imports/fixture.csv" });
    const hash = createHash("sha256");
    for await (const chunk of file.body) hash.update(chunk);
    console.log(JSON.stringify(hash.digest("hex")));
    process.exit(0);`);
  return { tables: psql(`select * from (${sums.join(" union all ")}) s order by 1`), file };
}

before(async () => {
  const [http = 0, httpsPort = 0, ...stack] = await freePorts(7);
  ports = { http, https: httpsPort };
  const origin = `https://${domain}:${httpsPort}`;
  const text = filledProductionEnv({
    COMPOSE_PROJECT_NAME: project,
    APP_DOMAIN: domain,
    CADDY_INTERNAL_TLS: "1",
    CADDY_HTTP_PUBLISH: `127.0.0.1:${http}`,
    CADDY_HTTPS_PUBLISH: `127.0.0.1:${httpsPort}`,
    IMAGE_TAG: tag,
    EDGE_PREFIX: freeEdgePrefix(),
    ...Object.fromEntries(
      ["POSTGRES", "REDIS", "TEMPORAL", "MINIO", "MINIO_CONSOLE"].map((name, i) => [
        `DEV_${name}_PORT`,
        String(stack[i]),
      ]),
    ),
    // The test run's adapters: the sign-in link through the mail port's fake, no vendor called.
    PROVIDER_APP_MAIL: "fake",
    PROVIDER_LINKEDIN: "fake",
    PROVIDER_LLM: "fake",
    AUTH_BASE_URL: origin,
    APP_PUBLIC_ORIGIN: origin,
    API_PUBLIC_URL: `${origin}/api`,
    UNIPILE_NOTIFY_URL: `${origin}/v1/linkedin/webhooks/unipile`,
  });
  fs.rmSync(work, { recursive: true, force: true });
  for (const entry of [
    "compose.yaml",
    "Caddyfile",
    "postgres",
    "minio",
    "backup.sh",
    "restore.sh",
  ]) {
    fs.cpSync(join(deployDir, entry), join(copy, entry), { recursive: true });
  }
  fs.writeFileSync(join(copy, ".env"), text, { mode: 0o600 });
  // The copy's .env decides, never this process's environment, which Compose would let win.
  env = { ...process.env };
  for (const key of [...parseEnv(text).keys(), "COMPOSE_FILE", "COMPOSE_PROFILES"]) delete env[key];
  env.COMPOSE_PROJECT_NAME = project;
  removeProject();
  const build = spawnSync("bash", [join(deployDir, "scripts", "images-build.sh"), "--tag", tag], {
    env,
    stdio: "inherit",
  });
  assert.equal(build.status, 0, "images:build failed");
  dc(...words("up -d --wait --wait-timeout 300"));
  ca = await rootCertificate();
});

after(() => {
  if (process.env.PRODTEST_KEEP === "1") return;
  removeProject();
  fs.rmSync(work, { recursive: true, force: true });
});

test("smoke: TLS with HSTS at Caddy, health, the migrations, a sign-in link followed", async () => {
  const health = await https("/api/health");
  assert.equal(health.status, 200, health.body);
  assert.equal(health.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(health.headers.server, undefined);
  assert.equal(JSON.parse(health.body).checks.migrations, "ok", health.body);
  const plain = await call(false, "/sign-in");
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.location, `https://${domain}/sign-in`);
  // The web app through Caddy: a page under the policy of the web's proxy.ts, with its nonce and no
  // second policy from Caddy, with HSTS and alpha-p2-030's headers. The sign-in page is alpha-p3-040's,
  // which asserts here that /sign-in answers 200 with its form.
  const page = await https("/sign-in");
  assert.match(`${page.headers["content-type"]}`, /^text\/html/);
  const policy = `${page.headers["content-security-policy"]}`;
  assert.match(policy, /^default-src 'self'; script-src 'self' 'nonce-[\w+/=]+' 'strict-dynamic'/);
  assert.doesNotMatch(policy, /,/, "one policy, the web's");
  assert.equal(page.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  const folders = fs.readdirSync(join(root, "core/packages/db/prisma/migrations"), {
    withFileTypes: true,
  });
  const applied = psql("select count(*) from _prisma_migrations where finished_at is not null");
  assert.equal(Number(applied), folders.filter((entry) => entry.isDirectory()).length);

  // The fixture, and the link the sign-in page will ask for (alpha-p3-040), made in the api's
  // container: an organization with its workspace and owner, and a file through the files port.
  fixture = inApi(`
    const tenancy = await import("/app/core/modules/tenancy/dist/index.js");
    const identity = await import("/app/core/modules/identity/dist/index.js");
    const providers = await import("/app/core/packages/providers/dist/index.js");
    const { appMailFake } = await import("/app/core/packages/providers/dist/app-mail/fake/index.js");
    const user = await tenancy.upsertUser({ email: "${email}" });
    const { workspace } = await tenancy.bootstrapOrganization({
      name: "Fixture", workspaceSlug: "fixture", ownerUserId: user.id });
    const files = await providers.getAdapter(providers.filesPort, providers.filesConfig.PROVIDER_FILES);
    await files.put({ workspaceId: workspace.id, key: "imports/fixture.csv", body: "name\\nAda\\n",
      contentType: "text/csv" });
    const auth = await providers.getAdapter(providers.authPort, providers.authConfig.PROVIDER_AUTH);
    await auth.configure(identity.authHooks);
    await auth.requestMagicLink({ email: "${email}", redirectTo: "/" });
    const { text } = await appMailFake.read({ to: "${email}" });
    console.log(JSON.stringify({ workspaceId: workspace.id, link: /https:\\S+/.exec(text)[0] }));
    process.exit(0);`);
  const link = new URL(fixture.link);
  assert.equal(link.origin, `https://${domain}:${ports.https}`);
  // Followed as the confirm page does (core/packages/providers/auth/confirm.ts): the GET signs no one
  // in and answers that page; its POST, from the app's own origin, signs in.
  const path = `${link.pathname}${link.search}`;
  const confirm = await https(path);
  assert.equal(confirm.status, 303, confirm.body);
  assert.match(`${confirm.headers.location}`, /^\/sign-in\/confirm\?link=/);
  assert.equal(confirm.headers["set-cookie"], undefined);
  const followed = await https(path, { method: "POST", headers: { origin: link.origin } });
  assert.equal(followed.status, 303, followed.body);
  session = followed.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
  assert.match(session, /^__Host-whytide_session=./);
  const me = await https("/api/v1/me", { headers: { cookie: session } });
  assert.equal(me.status, 200, me.body);
  assert.equal(JSON.parse(me.body).user.email, email);
});

test("containers: non-root, read-only root file systems, the pinned bases, the engine offline", () => {
  for (const service of ["api", "worker", "web", "caddy"]) {
    const id = dc("ps", "-q", service);
    assert.equal(inspect(id, "{{.HostConfig.ReadonlyRootfs}}"), "true", `${service}: read-only`);
    assert.notEqual(dc("exec", "-T", service, "id", "-u"), "0", `${service}: root`);
    assert.notEqual(run("docker", "exec", id, "touch", "/probe").status, 0, `${service} wrote /`);
  }
  const images = readDeployFile("images.md").split("\n");
  const listed = (ref: string) =>
    images.some((line) => ref.split("@").every((part) => line.includes(`\`${part}\``)));
  const node = /^FROM (\S+@sha256:[0-9a-f]{64}) AS base$/m.exec(readDeployFile("Dockerfile"))?.[1];
  const caddy = /^ {4}image: (caddy:\S+)$/m.exec(readDeployFile("compose.yaml"))?.[1];
  assert.ok(node && listed(node) && caddy && listed(caddy), `${node}, ${caddy} in images.md`);
  const layers = (ref: string): string[] => JSON.parse(inspect(ref, "{{json .RootFS.Layers}}"));
  for (const app of ["api", "worker", "web"]) {
    const built = layers(`localhost/whytide/${app}:${tag}`);
    assert.deepEqual(built.slice(0, layers(node).length), layers(node), `${app} on ${node}`);
  }
  assert.equal(inspect(dc("ps", "-q", "caddy"), "{{.Image}}"), inspect(caddy, "{{.Id}}"));
  // TRUST_PROXY is Caddy's address; Postgres's superuser password stays out of the apps.
  const edge = `{{(index .NetworkSettings.Networks "${project}_edge").IPAddress}}`;
  assert.equal(
    dc(...words("exec -T api printenv TRUST_PROXY")),
    inspect(dc("ps", "-q", "caddy"), edge),
  );
  assert.equal(dc(...words("exec -T api printenv DEV_POSTGRES_PASSWORD")), "");
  // The master keys load as at the api's first secret: APP_MASTER_KEY's, and no previous one.
  const keys = inApi(`
    const { loadMasterKeys } = await import("/app/core/packages/platform/dist/index.js");
    const keys = loadMasterKeys();
    console.log(JSON.stringify([keys.current.keyVersion.length, keys.previous ?? null]));
    process.exit(0);`);
  assert.deepEqual(keys, [16, null]);
  assert.equal(
    compose(...words("exec -T web printenv AUTH_SECRET")).status,
    1,
    "a secret in the web",
  );
  // The pinned schema engine: migrate deploy with no cache and Prisma's downloads unreachable.
  const offline =
    "-e HOME=/tmp/none -e PRISMA_ENGINES_MIRROR=http://127.0.0.1:9 -w /app/core/packages/db";
  const migrate =
    "node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts";
  assert.match(dc(...words(`exec -T ${offline} api ${migrate}`)), /No pending migrations/);
});

test("the webhook path reaches the api through Caddy; the admin endpoint is closed", async () => {
  // linkedin serves POST /v1/linkedin/webhooks/:provider. The test runs PROVIDER_LINKEDIN=fake, so
  // the module refuses unipile's with its JSON 401 and changes nothing: the request reached the api.
  const headers = { "content-type": "application/json" };
  const webhook = await https("/v1/linkedin/webhooks/unipile", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(webhook.status, 401, webhook.body);
  assert.match(`${webhook.headers["content-type"]}`, /^application\/json/);
  assert.deepEqual(JSON.parse(webhook.body), {
    code: "linkedin_webhook_invalid",
    details: { reason: "provider" },
  });
  const other = await https("/v1/linkedin/other");
  assert.doesNotMatch(
    `${other.headers["content-type"]}`,
    /json/,
    "only /v1's webhooks reach the api",
  );
  // Caddy publishes 80 and 443 only, the api nothing, and no container reaches Caddy's 2019.
  const published = run("docker", "port", dc("ps", "-q", "caddy"))
    .out.trim()
    .split("\n");
  assert.deepEqual(published.map((line) => line.split(" ")[0]).sort(), [
    "443/tcp",
    "443/udp",
    "80/tcp",
  ]);
  assert.equal(run("docker", "port", dc("ps", "-q", "api")).out.trim(), "");
  const reach = `const reach = (url) => fetch(url, { redirect: "manual" }).then(() => "open", () => "closed");`;
  const probe = `${reach} console.log(JSON.stringify([await reach("http://caddy:80/"), await reach("http://caddy:2019/config/")]));`;
  assert.deepEqual(inApi(probe), ["open", "closed"]);
});

test("backup drill: backup.sh, the project gone with its volumes, restore.sh, under ten minutes", async () => {
  // The worker runs its schedules throughout. Qualification's tick reads each workspace's ICP, and the
  // first read makes it with six criteria (core/modules/icp/README.md "Public interface"), so the drill
  // runs the tick through its schedule and snapshots after that write, the last the schedules make
  // for this fixture: no tick writes again, before the backup or once the restored worker starts.
  dc(...words("exec -T temporal temporal schedule trigger --schedule-id qualification.batch_tick"));
  const deadline = Date.now() + 60_000;
  while (psql("select count(*) from icps") !== "1") {
    assert.ok(Date.now() < deadline, "qualification's tick made no ICP in a minute");
    await delay(1000);
  }
  const before = state();
  const backups = join(work, "backups");
  fs.mkdirSync(join(backups, "20200101T000000Z"), { recursive: true });
  fs.mkdirSync(join(backups, "notes"));
  const started = Date.now();
  const made = run("bash", join(copy, "backup.sh"), backups, "--keep", "1");
  assert.equal(made.status, 0, made.err);
  const stamp = fs.readdirSync(backups).find((name) => /^\d{8}T\d{6}Z$/.test(name)) ?? "";
  assert.deepEqual(
    fs.readdirSync(backups).sort(),
    [stamp, "notes"],
    "the old backup goes, only it",
  );
  assert.equal(
    run("bash", join(copy, "restore.sh"), join(backups, stamp)).status,
    1,
    "not over data",
  );
  removeProject();
  const restored = run("bash", join(copy, "restore.sh"), join(backups, stamp));
  assert.equal(restored.status, 0, `${restored.err}${restored.out}`);
  const seconds = Math.round((Date.now() - started) / 1000);
  assert.ok(seconds < 600, `the drill took ${seconds} s`);
  ca = await rootCertificate(); // a fresh caddy-data volume, so a new authority
  assert.deepEqual(state(), before);
  const me = await https("/api/v1/me", { headers: { cookie: session } });
  assert.equal(me.status, 200, "the session came back with the database");
});
