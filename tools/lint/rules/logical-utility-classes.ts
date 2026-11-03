import ts from "typescript";
import type { Finding, Rule } from "../rule.ts";
import { finding } from "../rule.ts";

/** A physical Tailwind utility of the inline direction, the variants and `!` or `-` taken off. */
const PHYSICAL =
  /^(?<box>m|p|scroll-m|scroll-p)(?<side>[lr])-|^(?<inset>left|right)-|^(?<align>text|float|clear)-(?<value>left|right)$|^(?<edge>border|rounded)-(?<to>[lr]|tl|tr|bl|br)(?:-|$)/;
const SIDE: Readonly<Record<string, string>> = { l: "s", r: "e", left: "start", right: "end" };
const CORNER: Readonly<Record<string, string>> = { tl: "ss", tr: "se", bl: "es", br: "ee" };
/** The functions whose string arguments are class names, as in className={cx("…", …)}. */
const JOINERS = new Set(["cx", "clsx", "cn"]);

export const rule: Rule = {
  name: "logical-utility-classes",
  protects:
    "a className uses Tailwind's logical utilities (ms-2, ps-4, start-0, text-start, border-s, rounded-s), never the physical ones (ml-2, pl-4, left-0, text-left, border-l, rounded-l)",
  check(file) {
    if (!/\.[jt]sx?$/.test(file.path)) return [];
    const findings: Finding[] = [];
    const consts = constsOf(file.source);
    /** Each node once, however many class places reach it: a const five classNames name, once. */
    const read = new Set<ts.Node>();
    const inspect = (node: ts.Node): void => {
      if (read.has(node) || ts.isTypeNode(node)) return;
      read.add(node);
      if (ts.isStringLiteralLike(node) || isTemplatePart(node)) {
        const start = node.getStart(file.source) + 1; // after the quote, the backtick or the }
        for (const match of node.text.matchAll(/\S+/g)) {
          const logical = logicalOf(match[0]);
          if (logical) findings.push(finding(file, rule.name, start + match.index, logical));
        }
      }
      // A const of this file that the class reads, as VARIANTS[variant]: its value is classes too.
      if (ts.isIdentifier(node) && isRead(node)) {
        for (const value of consts.get(node.text) ?? []) inspect(value);
      }
      ts.forEachChild(node, inspect);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        ["className", "class"].includes(node.name.getText(file.source))
      ) {
        if (node.initializer) inspect(node.initializer);
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        JOINERS.has(node.expression.text)
      ) {
        for (const argument of node.arguments) inspect(argument);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
    return findings;
  },
};

function isTemplatePart(node: ts.Node): node is ts.TemplateLiteralLikeNode {
  return ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
}

/** The file's consts by the names they bind, a destructured name's too: `const [badge] = TIERS[tier]`. */
function constsOf(source: ts.SourceFile): Map<string, ts.Expression[]> {
  const consts = new Map<string, ts.Expression[]>();
  const bind = (name: ts.BindingName, value: ts.Expression): void => {
    if (ts.isIdentifier(name)) {
      consts.set(name.text, [...(consts.get(name.text) ?? []), value]);
      return;
    }
    for (const part of name.elements) {
      if (!ts.isOmittedExpression(part)) bind(part.name, value);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
      for (const { name, initializer } of node.declarations) {
        if (initializer) bind(name, initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return consts;
}

/**
 * An identifier whose value can become the class: itself, or what a member access takes from it
 * (`TONES.hot`, `VARIANTS[variant]`). Not a property's or a member's name, nor a function called,
 * its own (`cx(…)`) or a method of it (`STACKED.has(name)`).
 */
function isRead(node: ts.Identifier): boolean {
  const { parent } = node;
  const named = ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent);
  if (named && parent.name === node) return false;
  let value: ts.Node = node;
  while (
    (ts.isPropertyAccessExpression(value.parent) || ts.isElementAccessExpression(value.parent)) &&
    value.parent.expression === value
  )
    value = value.parent;
  return !(ts.isCallExpression(value.parent) && value.parent.expression === value);
}

/** The message for a class that is a physical utility, naming its logical one; undefined otherwise. */
function logicalOf(token: string): string | undefined {
  const utility = token.slice(variantsEnd(token)).replace(/^!?-?/, "");
  const parts = PHYSICAL.exec(utility)?.groups;
  if (!parts) return undefined;
  const { box, side = "", inset, align, value = "", edge, to = "" } = parts;
  const logical = box
    ? `${box}${SIDE[side]}-`
    : inset
      ? `${SIDE[inset]}-`
      : align
        ? `${align}-${SIDE[value]}`
        : `${edge}-${CORNER[to] ?? SIDE[to]}`;
  return `${token} is a physical utility: use ${logical} (logical properties, coding §4)`;
}

/** Where the utility starts: after the last `:` outside brackets, which ends the variants. */
function variantsEnd(token: string): number {
  let depth = 0;
  let end = 0;
  for (const [index, char] of [...token].entries()) {
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) end = index + 1;
  }
  return end;
}
