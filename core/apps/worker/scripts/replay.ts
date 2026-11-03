// `pnpm -F worker test:replay` (docs/workflows.md "Replay"): replays every
// core/modules/*/workflows/__histories__/*.json against the current workflow code, the bundle of
// src/workflows.generated.ts, so a change that breaks a running workflow fails here first. No
// server is needed.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generatedWorkflows } from "../src/temporal.ts";
import { replayHistories } from "../testing/index.ts";
import { listModules } from "./modules-generate.ts";

const modules = join(import.meta.dirname, "..", "..", "..", "modules");
const files = listModules(modules).flatMap((name) => {
  const dir = join(modules, name, "workflows", "__histories__");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(dir, file));
});
await replayHistories(generatedWorkflows, files);
process.stdout.write(
  `replay: ${files.length} ${files.length === 1 ? "history" : "histories"} replayed\n`,
);
