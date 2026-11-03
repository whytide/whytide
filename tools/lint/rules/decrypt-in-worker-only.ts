import {
  isIn,
  isRelative,
  locatePackage,
  moduleOf,
  resolveRelative,
  workspaceTarget,
} from "../paths.ts";
import type { Finding, LintFile, Rule } from "../rule.ts";
import { finding, startOf } from "../rule.ts";

const ENTRY = "@whytide/platform/secrets/worker";
/** The entry inside the platform, or keys.ts behind it, which holds the unwrap: as a package subpath or a file, with or without an extension, built or not. */
const ENTRY_REST = /^(?:dist\/)?secrets\/(?:worker|keys)(?:[./].*)?$/;
const PLATFORM = "core/packages/platform";
/** A module's workflows/ folder or a file in it, built or not: where its worker-only entries sit (linkedin's withDecryptedRef). */
const WORKFLOWS_REST = /^(?:dist\/)?workflows(?:[./]|$)/;

export const rule: Rule = {
  name: "decrypt-in-worker-only",
  protects:
    "the worker decrypt entry @whytide/platform/secrets/worker is imported only under core/apps/worker/ and a module's workflows/, and a module's workflows/ (its decrypt entries, linkedin's withDecryptedRef) only from there and the module's tests/; the api encrypts and never decrypts",
  check(file) {
    const findings: Finding[] = [];
    for (const ref of file.imports) {
      const at = startOf(file, ref.node);
      if (namesEntry(file.path, ref.specifier) && !mayDecrypt(file.path)) {
        const message = `${ref.specifier} decrypts secrets: only the worker host (core/apps/worker/) and a module's workflows/ import ${ENTRY}; everything else encrypts with encryptSecret from @whytide/platform (docs/rules/security.md §4)`;
        findings.push(finding(file, rule.name, at, message));
      }
      const workflows = workflowsOf(file, ref.specifier);
      if (workflows && !mayReachWorkflows(file.path)) {
        const message = `${ref.specifier} is the worker side of module ${workflows}, which decrypts: only the worker host, the module's own workflows/ and its tests/ import a module's workflows/ (docs/rules/security.md §4)`;
        findings.push(finding(file, rule.name, at, message));
      }
    }
    return findings;
  },
};

/** The worker host, a module's workflows/, and the platform's own secrets/ and tests/ (never its index). */
function mayDecrypt(path: string): boolean {
  if (isIn(path, "core/apps/worker") || moduleOf(path)?.rest.startsWith("workflows/")) return true;
  return isIn(path, `${PLATFORM}/secrets`) || isIn(path, `${PLATFORM}/tests`);
}

/** The worker host, and a module's workflows/ and tests/. */
function mayReachWorkflows(path: string): boolean {
  const rest = moduleOf(path)?.rest ?? "";
  return isIn(path, "core/apps/worker") || /^(?:workflows|tests)\//.test(rest);
}

function namesEntry(from: string, specifier: string): boolean {
  if (isRelative(specifier)) {
    const target = resolveRelative(from, specifier);
    return isIn(target, PLATFORM) && ENTRY_REST.test(target.slice(PLATFORM.length + 1));
  }
  const target = workspaceTarget(specifier);
  return target?.name === "platform" && ENTRY_REST.test(target.rest);
}

/** The module whose workflows/ the import reaches, by a relative path or `@whytide/<module>/…`. */
function workflowsOf(file: LintFile, specifier: string): string | undefined {
  if (isRelative(specifier)) {
    const target = moduleOf(resolveRelative(file.path, specifier));
    return target && WORKFLOWS_REST.test(target.rest) ? target.name : undefined;
  }
  const target = workspaceTarget(specifier);
  if (!target || !WORKFLOWS_REST.test(target.rest)) return undefined;
  const folder = locatePackage(target.name, file.exists);
  return folder && moduleOf(folder) ? target.name : undefined;
}
