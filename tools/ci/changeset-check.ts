// The step `changeset:check`: a branch that changes anything adds a changeset under .changeset/
// (`pnpm changeset`), unless the merge request carries the label no-changeset.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { changedFiles, labels } from "./branch.ts";

const say = (text: string) => process.stdout.write(`${text}\n`);
if (labels().includes("no-changeset")) {
  say("changeset:check: the label no-changeset is set, nothing to check");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..", "..");
const { base, files } = changedFiles(root);
if (files.length === 0) {
  say(`changeset:check: nothing changed since ${base}`);
  process.exit(0);
}
const changesets = files.filter(
  (file) => /^\.changeset\/(?!README\.md$)[^/]+\.md$/.test(file) && existsSync(join(root, file)),
);
if (changesets.length === 0) {
  say(
    `changeset:check: ${files.length} file${files.length === 1 ? "" : "s"} changed since ${base} and no changeset under .changeset/: run pnpm changeset, or set the label no-changeset`,
  );
  process.exit(1);
}
say(`changeset:check: ok, ${changesets.join(", ")}`);
