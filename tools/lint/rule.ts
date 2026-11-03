import ts from "typescript";

/** A file under lint: its repository-relative path, its syntax tree and its imports. */
export type LintFile = {
  /** Relative to the repository root, with forward slashes: `core/modules/contacts/index.ts`. */
  readonly path: string;
  readonly source: ts.SourceFile;
  readonly imports: readonly ImportRef[];
  /** Adapter folder to the vendor SDK packages only it may import (`tools/lint/vendor-sdks.json`). */
  readonly vendorSdks: VendorRegistry;
  /** Whether a repository-relative path exists; rules use it to find a package by its name. */
  readonly exists: (path: string) => boolean;
  /** The files directly in a repository-relative folder, name to text: for a rule that reads a non-code file. */
  readonly readFolder?: (folder: string) => ReadonlyMap<string, string>;
};

/**
 * One import, export-from, dynamic `import()`, `require()`, call of a `createRequire(…)` result or
 * `process.getBuiltinModule()`: its specifier (a `file:` URL as the path Node loads, and a path into
 * `node_modules` as the package it reaches) and the literal node.
 */
export type ImportRef = {
  readonly specifier: string;
  readonly node: ts.StringLiteralLike;
};

export type VendorRegistry = Readonly<Record<string, readonly string[]>>;

export type TextEdit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export type Finding = {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** Present when the rule can fix the finding; `--fix` applies it. */
  readonly fix?: TextEdit;
};

/** One file per rule under `rules/`; the linter loads every file there. */
export type Rule = {
  readonly name: string;
  /** One line, for the README and the root AGENTS.md. */
  readonly protects: string;
  readonly check: (file: LintFile) => Finding[];
};

export function finding(
  file: LintFile,
  rule: string,
  position: number,
  message: string,
  fix?: TextEdit,
): Finding {
  const { line, character } = file.source.getLineAndCharacterOfPosition(position);
  const base = { rule, path: file.path, line: line + 1, column: character + 1, message };
  return fix ? { ...base, fix } : base;
}

/** The start of a node without its leading trivia. */
export function startOf(file: LintFile, node: ts.Node): number {
  return node.getStart(file.source);
}

/** Parentheses, `as`, `satisfies`, `!` or a `<T>` cast: a wrapper that leaves the value as it is. */
export function isWrapper(
  node: ts.Node,
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/** The expression inside its wrappers: `(globalThis as any)` is `globalThis`. */
export function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (isWrapper(inner)) inner = inner.expression;
  return inner;
}
