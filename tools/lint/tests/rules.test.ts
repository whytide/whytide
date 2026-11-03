// The end-to-end test of the lint rules: every rule has a fixture folder named after it, with a
// pass/ tree that must be clean and a fail/ tree whose expected.json lists the rule IDs per file.
// Run with `pnpm -F lint test`.
import ts from "typescript";
import {
  applyEdits,
  formatFinding,
  lintFiles,
  listFiles,
  loadRules,
  readVendorRegistry,
} from "../linter.ts";
import type { Finding } from "../rule.ts";

const say = (text: string) => ts.sys.write(`${text}\n`);
const here = import.meta.dirname;
const fixtures = ts.sys.resolvePath(`${here}/../fixtures`);
const rules = await loadRules(ts.sys.resolvePath(`${here}/../rules`));
const failures: string[] = [];
const fail = (text: string) => failures.push(text);

const folders = ts.sys.getDirectories(fixtures).sort();
for (const rule of rules) {
  if (!folders.includes(rule.name)) fail(`${rule.name} has no fixture folder`);
}
for (const folder of folders) {
  if (!rules.some((rule) => rule.name === folder)) fail(`fixtures/${folder} names no rule`);
  for (const kind of ["pass", "fail"] as const) {
    const root = `${fixtures}/${folder}/${kind}`;
    const files = listFiles(root, [root]);
    if (files.length === 0) fail(`${folder}/${kind} has no files`);
    const findings = lintFiles(root, files, rules, readVendorRegistry(root));
    const expected = kind === "fail" ? readExpected(`${root}/expected.json`) : {};
    const actual = new Map<string, string[]>();
    for (const f of findings) actual.set(f.path, [...(actual.get(f.path) ?? []), f.rule]);
    for (const file of files) {
      const path = file.slice(root.length + 1);
      const want = [...(expected[path] ?? [])].sort().join(", ");
      const got = [...(actual.get(path) ?? [])].sort().join(", ");
      if (want !== got) fail(`${folder}/${kind}/${path}: expected [${want}], got [${got}]`);
    }
    for (const path of Object.keys(expected)) {
      if (!files.some((file) => file.slice(root.length + 1) === path)) {
        fail(`${folder}/${kind}/expected.json names ${path}, which does not exist`);
      }
    }
    if (kind === "fail") {
      checkFormat(findings);
      if (folder === "module-boundaries") checkFix(root, findings);
    }
  }
  say(`${failures.length ? "checked" : "ok"} ${folder}`);
}

if (failures.length) {
  for (const text of failures) say(`FAIL ${text}`);
  say(`${failures.length} failure${failures.length === 1 ? "" : "s"}`);
  ts.sys.exit(1);
}
say(`ok: ${rules.length} rules, ${folders.length} fixture folders`);
ts.sys.exit(0);

function readExpected(path: string): Record<string, readonly string[]> {
  const text = ts.sys.readFile(path);
  if (text === undefined) {
    fail(`${path} is missing`);
    return {};
  }
  return JSON.parse(text) as Record<string, readonly string[]>;
}

/** A finding prints as `path:line:column rule message`. */
function checkFormat(findings: readonly Finding[]) {
  for (const f of findings) {
    if (!/^[^:\s]+:\d+:\d+ [a-z-]+ \S/.test(formatFinding(f)))
      fail(`bad format: ${formatFinding(f)}`);
  }
}

/** The relative import of another module's index is rewritten to the package name. */
function checkFix(root: string, findings: readonly Finding[]) {
  const fixable = findings.filter((f) => f.fix);
  if (fixable.length !== 1) return fail(`expected one fixable finding, got ${fixable.length}`);
  const [only] = fixable;
  if (!only?.fix) return;
  const fixed = applyEdits(ts.sys.readFile(`${root}/${only.path}`) ?? "", [only.fix]);
  if (!fixed.includes('from "@whytide/other";')) fail(`the fix produced:\n${fixed}`);
}
