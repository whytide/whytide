import ts from "typescript";
import { isIn, moduleOf } from "../paths.ts";
import type { Finding, Rule } from "../rule.ts";
import { finding } from "../rule.ts";

/** Props whose value is never read by a person: the task's list plus the token-valued HTML attributes. */
const EXEMPT = new Set([
  "className",
  "class",
  "href",
  "key",
  "id",
  "testId",
  "testID",
  "rel",
  "src",
  "srcSet",
  "type",
  "role",
  "name",
  "target",
  "htmlFor",
  "lang",
  "dir",
  "method",
  "action",
  "accept",
  "pattern",
  "media",
  "sizes",
  "autoComplete",
  "inputMode",
  "charSet",
]);

export const rule: Rule = {
  name: "no-literal-strings-in-screens",
  protects:
    "under a module's ui/, core/packages/ui and the web host's app/ and src/, JSX text and the string props a person reads come from the i18n runtime, never from a literal",
  check(file) {
    if (!isScreen(file.path)) return [];
    const findings: Finding[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        if (!node.containsOnlyTriviaWhiteSpaces) {
          const raw = file.source.text.slice(node.pos, node.end);
          const at = node.pos + (raw.length - raw.trimStart().length);
          findings.push(finding(file, rule.name, at, text(raw)));
        }
      } else if (ts.isJsxExpression(node) && isChild(node)) {
        const literal = node.expression;
        if (literal && ts.isStringLiteralLike(literal) && literal.text.trim() !== "") {
          findings.push(
            finding(file, rule.name, literal.getStart(file.source), text(literal.text)),
          );
        }
      } else if (ts.isJsxAttribute(node)) {
        const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file.source);
        const value = stringValue(node);
        if (value !== undefined && !isExempt(name) && looksLikeText(value)) {
          const message = `the ${name} prop holds text a person reads ("${preview(value)}"): use a message key`;
          findings.push(finding(file, rule.name, node.getStart(file.source), message));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
    return findings;
  },
};

function isScreen(path: string): boolean {
  return (
    moduleOf(path)?.rest.startsWith("ui/") === true ||
    ["core/packages/ui", "core/apps/web/app", "core/apps/web/src"].some((dir) => isIn(path, dir))
  );
}

function isChild(node: ts.JsxExpression): boolean {
  return ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
}

function stringValue(attribute: ts.JsxAttribute): string | undefined {
  const value = attribute.initializer;
  if (!value) return undefined;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) {
    return value.expression.text;
  }
  return undefined;
}

function isExempt(name: string): boolean {
  return name.startsWith("aria-") || name.startsWith("data-") || EXEMPT.has(name);
}

/** Words, not a token: whitespace inside, a capitalized word, or sentence punctuation at the end. */
function looksLikeText(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && (/\s/.test(v) || /^[A-Z][a-z]/.test(v) || /[.!?:]$/.test(v));
}

function text(raw: string): string {
  return `on-screen text comes from a message key, never a literal ("${preview(raw)}")`;
}

function preview(raw: string): string {
  const flat = raw.trim().replace(/\s+/g, " ");
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}
