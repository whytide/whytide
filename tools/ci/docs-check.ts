// The docs-touch check, the step `docs:check` (docs/rules/delivery.md §4): a module whose changes on
// the branch go beyond tests/ and docs/ also changes its docs/ or its README.md, unless the merge
// request carries the label docs-not-needed (CI_MERGE_REQUEST_LABELS in GitLab, `--labels` locally).
import { resolve } from "node:path";
import { changedFiles, labels } from "./branch.ts";

const say = (text: string) => process.stdout.write(`${text}\n`);
if (labels().includes("docs-not-needed")) {
  say("docs:check: the label docs-not-needed is set, nothing to check");
  process.exit(0);
}

const { base, files } = changedFiles(resolve(import.meta.dirname, "..", ".."));
const modules = new Map<string, { behavior: string[]; docs: string[] }>();
for (const file of files) {
  const match = /^core\/modules\/([^/]+)\/(.+)$/.exec(file);
  const name = match?.[1];
  const inside = match?.[2];
  if (!name || !inside || name === "_template") continue;
  const module = modules.get(name) ?? { behavior: [], docs: [] };
  modules.set(name, module);
  if (inside.startsWith("docs/") || inside === "README.md") module.docs.push(file);
  else if (!inside.startsWith("tests/")) module.behavior.push(file);
}
const undocumented = [...modules]
  .filter(([, module]) => module.behavior.length > 0 && module.docs.length === 0)
  .map(([name]) => `core/modules/${name}`);
if (undocumented.length) {
  say(
    `docs:check: ${undocumented.join(", ")} changed since ${base} without a change under docs/ or to README.md: update the docs, or set the label docs-not-needed`,
  );
  process.exit(1);
}
say(`docs:check: ok, ${modules.size} module${modules.size === 1 ? "" : "s"} changed since ${base}`);
