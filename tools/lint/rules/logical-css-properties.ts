import type { Finding, Rule } from "../rule.ts";
import { finding } from "../rule.ts";

const SIDES: Readonly<Record<string, string>> = {
  top: "block-start",
  right: "inline-end",
  bottom: "block-end",
  left: "inline-start",
};
/** A physical side or corner that has a logical name: margin-left, border-top-left-radius, left. */
const PHYSICAL =
  /^(?:(?<box>margin|padding|scroll-margin|scroll-padding|border)-(?<side>top|right|bottom|left)(?<part>-width|-style|-color)?|border-(?<block>top|bottom)-(?<inline>left|right)-radius|(?<inset>top|right|bottom|left))$/;
/** The properties whose values `left` and `right` have logical ones. */
const VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "text-align": { left: "start", right: "end" },
  float: { left: "inline-start", right: "inline-end" },
  clear: { left: "inline-start", right: "inline-end" },
};
/** A declaration: a name after `{`, `;` or the start of the file, then its value up to `;`, `{` or `}`. */
const DECLARATION = /(^|[{;])(\s*)([-\w]+)\s*:([^;{}]*)/g;
/** Comments and strings, blanked to spaces of the same length, so that the offsets stay put. */
const NOT_CODE = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;

export const rule: Rule = {
  name: "logical-css-properties",
  protects:
    "a stylesheet uses logical properties and values (margin-inline-start, text-align: start), never the physical ones (margin-left, text-align: left)",
  check(file) {
    if (!file.path.endsWith(".css")) return [];
    const code = file.source.text.replace(NOT_CODE, (text) => " ".repeat(text.length));
    const findings: Finding[] = [];
    for (const match of code.matchAll(DECLARATION)) {
      const [, before = "", space = "", name = "", value = ""] = match;
      const property = name.toLowerCase();
      const word = value
        .replace(/!important/i, "")
        .trim()
        .toLowerCase();
      const logical = logicalProperty(property);
      const logicalValue = VALUES[property]?.[word];
      const message = logical
        ? `${property} is a physical property: use ${logical}`
        : logicalValue &&
          `${property}: ${word} is a physical value: use ${property}: ${logicalValue}`;
      const at = match.index + before.length + space.length;
      if (message) findings.push(finding(file, rule.name, at, message));
    }
    return findings;
  },
};

function logicalProperty(property: string): string | undefined {
  const parts = PHYSICAL.exec(property)?.groups;
  if (!parts) return undefined;
  const { box, side = "", part = "", block, inline, inset } = parts;
  if (inset) return `inset-${SIDES[inset]}`;
  if (block && inline) {
    return `border-${block === "top" ? "start" : "end"}-${inline === "left" ? "start" : "end"}-radius`;
  }
  return `${box}-${SIDES[side]}${part}`;
}
