import ts from "typescript";
import { isMessageKey } from "./keys.ts";
import { type MessageRoot, relativePath } from "./messages.ts";

/** A place in a source file: the path relative to the repository root, line and column from 1. */
export type Site = { readonly path: string; readonly line: number; readonly column: number };
export type Use = Site & { readonly key: string };
/** A key, a namespace or an error code the check cannot read, and why. */
export type Dynamic = Site & { readonly message: string };
export type Scan = {
  readonly uses: Use[];
  readonly dynamic: Dynamic[];
  /** The error codes registered, `key` being the code. */
  readonly codes: Use[];
  files: number;
};

export type ScanOptions = {
  /** A screen: `t('…')` calls and the `useTranslations('ns')` + `t('rest')` form are uses. */
  readonly screen: boolean;
  /** A `nav.ts`: its string literals shaped like keys are uses. */
  readonly nav: boolean;
  /** A module's `errors.ts`: the codes of `defineErrors({ … })` are collected. */
  readonly errors: boolean;
  /** Keys are string literals here, so the check can read them; the platform's own runtime composes keys by design. */
  readonly literalKeys: boolean;
};

/** What a factory call gives its `t`: a namespace, or something the check cannot read. */
type Resolved =
  | { readonly namespace: string }
  | { readonly problem: ts.Node; readonly message: string };

const EXCLUDED = [
  "**/node_modules",
  "**/dist",
  "**/.next",
  "**/tests",
  "**/*.generated.*",
  "**/*.d.ts",
];
/** next-intl's makers of a `t`. */
const FACTORIES = new Set(["useTranslations", "getTranslations"]);
/** `t.rich('…')`, `t.has('…')` and the like take a key too. */
const METHODS = new Set(["rich", "markup", "raw", "has"]);
const KEY_MESSAGE =
  "the key is built at run time; the check reads string literals only, so write the whole key";
const NAMESPACE_MESSAGE =
  "the namespace of useTranslations or getTranslations is not a string literal, so the keys under it cannot be read";
const CODES_MESSAGE =
  "the error codes must be written out: a computed or spread member of defineErrors cannot be read";

/**
 * Every source file of a message root, read for the keys it uses and the codes it registers, never
 * run: screens under `ui/` (the whole package for ui and the web host, `i18n/` for the platform's own strings),
 * `nav.ts` entries, `renderMail('…')` calls anywhere, the codes of a module's `errors.ts`.
 */
export function scanRoot(root: MessageRoot, repoRoot: string): Scan {
  const dir = root.dir.replaceAll("\\", "/");
  const whole = root.module === "ui" || root.module === "web";
  const screens = root.kind === "module" ? `${dir}/ui` : whole ? dir : `${dir}/i18n`;
  const scan: Scan = { uses: [], dynamic: [], codes: [], files: 0 };
  for (const file of ts.sys.readDirectory(dir, [".ts", ".tsx"], EXCLUDED).sort()) {
    const screen = file === screens || file.startsWith(`${screens}/`);
    const part = scanSource(relativePath(repoRoot, file), ts.sys.readFile(file) ?? "", {
      screen,
      nav: screen && file.endsWith("/nav.ts"),
      errors: root.kind === "module" && file === `${dir}/errors.ts`,
      literalKeys: root.module !== "platform",
    });
    scan.uses.push(...part.uses);
    scan.dynamic.push(...part.dynamic);
    scan.codes.push(...part.codes);
    scan.files++;
  }
  return scan;
}

/** The keys one file uses and the codes it registers, from its syntax tree. */
export function scanSource(path: string, text: string, options: ScanOptions): Scan {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const scan: Scan = { uses: [], dynamic: [], codes: [], files: 1 };
  const at = (node: ts.Node): Site => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { path, line: line + 1, column: character + 1 };
  };
  const reported = new Set<string>();
  const dynamic = (node: ts.Node, message: string): void => {
    if (!options.literalKeys) return;
    const site = at(node);
    const id = `${site.line}:${site.column}`;
    if (reported.has(id)) return;
    reported.add(id);
    scan.dynamic.push({ ...site, message });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const callee = calleeName(node.expression);
      const translator = options.screen ? translatorOf(node) : undefined;
      if (translator) {
        if ("problem" in translator) {
          dynamic(translator.problem, translator.message);
        } else if (first && ts.isStringLiteralLike(first)) {
          const { namespace } = translator;
          scan.uses.push({
            ...at(first),
            key: namespace ? `${namespace}.${first.text}` : first.text,
          });
        } else {
          dynamic(first ?? node, KEY_MESSAGE);
        }
      } else if (callee === "renderMail") {
        if (first && ts.isStringLiteralLike(first)) {
          for (const part of ["subject", "body"])
            scan.uses.push({ ...at(first), key: `${first.text}.${part}` });
        } else {
          dynamic(first ?? node, KEY_MESSAGE);
        }
      } else if (options.errors && callee === "defineErrors") {
        const codes = node.arguments.find(ts.isObjectLiteralExpression);
        if (!codes) dynamic(first ?? node, CODES_MESSAGE);
        for (const property of codes?.properties ?? []) {
          const name = property.name;
          if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) {
            scan.codes.push({ ...at(name), key: name.text });
          } else {
            dynamic(property, CODES_MESSAGE);
          }
        }
      }
    } else if (
      options.nav &&
      ts.isStringLiteralLike(node) &&
      isMessageKey(node.text) &&
      !isArgument(node)
    ) {
      scan.uses.push({ ...at(node), key: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scan;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/**
 * What a call translates with: the namespace its `t` was made with (`""` for whole keys), a
 * namespace the check cannot read, or undefined when the callee is no translator. A translator is
 * `t`, or any name a `useTranslations(…)` or `getTranslations(…)` declaration in an enclosing block made.
 */
function translatorOf(call: ts.CallExpression): Resolved | undefined {
  const callee = call.expression;
  const id = ts.isIdentifier(callee)
    ? callee
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        METHODS.has(callee.name.text)
      ? callee.expression
      : undefined;
  if (!id) return undefined;
  const factory = translatorFactory(id.text, call);
  if (factory) return namespaceOf(factory);
  return id.text === "t" ? { namespace: "" } : undefined;
}

/** The namespace a factory call gives: none, a string, or the `namespace` of its options object. */
function namespaceOf(factory: ts.CallExpression): Resolved {
  const [arg] = factory.arguments;
  if (arg === undefined) return { namespace: "" };
  if (ts.isStringLiteralLike(arg)) return { namespace: arg.text };
  if (!ts.isObjectLiteralExpression(arg)) return { problem: arg, message: NAMESPACE_MESSAGE };
  const option = arg.properties.find(
    (p) =>
      p.name &&
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      p.name.text === "namespace",
  );
  if (!option) {
    const spread = arg.properties.some(ts.isSpreadAssignment);
    return spread ? { problem: arg, message: NAMESPACE_MESSAGE } : { namespace: "" };
  }
  if (ts.isPropertyAssignment(option) && ts.isStringLiteralLike(option.initializer)) {
    return { namespace: option.initializer.text };
  }
  return { problem: option, message: NAMESPACE_MESSAGE };
}

/** The `useTranslations(…)` or `getTranslations(…)` call that declares `name` in a scope around `from`, if one does. */
function translatorFactory(name: string, from: ts.Node): ts.CallExpression | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        const init = declaration.initializer;
        const call = init && ts.isAwaitExpression(init) ? init.expression : init;
        const made =
          call && ts.isCallExpression(call) && FACTORIES.has(calleeName(call.expression) ?? "");
        return made ? call : undefined;
      }
    }
  }
  return undefined;
}

function isArgument(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.arguments.some((arg) => arg === node);
}
