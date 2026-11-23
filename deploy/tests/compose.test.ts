// The Compose file's rules, on compose.yaml as Compose reads it with every profile, nothing
// interpolated and no env file read: every container named `<project>-<service>`; the browser
// service (gamma-en-025) in its own profile, alone with the worker on an internal network, with no
// port, no volume, no environment file and its limits; and browser/Dockerfile on Playwright's image
// at the version of the playwright adapter's client, pinned and listed in images.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type Service = Record<string, unknown> & { readonly networks?: Record<string, unknown> };
type Config = {
  readonly services: Record<string, Service>;
  readonly networks: Record<string, Record<string, unknown>>;
};

const deploy = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${deploy}${path}`, "utf8");
const words = "config --no-interpolate --no-env-resolution --no-path-resolution --format json";
const config = JSON.parse(
  execFileSync(
    "docker",
    ["compose", "-f", `${deploy}compose.yaml`, "--profile", "*", ...words.split(" ")],
    { encoding: "utf8" },
  ),
) as Config;
const { browser, worker } = config.services;
const on = (service: Service | undefined) => Object.keys(service?.networks ?? {}).sort();

test("every container is named <project>-<service>", () => {
  for (const [name, service] of Object.entries(config.services)) {
    assert.equal(service.container_name, `\${COMPOSE_PROJECT_NAME:-whytide}-${name}`, name);
  }
});

test("the browser service: its own profile, built from browser/Dockerfile, on the browser network only, with no port, no volume and no environment", () => {
  assert.ok(browser, "the service");
  assert.deepEqual(browser.profiles, ["browser"]);
  assert.deepEqual(browser.build, { context: "./browser", dockerfile: "Dockerfile" });
  assert.deepEqual(on(browser), ["browser"]);
  for (const key of ["ports", "network_mode", "volumes", "env_file", "environment"]) {
    assert.equal(browser[key], undefined, key);
  }
});

test("the browser network is internal, and only the browser service and the worker are on it", () => {
  assert.equal(config.networks.browser?.internal, true);
  const members = Object.keys(config.services).filter((name) =>
    on(config.services[name]).includes("browser"),
  );
  assert.deepEqual(members.sort(), ["browser", "worker"]);
  assert.deepEqual(on(worker), ["browser", "default"]);
});

test("the browser service's limits: memory, CPU and processes, a read-only root with a small tmpfs, no capability, no new privileges", () => {
  const limits = [
    "mem_limit",
    "cpus",
    "pids_limit",
    "read_only",
    "tmpfs",
    "cap_drop",
    "cap_add",
    "privileged",
    "security_opt",
    "init",
  ];
  assert.deepEqual(Object.fromEntries(limits.map((key) => [key, browser?.[key]])), {
    mem_limit: "1g",
    cpus: 1,
    pids_limit: 1024,
    read_only: true,
    tmpfs: ["/tmp:size=256m"],
    cap_drop: ["ALL"],
    cap_add: undefined,
    privileged: undefined,
    security_opt: ["no-new-privileges:true"],
    init: true,
  });
});

test("browser/Dockerfile: Playwright's image at the client's version, pinned and listed in images.md; playwright at that version, without its scripts; run-server on 3000 as pwuser, without --unsafe", () => {
  const providers = JSON.parse(read("../core/packages/providers/package.json")) as {
    dependencies: Record<string, string>;
  };
  const version = providers.dependencies["playwright-core"] ?? "";
  // Its instructions: the comments name what it never does.
  const dockerfile = read("browser/Dockerfile")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const [image, digest = ""] = (/^FROM (\S+)$/m.exec(dockerfile)?.[1] ?? "").split("@");
  assert.equal(image, `mcr.microsoft.com/playwright:v${version}-noble`);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  const listed = read("images.md")
    .split("\n")
    .some((line) => line.includes(`\`${image}\``) && line.includes(`\`${digest}\``));
  assert.ok(listed, `${image} in images.md`);
  const install = `RUN npm install --global --ignore-scripts playwright@${version} `;
  assert.ok(dockerfile.includes(`\n${install}`), install);
  assert.match(dockerfile, /^USER pwuser$/m);
  const command = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)?.[1] ?? "[]") as string[];
  assert.deepEqual(command, [
    ...["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"],
    ...["--max-clients", "2"],
  ]);
  assert.doesNotMatch(dockerfile, /--unsafe|playwright install/);
});
