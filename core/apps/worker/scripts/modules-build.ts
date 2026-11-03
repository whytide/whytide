// `pnpm -F worker modules:build` (README "Modules"): `tsc -b` over every module, since the worker
// imports their builds, dist/, as the api host does. build runs it, and so dev, test and test:replay;
// a start without it stops at worker_module_not_built, naming the missing file.
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
