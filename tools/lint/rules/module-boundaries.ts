import {
  isIn,
  isRelative,
  locatePackage,
  moduleOf,
  resolveRelative,
  workspaceTarget,
} from "../paths.ts";
import type { Finding, ImportRef, LintFile, Rule, TextEdit } from "../rule.ts";
import { finding, startOf } from "../rule.ts";

/** The ways an import can name a module's index, the one public file. */
const PUBLIC = new Set(["", "index", "index.ts", "index.js"]);
/** The web host's API client, which a module's screens (`ui/`, run by the web host only) call. */
const SCREEN_API = new Set(["@whytide/web/api/server", "@whytide/web/api/browser"]);

export const rule: Rule = {
  name: "module-boundaries",
  protects:
    "a module imports another module only as @whytide/<name>, its index.ts (its tests also @whytide/<name>/testing); never a host, never another module's Prisma client; core/ never imports ee/",
  check(file) {
    const findings: Finding[] = [];
    const own = moduleOf(file.path);
    for (const ref of file.imports) {
      const target = resolveTarget(file, ref.specifier);
      if (target === undefined) continue;
      const at = startOf(file, ref.node);
      if (file.path.startsWith("core/") && isIn(target, "ee")) {
        findings.push(finding(file, rule.name, at, `core/ never imports ee/ (${ref.specifier})`));
        continue;
      }
      if (!own) continue;
      const other = moduleOf(target);
      if (other && (other.edition !== own.edition || other.name !== own.name)) {
        const pkg = `@whytide/${other.name}`;
        // A module's tests may build their data with another module's test helpers, by its name.
        const helpers = ref.specifier === `${pkg}/testing` && own.rest.startsWith("tests/");
        if (helpers) continue;
        if (!PUBLIC.has(other.rest)) {
          const message = `imports the internals of module ${other.name} (${ref.specifier}): only ${pkg}, its index.ts, is public`;
          findings.push(finding(file, rule.name, at, message));
        } else if (isRelative(ref.specifier)) {
          const message = `imports module ${other.name} by a relative path: use its package name, ${pkg}`;
          findings.push(finding(file, rule.name, at, message, replaceSpecifier(ref, pkg)));
        }
        continue;
      }
      const screenApi = own.rest.startsWith("ui/") && SCREEN_API.has(ref.specifier);
      if (isIn(target, "core/apps") && !screenApi) {
        findings.push(
          finding(file, rule.name, at, `a module never imports a host (${ref.specifier})`),
        );
      }
      const client = /^core\/packages\/db\/generated\/([^/]+)(?:\/|$)/.exec(target);
      if (client && client[1] !== own.name && file.exists(`core/modules/${client[1]}`)) {
        const message = `the Prisma client of module ${client[1]} is used by that module only (${ref.specifier})`;
        findings.push(finding(file, rule.name, at, message));
      }
    }
    return findings;
  },
};

/** The repository-relative path an import points at, for relative and `@whytide/*` imports only. */
function resolveTarget(file: LintFile, specifier: string): string | undefined {
  if (isRelative(specifier)) return resolveRelative(file.path, specifier);
  const target = workspaceTarget(specifier);
  if (!target) return undefined;
  const folder = locatePackage(target.name, file.exists);
  if (!folder) return undefined;
  return target.rest ? `${folder}/${target.rest}` : folder;
}

function replaceSpecifier(ref: ImportRef, pkg: string): TextEdit {
  const quote = ref.node.getText()[0] ?? '"';
  return { start: ref.node.getStart(), end: ref.node.getEnd(), text: `${quote}${pkg}${quote}` };
}
