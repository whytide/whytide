import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { validateIcu } from "./icu.ts";
import { parseKey } from "./keys.ts";
import { type MessageRoot, messageRoots, relativePath } from "./messages.ts";
import { errorMessageKey } from "./translator.ts";
import { type Site, scanRoot } from "./uses.ts";

export type ProblemKind =
  | "invalid-file"
  | "duplicate-key"
  | "namespace-conflict"
  | "bad-key"
  | "invalid-icu"
  | "unsorted"
  | "missing-key"
  | "unused-key"
  | "dynamic-key"
  | "error-code-without-key";

export type Problem = Site & {
  readonly kind: ProblemKind;
  readonly message: string;
  readonly key?: string;
};

export type Summary = { files: number; keys: number; sources: number; uses: number; codes: number };
export type CheckResult = { readonly problems: Problem[]; readonly summary: Summary };

/**
 * The message-key check (coding §4): every key a screen, a nav.ts or a renderMail call uses and
 * every registered error code has its key in a messages/<locale>.json; every key there is used;
 * every value parses as ICU; keys follow module.screen.purpose with the folder's name first and
 * none is also a namespace; files are sorted. Run on the repository by `pnpm -F platform
 * messages:check`, on fixture trees by the tests.
 */
export function checkMessages(root: string, locale = "en"): CheckResult {
  const problems: Problem[] = [];
  const declared = new Map<string, Site>();
  const summary: Summary = { files: 0, keys: 0, sources: 0, uses: 0, codes: 0 };
  const roots = messageRoots(root);
  for (const messageRoot of roots) {
    const path = join(messageRoot.dir, "messages", `${locale}.json`);
    if (!existsSync(path)) continue;
    summary.files++;
    const text = readFileSync(path, "utf8").replace(/^﻿/, "");
    readDeclarations(messageRoot, relativePath(root, path), text, declared, problems);
  }
  summary.keys = declared.size;
  problems.push(...namespaceConflicts(declared));
  const used = new Set<string>();
  // The providers package sends mail for a module (the sign-in link, identity's keys): its renderMail
  // calls are uses too, though it holds no messages of its own.
  const providers = join(root, "core", "packages", "providers");
  const sender: MessageRoot = { module: "providers", dir: providers, kind: "package" };
  for (const messageRoot of existsSync(providers) ? [...roots, sender] : roots) {
    const scan = scanRoot(messageRoot, root);
    summary.sources += scan.files;
    summary.uses += scan.uses.length;
    summary.codes += scan.codes.length;
    for (const use of scan.uses) {
      used.add(use.key);
      if (!declared.has(use.key)) {
        const message = `the key ${use.key} is used here and defined in no messages/${locale}.json`;
        problems.push({ ...use, kind: "missing-key", message });
      }
    }
    for (const site of scan.dynamic) problems.push({ ...site, kind: "dynamic-key" });
    for (const code of scan.codes) {
      const key = errorMessageKey(messageRoot.module, code.key);
      used.add(key);
      if (!declared.has(key)) {
        const message = `the error code ${code.key} has no message: add ${key} to messages/${locale}.json`;
        problems.push({ ...code, key, kind: "error-code-without-key", message });
      }
    }
  }
  for (const [key, site] of declared) {
    if (used.has(key)) continue;
    const message = `the key ${key} is used nowhere: no t('…') in a screen, no nav.ts entry, no renderMail, no error code`;
    problems.push({ ...site, key, kind: "unused-key", message });
  }
  problems.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      a.kind.localeCompare(b.kind),
  );
  return { problems, summary };
}

/** `path:line:column kind message`, as the lint prints a finding. */
export function formatProblem(problem: Problem): string {
  return `${problem.path}:${problem.line}:${problem.column} ${problem.kind} ${problem.message}`;
}

/** A key that is also the dotted prefix of another key: the bundle cannot hold a message and a namespace at one place. */
function namespaceConflicts(declared: Map<string, Site>): Problem[] {
  const problems: Problem[] = [];
  const reported = new Set<string>();
  for (const key of declared.keys()) {
    const segments = key.split(".");
    for (let length = segments.length - 1; length >= 1; length--) {
      const prefix = segments.slice(0, length).join(".");
      const site = declared.get(prefix);
      if (!site || reported.has(prefix)) continue;
      reported.add(prefix);
      const message = `the key ${prefix} is also a namespace: ${key} nests under it, and the bundle cannot hold both`;
      problems.push({ ...site, key: prefix, kind: "namespace-conflict", message });
    }
  }
  return problems;
}

/** One message file: its keys into `declared`, its faults into `problems`. */
function readDeclarations(
  root: MessageRoot,
  path: string,
  text: string,
  declared: Map<string, Site>,
  problems: Problem[],
): void {
  const fault = (site: Site, kind: ProblemKind, message: string, key?: string): void => {
    problems.push(key === undefined ? { ...site, kind, message } : { ...site, kind, message, key });
  };
  const top = { path, line: 1, column: 1 };
  try {
    JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fault(top, "invalid-file", `not valid JSON: ${reason}`);
  }
  const source = ts.parseJsonText(path, text);
  const object = source.statements[0]?.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) {
    return fault(top, "invalid-file", "a message file is one object of keys to strings");
  }
  const site = (node: ts.Node): Site => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { path, line: line + 1, column: character + 1 };
  };
  const seen = new Set<string>();
  let previous: string | undefined;
  let sorted = true;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) {
      fault(site(property), "invalid-file", "not a key to a string");
      continue;
    }
    const key = property.name.text;
    const here = site(property.name);
    if (!ts.isStringLiteral(property.initializer)) {
      const message = `the value of ${key} is not a string: a message file is flat, module.screen.purpose to ICU text`;
      fault(here, "invalid-file", message, key);
      continue;
    }
    if (seen.has(key))
      fault(here, "duplicate-key", `the key ${key} appears twice in this file`, key);
    seen.add(key);
    const parsed = parseKey(key);
    if (!parsed.ok) {
      fault(
        here,
        "bad-key",
        `the key ${key} does not follow module.screen.purpose: ${parsed.reason}`,
        key,
      );
    } else if (parsed.key.module !== root.module) {
      const message = `the key ${key} starts with ${parsed.key.module}, not with this folder's name, ${root.module}`;
      fault(here, "bad-key", message, key);
    }
    const icu = validateIcu(property.initializer.text);
    if (icu) fault(site(property.initializer), "invalid-icu", `${key}: ${icu}`, key);
    if (sorted && previous !== undefined && key < previous) {
      sorted = false;
      fault(here, "unsorted", `the keys are not sorted: ${key} comes after ${previous}`, key);
    }
    previous = key;
    const first = declared.get(key);
    if (first) {
      fault(
        here,
        "duplicate-key",
        `the key ${key} is defined in two files: ${first.path} and ${path}`,
        key,
      );
    } else {
      declared.set(key, here);
    }
  }
}
