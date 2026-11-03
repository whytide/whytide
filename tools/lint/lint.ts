// The structural lint: `node tools/lint/lint.ts [paths...] [--fix]`, from anywhere in the workspace.
// Without paths it checks core/ and ee/. Every rule is a file under rules/; see README.md.
import ts from "typescript";
import {
  applyEdits,
  findRoot,
  formatFinding,
  lintFiles,
  listFiles,
  loadRules,
  readVendorRegistry,
} from "./linter.ts";
import type { Finding, TextEdit } from "./rule.ts";

const say = (text: string) => ts.sys.write(`${text}\n`);
const fix = ts.sys.args.includes("--fix");
const targets = ts.sys.args.filter((arg) => !arg.startsWith("--"));

const root =
  findRoot(ts.sys.getCurrentDirectory()) ??
  quit("lint: run it inside the workspace (no pnpm-workspace.yaml above the current directory)");

const absolute = targets.length
  ? targets.map((target) => ts.sys.resolvePath(target))
  : ["core", "ee"]
      .map((folder) => `${root}/${folder}`)
      .filter((folder) => ts.sys.directoryExists(folder));
const files = listFiles(root, absolute);
const rules = await loadRules(`${import.meta.dirname}/rules`);
let findings = lintFiles(root, files, rules, readVendorRegistry(root));

if (fix) {
  const byFile = new Map<string, TextEdit[]>();
  for (const f of findings) {
    if (f.fix) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f.fix]);
  }
  for (const [path, edits] of byFile) {
    const text = ts.sys.readFile(`${root}/${path}`) ?? "";
    ts.sys.writeFile(`${root}/${path}`, applyEdits(text, edits));
    say(`fixed ${edits.length} in ${path}`);
  }
  findings = findings.filter((f: Finding) => !f.fix);
}

for (const f of findings) say(formatFinding(f));
const touched = new Set(findings.map((f) => f.path)).size;
say(
  findings.length
    ? `${findings.length} problem${findings.length === 1 ? "" : "s"} in ${touched} file${touched === 1 ? "" : "s"}`
    : `no problems in ${files.length} file${files.length === 1 ? "" : "s"}`,
);
ts.sys.exit(findings.length ? 1 : 0);

function quit(text: string): never {
  say(text);
  ts.sys.exit(2);
  throw new Error(text);
}
