// env:check (docs/rules/coding.md §8): deploy/.env.example and the defineConfig blocks in the code
// agree. Every block of the file but `deploy` holds exactly the variables one defineConfig(block, …)
// declares, marked `# secret` where the declaration wraps secret(). The deploy block belongs to
// Compose and env:create: a declared variable found there has to move to its own block. Run as
// `pnpm env:check` from the root (node config/env-check.ts), or import checkEnv in a test.
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export type Declaration = {
  readonly block: string;
  readonly variable: string;
  readonly secret: boolean;
  readonly file: string;
};
/** Block name to variable name to "marked # secret". */
type Documented = Map<string, Map<string, boolean>>;

const SKIPPED = new Set(["node_modules", "dist", "tests"]);
const HEADER = /^# ---- (.+) ----$/;
const VARIABLE = /^([A-Z][A-Z0-9_]*)=.*?(#\s*secret\s*)?$/;

/** Every defineConfig(block, { … }) under core/ and ee/ of `root`, parsed, never imported. */
export function collectDeclarations(root: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const file of ["core", "ee"].flatMap((folder) => sourceFiles(join(root, folder)))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("defineConfig(")) continue;
    const visit = (node: ts.Node) => {
      const [block, shape] =
        ts.isCallExpression(node) && calls(node, "defineConfig") ? node.arguments : [];
      if (block && ts.isStringLiteral(block) && shape && ts.isObjectLiteralExpression(shape)) {
        for (const property of shape.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
          const secret =
            ts.isCallExpression(property.initializer) && calls(property.initializer, "secret");
          declarations.push({
            block: block.text,
            variable: property.name.text,
            secret,
            file: relative(root, file),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return declarations;
}

function calls(node: ts.CallExpression, name: string): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === name;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === name;
}

function sourceFiles(folder: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

export function parseExample(text: string): Documented {
  const blocks: Documented = new Map();
  let block = "";
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line)?.[1];
    if (header) {
      block = header;
      blocks.set(block, new Map());
      continue;
    }
    const variable = VARIABLE.exec(line);
    if (variable?.[1] && block) blocks.get(block)?.set(variable[1], variable[2] !== undefined);
  }
  return blocks;
}

/** The findings, one line each; none when the file and the declarations agree. */
export function checkEnv(examplePath: string, declarations: readonly Declaration[]): string[] {
  const documented = parseExample(readFileSync(examplePath, "utf8"));
  const deploy = documented.get("deploy") ?? new Map<string, boolean>();
  const declared = new Map<string, Map<string, Declaration>>();
  const findings: string[] = [];
  for (const d of declarations) {
    declared.set(d.block, (declared.get(d.block) ?? new Map()).set(d.variable, d));
    if (deploy.has(d.variable)) {
      findings.push(
        `${d.variable} is declared in ${d.file} but sits in the deploy block of .env.example: move it to the ${d.block} block`,
      );
    }
  }
  for (const [name, variables] of declared) {
    const block = documented.get(name);
    if (!block) {
      findings.push(`the block "# ---- ${name} ----" is missing from .env.example`);
      continue;
    }
    for (const [variable, d] of variables) {
      const marked = block.get(variable);
      if (marked === undefined) {
        if (!deploy.has(variable))
          findings.push(
            `${variable} is declared in ${d.file} (${name}) but missing from .env.example`,
          );
      } else if (marked && !d.secret) {
        findings.push(
          `${variable} is marked # secret in .env.example but not declared with secret() in ${d.file}`,
        );
      } else if (!marked && d.secret) {
        findings.push(
          `${variable} is declared with secret() in ${d.file} but its line in .env.example lacks # secret`,
        );
      }
    }
  }
  for (const [name, variables] of documented) {
    for (const variable of variables.keys()) {
      if (name !== "deploy" && !declared.get(name)?.has(variable)) {
        findings.push(
          `${variable} is documented in the ${name} block of .env.example but nobody declares it`,
        );
      }
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..", "..", "..", "..");
  const declarations = collectDeclarations(root);
  const findings = checkEnv(join(root, "deploy", ".env.example"), declarations);
  const say = (text: string) => process.stdout.write(`${text}\n`);
  if (findings.length) {
    say(findings.join("\n"));
    say(
      `env:check: ${findings.length} finding${findings.length === 1 ? "" : "s"} (core/packages/platform/README.md "Config")`,
    );
    process.exit(1);
  }
  const blocks = new Set(declarations.map((d) => d.block)).size;
  say(
    `env:check: ok, ${declarations.length} variables in ${blocks} block${blocks === 1 ? "" : "s"}`,
  );
}
