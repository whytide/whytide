import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Finding, ImportRef, LintFile, Rule, TextEdit, VendorRegistry } from "./rule.ts";
import { unwrap } from "./rule.ts";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".css"];
const EXCLUDED = ["**/node_modules", "**/dist", "**/.next", "**/_template", "**/*.generated.*"];

/** The workspace root: the nearest ancestor of `from` that holds `pnpm-workspace.yaml`. */
export function findRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (ts.sys.fileExists(`${dir}/pnpm-workspace.yaml`)) return dir;
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === dir || parent === "") return undefined;
    dir = parent;
  }
}

/** Every rule under `rulesDir`: one file per rule, each exporting `rule`. */
export async function loadRules(rulesDir: string): Promise<Rule[]> {
  const rules: Rule[] = [];
  for (const file of ts.sys.readDirectory(rulesDir, [".ts"], undefined, undefined, 1).sort()) {
    const loaded: unknown = await import(
      file.startsWith("/") ? `file://${file}` : `file:///${file}`
    );
    const rule = (loaded as { rule?: Rule }).rule;
    if (!rule || typeof rule.name !== "string" || typeof rule.check !== "function") {
      throw new Error(`${file} does not export a rule`);
    }
    rules.push(rule);
  }
  return rules;
}

/** `tools/lint/vendor-sdks.json` under `root`: adapter folder to its SDK packages; empty when absent. */
export function readVendorRegistry(root: string): VendorRegistry {
  const path = `${root}/tools/lint/vendor-sdks.json`;
  const text = ts.sys.readFile(path);
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected an object of adapter folder to package names`);
  }
  const registry: Record<string, readonly string[]> = {};
  for (const [folder, packages] of Object.entries(parsed)) {
    if (!Array.isArray(packages) || !packages.every((p) => typeof p === "string")) {
      throw new Error(`${path}: ${folder} must list package names`);
    }
    registry[folder.replace(/\/+$/, "")] = packages;
  }
  return registry;
}

/** The source files under the absolute `targets` (files or folders), build outputs and the template left out. */
export function listFiles(root: string, targets: readonly string[]): string[] {
  const files = new Set<string>();
  for (const target of targets) {
    if (ts.sys.directoryExists(target)) {
      for (const file of ts.sys.readDirectory(target, EXTENSIONS, EXCLUDED)) files.add(file);
    } else if (ts.sys.fileExists(target)) {
      files.add(target);
    } else {
      throw new Error(`${target} does not exist`);
    }
  }
  return [...files].filter((file) => file.startsWith(`${root}/`)).sort();
}

export function lintFiles(
  root: string,
  files: readonly string[],
  rules: readonly Rule[],
  vendorSdks: VendorRegistry,
): Finding[] {
  const exists = (path: string) =>
    ts.sys.directoryExists(`${root}/${path}`) || ts.sys.fileExists(`${root}/${path}`);
  const readFolder = (folder: string) =>
    new Map(
      ts.sys
        .readDirectory(`${root}/${folder}`, undefined, undefined, undefined, 1)
        .map((file) => [file.slice(file.lastIndexOf("/") + 1), ts.sys.readFile(file) ?? ""]),
    );
  const findings: Finding[] = [];
  for (const absolute of files) {
    const path = absolute.slice(root.length + 1);
    const text = ts.sys.readFile(absolute) ?? "";
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
    const file: LintFile = {
      path,
      source,
      imports: collectImports(source),
      vendorSdks,
      exists,
      readFolder,
    };
    for (const rule of rules) findings.push(...rule.check(file));
  }
  return findings.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
}

export function formatFinding(f: Finding): string {
  return `${f.path}:${f.line}:${f.column} ${f.rule} ${f.message}`;
}

/** The text with the edits applied; edits never overlap. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let result = text;
  let limit = text.length;
  for (const edit of ordered) {
    if (edit.end > limit) throw new Error("overlapping edits");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    limit = edit.start;
  }
  return result;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectImports(source: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];
  const loaders = requireFunctions(source);
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node))
      refs.push({ specifier: packagePath(node.text, source.fileName), node });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && isImportCall(node, loaders)) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

/**
 * The specifier every rule matches, parsed as a URL the way Node parses it. A `file:` URL is the path
 * Node loads (escapes decoded, dot segments, query and fragment dropped); one Node cannot load, a
 * malformed escape for one, stops the lint rather than pass unread. A path is normalized (`.`, `..`,
 * doubled `/`), and one into `node_modules`, relative or absolute and through `.pnpm` too, is the
 * package it reaches: `../node_modules/axios/index.js` is `axios/index.js`.
 */
function packagePath(specifier: string, file: string): string {
  const url = URL.parse(specifier);
  let path = specifier;
  if (url?.protocol === "file:") {
    try {
      path = fileURLToPath(url);
    } catch {
      throw new Error(
        `${file}: ${specifier} is not a file URL Node can load; the lint stops on it`,
      );
    }
  }
  if (!url || url.protocol === "file:") {
    const normal = posix.normalize(path);
    path = path.startsWith("./") && !/^\.\.?(?:\/|$)/.test(normal) ? `./${normal}` : normal;
  }
  return path.split(/(?:^|\/)node_modules\//).at(-1) || path;
}

/** `require` and every name bound to a `createRequire(…)` result, which loads a module the same way. */
function requireFunctions(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set(["require"]);
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isCreateRequire(unwrap(node.initializer))) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** `import(…)`, a require function, `createRequire(…)(…)` or `process.getBuiltinModule(…)`. */
function isImportCall(call: ts.CallExpression, loaders: ReadonlySet<string>): boolean {
  const callee = unwrap(call.expression);
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && loaders.has(callee.text)) ||
    isCreateRequire(callee) ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "getBuiltinModule")
  );
}

/** `createRequire(…)` or `module.createRequire(…)`. */
function isCreateRequire(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) return callee.text === "createRequire";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire";
}
