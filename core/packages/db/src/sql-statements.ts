// The statements of a SQL text, for what reads a migration rather than runs it: the expand-first
// check (expand-first.ts) and the grants a test schema starts with (testing/test-db.ts). A scanner,
// not a parser: it knows the comments (`--`, nested `/* */`), the string literals ('…', E'…',
// $tag$…$tag$) and the quoted identifiers of Postgres, so a `;` or a keyword inside one of them is
// text, not SQL; a statement ends at a `;` outside them, or at the end of the text.

export type SqlStatement = {
  /** The line its first character is on, 1-based. */
  readonly line: number;
  /**
   * The statement without its comments, every string literal emptied to `''`, every quoted
   * identifier kept to its word characters, trimmed, no `;`: what a check matches against.
   */
  readonly text: string;
  /** The statement as written, from its first character up to its `;`. */
  readonly source: string;
  /** The comment lines right above it, in order; none past a blank line or another statement. */
  readonly comments: readonly string[];
};

type LineKind = "blank" | "comment" | "code";

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

export function sqlStatements(sql: string): SqlStatement[] {
  const lines = sql.split("\n");
  const kinds: LineKind[] = lines.map(() => "blank");
  const statements: SqlStatement[] = [];
  let line = 1;
  let i = 0;
  let text = "";
  /** The line and offset of the open statement's first character; 0 before one. */
  let start = 0;
  let startAt = 0;
  /** The line the previous statement ended on. */
  let after = 0;

  const mark = (kind: LineKind, from: number, to: number) => {
    for (let l = from; l <= to; l++) {
      if (kinds[l - 1] !== "code") kinds[l - 1] = kind;
    }
  };
  const code = (piece: string, at: number, from: number) => {
    if (start === 0) {
      start = from;
      startAt = at;
    }
    text += piece;
    mark("code", from, line);
  };
  const commentsAbove = (): string[] => {
    const found: string[] = [];
    for (let l = start - 1; l > after; l--) {
      if (kinds[l - 1] !== "comment") break;
      found.unshift(lines[l - 1] ?? "");
    }
    return found;
  };
  const finish = (end: number) => {
    if (start !== 0 && text.trim() !== "") {
      statements.push({
        line: start,
        text: text.trim(),
        source: sql.slice(startAt, end),
        comments: commentsAbove(),
      });
    }
    text = "";
    start = 0;
    after = line;
  };

  while (i < sql.length) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === "\n") {
      if (start !== 0) text += "\n";
      line++;
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      mark("comment", line, line);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const from = line;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          if (sql.charAt(i) === "\n") line++;
          i++;
        }
      }
      mark("comment", from, line);
      if (start !== 0) text += " ";
      continue;
    }
    if (c === "'") {
      // E'…' takes backslash escapes; a plain literal doubles its quotes.
      const escapes = /^[eE]$/.test(sql.charAt(i - 1)) && !/[\w"']/.test(sql.charAt(i - 2));
      const from = line;
      let j = i + 1;
      while (j < sql.length) {
        const ch = sql.charAt(j);
        if (ch === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (escapes && ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n") line++;
        j++;
      }
      code("''", i, from);
      i = j;
      continue;
    }
    if (c === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 80))?.[0];
      if (tag !== undefined) {
        const from = line;
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        line += sql.slice(i, end).split("\n").length - 1;
        code("''", i, from);
        i = end;
        continue;
      }
    }
    if (c === '"') {
      const from = line;
      let j = i + 1;
      while (j < sql.length) {
        const ch = sql.charAt(j);
        if (ch === '"') {
          if (sql.charAt(j + 1) === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (ch === "\n") line++;
        j++;
      }
      code(`"${sql.slice(i + 1, j - 1).replace(/\W/g, "")}"`, i, from);
      i = j;
      continue;
    }
    if (c === ";") {
      finish(i);
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (start !== 0) text += c;
      i++;
      continue;
    }
    code(c, i, line);
    i++;
  }
  finish(sql.length);
  return statements;
}
