import { isPackageOf, moduleOf } from "../paths.ts";
import type { Finding, Rule } from "../rule.ts";
import { finding, startOf } from "../rule.ts";

/** A package prefix (ending in `/`) or a package name, and the framework it belongs to. */
const FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["@nestjs/", "NestJS"],
  ["next", "Next.js"],
  ["@prisma/", "Prisma"],
  ["prisma", "Prisma"],
  ["@temporalio/", "Temporal"],
  ["@mastra/", "Mastra"],
  ["mastra", "Mastra"],
];

export const rule: Rule = {
  name: "no-framework-in-domain",
  protects: "domain/ is plain TypeScript: nothing from NestJS, Next.js, Prisma, Temporal or Mastra",
  check(file) {
    const location = moduleOf(file.path);
    if (!location || !location.rest.startsWith("domain/")) return [];
    const findings: Finding[] = [];
    for (const ref of file.imports) {
      const framework = frameworkOf(ref.specifier);
      if (framework) {
        const message = `domain/ imports no framework: ${ref.specifier} is ${framework}`;
        findings.push(finding(file, rule.name, startOf(file, ref.node), message));
      }
    }
    return findings;
  },
};

function frameworkOf(specifier: string): string | undefined {
  for (const [pkg, name] of FRAMEWORKS) {
    if (pkg.endsWith("/") ? specifier.startsWith(pkg) : isPackageOf(specifier, pkg)) return name;
  }
  return undefined;
}
