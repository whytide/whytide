// `pnpm -F api modules:build` (README "Modules"): `tsc -b` over every module that modules-generate.ts
// lists, since the host imports their builds, dist/index.js, and its own `tsc -b` builds only the
// modules its tsconfig references. build runs it, as the worker's build runs its own, and so dev,
// test, openapi:build, serve:e2e, http:run and session:token.
//   node scripts/modules-build.ts [modules folder]
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { listModules } from "./modules-generate.ts";

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "..", "..", "modules"));
const projects = listModules(dir).map((name) => join(dir, name));
if (projects.length) {
  const built = spawnSync("tsc", ["-b", ...projects], { stdio: "inherit" });
  process.exitCode = built.status ?? 1;
}
