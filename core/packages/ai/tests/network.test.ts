// Nothing leaves the process (README.md "Mastra's guardrails"). Every way out Mastra's code has is
// refused and recorded before the package loads: the global fetch, TCP and TLS sockets (http,
// https, ws and undici open them), DNS lookups and child processes. The variables that would start
// Mastra's telemetry and its provider refresh are set; the guard overwrites or unsets them.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const reached: string[] = [];
const refuse =
  (what: string) =>
  (...args: unknown[]): never => {
    reached.push(`${what} ${String(args[0])}`);
    throw new Error(`refused: ${what}`);
  };
globalThis.fetch = refuse("fetch");
net.Socket.prototype.connect = refuse("net.Socket.connect");
dns.lookup = refuse("dns.lookup") as never;
dns.promises.lookup = refuse("dns.promises.lookup");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  Object.assign(childProcess, { [name]: refuse(`child_process.${name}`) });
}
syncBuiltinESMExports();
// MASTRA_DEV also has Mastra copy the provider list of ~/.cache/mastra into its own dist/, offline
// too: an empty home keeps this test from rewriting node_modules with the cache of the machine.
const home = mkdtempSync(join(tmpdir(), "whytide-ai-home-"));
after(() => rmSync(home, { recursive: true, force: true }));
Object.assign(process.env, {
  HOME: home,
  MASTRA_DEV: "true",
  MASTRA_AUTO_REFRESH_PROVIDERS: "true",
  MASTRA_OFFLINE: "false",
  MASTRA_TELEMETRY_DISABLED: "false",
});

const { loadAgentTasks, registeredAgentTasks, runAgent } = await import("../index.ts");
const { listTaskFiles } = await import("../registry/generate.ts");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { trackFeatureUsage } = await import("@mastra/core/telemetry");

it("reaches nothing: a task run end to end, then Mastra's telemetry", async () => {
  assert.equal(process.env.MASTRA_OFFLINE, "true");
  assert.equal(process.env.MASTRA_TELEMETRY_DISABLED, "true");
  assert.equal(process.env.MASTRA_DEV, undefined);
  const fake = (await getAdapter(llmPort, "fake")) as unknown as { script(o: object): void };
  fake.script({ verdict: "met" });
  await loadAgentTasks(listTaskFiles(join(import.meta.dirname, "fixtures/registry")));
  const task = registeredAgentTasks().get("fixture.assess");
  assert.ok(task);
  const run = await runAgent(task, { profile: "Head of data", evidence: ["Hiring"] });
  assert.equal(run.ok, true);
  trackFeatureUsage("whytide_network_test");
  await sleep(200);
  assert.deepEqual(reached, []);
});

it("would have caught Mastra's telemetry: on, it runs git and posts to posthog", async () => {
  // Posthog alone is answered rather than refused, or its client would retry for nine seconds. Any
  // other URL is still refused: answered, a models.dev fetch let a broken guard write an empty
  // provider list into node_modules.
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("https://us.posthog.com/")) refuse("fetch")(url);
    reached.push(`fetch ${String(url)}`);
    return new Response("{}");
  };
  process.env.MASTRA_TELEMETRY_DISABLED = "false";
  trackFeatureUsage("whytide_network_test");
  for (let i = 0; i < 100 && !reached.some((r) => r.startsWith("fetch")); i++) await sleep(20);
  process.env.MASTRA_TELEMETRY_DISABLED = "true";
  assert.ok(reached.includes("child_process.execFile git"), reached.join("; "));
  assert.ok(
    reached.some((r) => r.startsWith("fetch https://us.posthog.com/")),
    reached.join("; "),
  );
});
