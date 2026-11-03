import ts from "typescript";
import { piiKeys } from "../../../core/packages/platform/logging/pii.ts";
import { moduleOf } from "../paths.ts";
import type { Finding, LintFile, Rule } from "../rule.ts";
import { finding, startOf, unwrap } from "../rule.ts";

// Workflow and activity inputs carry ids only (architecture §8; decisions §1): Temporal keeps them in
// its history. A field named in the PII registry or after a column marked `/// pii` in the Prisma
// schema (its field or its @map name, in camelCase and snake_case) is a finding in any object
// schema under a module's workflows/: z.object, z.strictObject, z.looseObject, .extend, .safeExtend.
const SCHEMA = "core/packages/db/prisma/schema";
const OBJECTS = new Set(["object", "strictObject", "looseObject", "extend", "safeExtend"]);
const PII = /^\s*\/\/\/\s*pii\b(?::\s*\S+)?/i;
const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** The PII registry's keys and the names of every `/// pii` column of the schema folder. */
function bannedNames(file: LintFile): Set<string> {
  const names = new Set(piiKeys);
  for (const [name, text] of file.readFolder?.(SCHEMA) ?? []) {
    if (!name.endsWith(".prisma")) continue;
    let marked = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\/\//.test(line)) {
        marked ||= PII.test(line);
        continue;
      }
      const field = marked ? /^\s*(\w+)\s+\S/.exec(line)?.[1] : undefined;
      const column = /@map\(\s*"([^"]*)"\s*\)/.exec(line)?.[1];
      for (const found of [field, field && column]) {
        if (found) for (const form of [found, snake(found), camel(found)]) names.add(form);
      }
      marked = false;
    }
  }
  return names;
}

export const rule: Rule = {
  name: "workflow-input-ids-only",
  protects:
    "An object schema under a module's `workflows/` (`z.object`, `z.strictObject`, `z.looseObject`, `.extend`, `.safeExtend`) has no field named in the PII registry (`email`, `name`, …) or after a column marked `/// pii` in `core/packages/db/prisma/schema`: workflow and activity inputs carry ids only, since Temporal keeps them in its history (architecture §8).",
  check(file) {
    if (!(moduleOf(file.path)?.rest ?? "").startsWith("workflows/")) return [];
    const banned = bannedNames(file);
    const findings: Finding[] = [];
    const visit = (node: ts.Node) => {
      const callee = ts.isCallExpression(node) ? node.expression : undefined;
      if (callee && ts.isPropertyAccessExpression(callee) && OBJECTS.has(callee.name.text)) {
        const [first] = (node as ts.CallExpression).arguments;
        const shape = first && unwrap(first);
        for (const property of shape && ts.isObjectLiteralExpression(shape)
          ? shape.properties
          : []) {
          const key = property.name;
          const name = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : "";
          if (!banned.has(name)) continue;
          const message = `the input field "${name}" is personal data: a workflow or activity input carries ids only; pass the id and read the row in an activity`;
          findings.push(finding(file, rule.name, startOf(file, property), message));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
    return findings;
  },
};
