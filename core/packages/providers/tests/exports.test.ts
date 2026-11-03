// The package's test entries, imported as another package's tests import them: through the package
// name, from the build that `tsc -b` writes before the tests run. `./testing` is the contract
// harness; `./*/testing` in package.json exports each port's helpers as
// `@whytide/providers/<port>/testing`.
import assert from "node:assert/strict";
import { existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Each entry, the folder of dist/ it resolves to, the functions it exports. */
const ENTRIES: readonly (readonly [string, string, readonly string[]])[] = [
  ["@whytide/providers/testing", "testing", ["contractSuite"]],
  ["@whytide/providers/auth/testing", "auth/testing", ["signInAs"]],
  ["@whytide/providers/app-mail/testing", "app-mail/testing", ["loadEnvLocal", "readMailpit"]],
];

test("the contract harness and each port's test helpers import through the package name", async () => {
  for (const [entry, folder, functions] of ENTRIES) {
    const built = new URL(`../dist/${folder}/index.js`, import.meta.url).href;
    assert.equal(import.meta.resolve(entry), built);
    // A specifier in a variable: TypeScript leaves it to Node, which resolves it as a consumer's.
    const module = await import(entry);
    for (const name of functions) assert.equal(typeof module[name], "function", `${entry} ${name}`);
  }
  // The pattern opens testing/ folders only: a fake or an adapter stays the registry's.
  const fake = () => import.meta.resolve("@whytide/providers/llm/fake");
  assert.throws(fake, { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("a testing/ folder is the package's or a port's, beside its port.ts: the pattern exports no other", () => {
  // `*` in `./*/testing` spans folders, so an adapter's testing/ would be exported too. A port is a
  // folder with a port.ts and no leading `_`, as in the generator.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found = globSync("**/testing/index.ts", {
    cwd: root,
    exclude: ["node_modules/**", "dist/**"],
  });
  assert.ok(found.includes("auth/testing/index.ts"), found.join(", "));
  for (const file of found) {
    const [port = "", ...rest] = file.split("/");
    const atPort =
      !port.startsWith("_") &&
      rest.join("/") === "testing/index.ts" &&
      existsSync(join(root, port, "port.ts"));
    assert.ok(
      file === "testing/index.ts" || atPort,
      `${file} would be exported as a port's helpers`,
    );
  }
});
