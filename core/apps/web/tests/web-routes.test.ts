// The route generator (scripts/web-routes.ts) on the trees of tests/fixtures/routes/, and the Next.js
// settings that keep the host off the network (README "Run").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import config from "../next.config.ts";
import { nextEnv } from "../scripts/next.ts";
import {
  collect,
  collectMounts,
  type NavEntry,
  navigation,
  writeRoutes,
} from "../scripts/web-routes.ts";

const tree = (name: string) => join(import.meta.dirname, "fixtures", "routes", name);

test("two modules declaring the same segment fail web:routes, naming both", async () => {
  const message =
    "the segment list is declared twice: core/modules/a/ui/nav.ts and core/modules/b/ui/nav.ts";
  await assert.rejects(collect(tree("duplicate"), false), { message });
});

test("a panel in a slot that its page does not list fails web:routes, naming the page's slots", async () => {
  const message = "core/modules/b/ui/nav.ts: the slot sidebar is none of the page a.item's: side";
  await assert.rejects(collectMounts(tree("unknown-slot"), false), { message });
});

test("the navigation keeps the groups' order and sorts each group's entries by order", () => {
  const entry = (group: NavEntry["group"], segment: string, order: number): NavEntry => {
    const labelKey = `m.nav.${segment}`;
    return { group, labelKey, segment, screen: segment, order, dir: "m", file: "m/ui/nav.ts" };
  };
  const entries = [entry("leads", "b", 20), entry("company", "c", 5), entry("leads", "a", 10)];
  const shown = navigation(entries).map(({ group, entries }) => [
    group,
    entries.map((e) => e.segment),
  ]);
  assert.deepEqual(shown, [
    ["company", ["c"]],
    ["leads", ["a", "b"]],
  ]);
});

test("the production build fails when a screen uses a key no messages file defines", async () => {
  const build = writeRoutes(tree("missing-key"), { fixtures: false, production: true }); // build's first step
  await assert.rejects(
    build,
    /the message-key check failed:\n.*missing-key the key a\.list\.missing/,
  );
});

test("next runs with telemetry, the agent checks and the image optimizer off", () => {
  assert.equal(config.output, "standalone");
  assert.equal(config.images?.unoptimized, true);
  assert.equal(config.agentRules, false);
  assert.equal(config.experimental?.agentUpgrade, false);
  const env = nextEnv({ API_PORT: "4000" }, undefined);
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(env.NEXT_DISABLE_SWC_WASM, "1");
  assert.equal(env.NEXT_PUBLIC_API_URL, "http://127.0.0.1:4000");
  const { scripts } = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  );
  for (const script of Object.values<string>(scripts))
    assert.doesNotMatch(script, /(^|&&\s*)next\s/);
});
