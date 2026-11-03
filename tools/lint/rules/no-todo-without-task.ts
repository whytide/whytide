import ts from "typescript";
import type { Finding, Rule } from "../rule.ts";
import { finding } from "../rule.ts";

const TODO = /\bTODO\b/i;
const TASK_ID = /\b[a-z0-9]+-p\d+-\d+\b/;

export const rule: Rule = {
  name: "no-todo-without-task",
  protects: "a TODO comment carries the ID of the task that will do it, like alpha-p3-020",
  check(file) {
    const findings: Finding[] = [];
    const seen = new Set<number>();
    const text = file.source.text;
    const inspect = (ranges: readonly ts.CommentRange[] | undefined) => {
      for (const range of ranges ?? []) {
        if (seen.has(range.pos)) continue;
        seen.add(range.pos);
        const comment = text.slice(range.pos, range.end);
        if (TODO.test(comment) && !TASK_ID.test(comment)) {
          const message =
            "a TODO names its task: `TODO alpha-p3-020: ...`, or it is a task to create";
          findings.push(finding(file, rule.name, range.pos, message));
        }
      }
    };
    const visit = (node: ts.Node) => {
      inspect(ts.getLeadingCommentRanges(text, node.getFullStart()));
      inspect(ts.getTrailingCommentRanges(text, node.getEnd()));
      ts.forEachChild(node, visit);
    };
    visit(file.source);
    return findings;
  },
};
