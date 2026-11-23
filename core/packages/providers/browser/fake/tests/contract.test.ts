// The fake's contract suite (../../README.md "The contract suite"), in the world of world.ts, then the
// fake's own: seedPage's keys as the URL parser writes them, the defaults of the final URL and the
// status, a copy per answer, anything unseeded browser_blocked, and create() under
// APP_ENV=production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { browserCases } from "../../contract.ts";
import { browserPort } from "../../port.ts";
import { browserFake, browserFakeAdapter } from "../index.ts";
import { fakeWorld, PAGE, PAGE_URL } from "./world.ts";

contractSuite(browserPort, browserFakeAdapter, browserCases(fakeWorld(browserFake)));

/** The fake bound as the registry binds it, reset. */
function boundFake() {
  const browser = bindPort(browserPort, browserFakeAdapter.create(), { adapter: "fake" });
  browserFake.reset();
  return browser;
}
const blocked = (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, error.details], ["browser_blocked", { reason: "not_seeded" }]);
  return true;
};

test("seedPage keys a page by its URL as the parser writes it; the final URL is that URL and the status 200 unless seeded; each answer is a copy; anything unseeded is browser_blocked", async () => {
  const browser = boundFake();
  const text = "Granite Orbit Works";
  browserFake.seedPage("HTTPS://Granite-Orbit.example", { text, links: [] });
  browserFake.seedPage(PAGE_URL, PAGE);
  const granite = { finalUrl: "https://granite-orbit.example/", status: 200, text, links: [] };
  assert.deepEqual(await browser.renderPage({ url: "https://granite-orbit.example/" }), granite);
  assert.deepEqual(await browser.renderPage({ url: "https://GRANITE-ORBIT.example" }), granite);
  const answer = await browser.renderPage({ url: PAGE_URL });
  assert.deepEqual(answer, PAGE);
  answer.links.push({ href: "https://changed.example/", text: "Changed" });
  assert.deepEqual(await browser.renderPage({ url: PAGE_URL }), PAGE, "an answer is a copy");
  assert.equal(browserFake.state.rendered, 4);
  for (const url of ["https://granite-orbit.example/other", "http://granite-orbit.example/"]) {
    await assert.rejects(browser.renderPage({ url }), blocked, url);
  }
  assert.equal(browserFake.state.rendered, 4, "a refused URL renders nothing");
  browserFake.reset();
  await assert.rejects(browser.renderPage({ url: PAGE_URL }), blocked, "reset clears the seeds");
});

test("seedPage takes an http or https URL only", () => {
  for (const url of ["file:///etc/passwd", "ftp://ftp.example.test/", "example.test/about"]) {
    assert.throws(() => browserFake.seedPage(url, { text: "", links: [] }), TypeError, url);
  }
});

test("create() refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../port.ts"));
  const script = [
    `const { browserFakeAdapter } = await import(${fake});`,
    `const { getAdapter } = await import(${registry});`,
    `const { browserPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => browserFakeAdapter.create());",
    "const registered = await outcome(() => getAdapter(browserPort, 'fake'));",
    "console.log(`${direct} ${registered}`);",
  ].join("\n");
  const runAs = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(({ stdout }) => `${APP_ENV} ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["test", "production"].map(runAs)), [
    "test created created",
    "production adapter_invalid adapter_invalid",
  ]);
});
