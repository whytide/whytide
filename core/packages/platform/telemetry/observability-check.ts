// observability:check (alpha-p10-060; deploy/docs/observability.md): every metric a dashboard or an
// alert rule of deploy/observability/ queries is one the registry declares, every registry metric was
// emitted by a test run (the records the recorder writes under APP_ENV=test to .tmp/metrics/), and
// no recorded label value is shaped like an email, a URL or an id. The registry is read from the
// defineMetrics({ … }) calls under core/ and ee/ outside tests/, parsed, never imported. Run as
// `pnpm observability:check` from the root, after the tests; `--root <dir>` checks another tree.
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export type DeclaredMetric = {
  readonly name: string;
  readonly kind: string;
  readonly unit?: string;
  readonly file: string;
};
export type Query = { readonly file: string; readonly title: string; readonly expr: string };

const SKIPPED = new Set(["node_modules", "dist", "tests", ".tmp"]);
const UNIT_WORDS: Readonly<Record<string, string>> = { s: "seconds", By: "bytes" };
const SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  counter: ["_total"],
  histogram: ["_bucket", "_sum", "_count"],
  gauge: [""],
};
const NOT_METRICS = new Set(["and", "or", "unless", "bool", "offset", "inf", "nan"]);
const SHAPES: readonly (readonly [string, RegExp])[] = [
  ["an email", /[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}/i],
  ["a URL", /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i],
  ["an id", /\b[a-z][a-z0-9]{1,7}_[0-9A-HJKMNP-TV-Z]{26}\b/],
  ["an id", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i], // ws_<uuid> too
];

/** Every metric a defineMetrics({ … }) call declares under core/ and ee/ of `root`, with its file. */
export function collectMetrics(root: string): DeclaredMetric[] {
  const declared: DeclaredMetric[] = [];
  const files = ["core", "ee"].flatMap((folder) => filesIn(join(root, folder), ".ts"));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("defineMetrics(")) continue;
    const visit = (node: ts.Node) => {
      const [shape] =
        ts.isCallExpression(node) && calls(node, "defineMetrics") ? node.arguments : [];
      if (shape && ts.isObjectLiteralExpression(shape)) {
        for (const property of shape.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
          if (!ts.isObjectLiteralExpression(property.initializer)) continue;
          const field = (key: string) =>
            stringField(property.initializer as ts.ObjectLiteralExpression, key);
          const unit = field("unit");
          const entry = {
            name: property.name.text,
            kind: field("kind") ?? "",
            file: relative(root, file),
          };
          declared.push(unit ? { ...entry, unit } : entry);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return declared;
}

/** The PromQL of every dashboard panel and alert rule in the JSON files under `folder`. */
export function collectQueries(root: string, folder: string): Query[] {
  return filesIn(folder, ".json").flatMap((path) => {
    const file = relative(root, path);
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const panels = (list: unknown): Query[] =>
      asArray(list).flatMap((panel) => [
        ...asArray(panel.targets).map((t) => ({
          file,
          title: `${panel.title}`,
          expr: `${t.expr}`,
        })),
        ...panels(panel.panels),
      ]);
    const rules = asArray(json.groups).flatMap((group) => asArray(group.rules));
    const alerts = rules.flatMap((rule) =>
      asArray(rule.data)
        .filter((query) => query.datasourceUid !== "__expr__")
        .map((query) => ({ file, title: `${rule.title}`, expr: `${asRecord(query.model).expr}` })),
    );
    return [...panels(json.panels), ...alerts];
  });
}

/** The metric names a PromQL expression reads: what is left once strings, matchers, ranges, label lists and calls are taken out. */
export function metricNames(expr: string): string[] {
  const bare = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, "")
    .replace(/\{[^}]*\}|\[[^\]]*\]/g, "")
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/gi, "");
  const names = new Set<string>();
  for (const match of bare.matchAll(/(?<![\w.$])[a-zA-Z_:][\w:]*/g)) {
    const rest = bare.slice(match.index + match[0].length);
    if (/^\s*\(/.test(rest) || NOT_METRICS.has(match[0].toLowerCase())) continue;
    names.add(match[0]);
  }
  return [...names];
}

/** The names Prometheus gives a metric it receives over OTLP: dots to underscores, the unit's word, the kind's suffixes. */
export function prometheusNames({ name, kind, unit }: DeclaredMetric): string[] {
  const word = unit === undefined ? undefined : UNIT_WORDS[unit];
  const base = `${name.replaceAll(".", "_")}${word ? `_${word}` : ""}`;
  return (SUFFIXES[kind] ?? [""]).map((suffix) => `${base}${suffix}`);
}

/** Per metric, the label sets of every record file in `folder`: what the test runs emitted. */
export function readRecorded(folder: string): Map<string, Record<string, unknown>[]> {
  const recorded = new Map<string, Record<string, unknown>[]>();
  for (const path of filesIn(folder, ".json")) {
    const records = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [name, sets] of Object.entries(records)) {
      recorded.set(name, [...(recorded.get(name) ?? []), ...asArray(sets)]);
    }
  }
  return recorded;
}

/** The findings, one line each; none when the dashboards, the alerts, the registry and the records agree. */
export function checkObservability(
  root: string,
  records = join(root, ".tmp", "metrics"),
): string[] {
  const declared = collectMetrics(root);
  const findings: string[] = [];
  const known = new Set(declared.flatMap(prometheusNames));
  for (const { file, title, expr } of collectQueries(root, join(root, "deploy", "observability"))) {
    for (const name of metricNames(expr).filter((each) => !known.has(each))) {
      findings.push(`${file}: "${title}" queries ${name}, which no defineMetrics declares`);
    }
  }
  const recorded = readRecorded(records);
  for (const { name, file } of declared) {
    if (!recorded.has(name)) {
      findings.push(`${file}: ${name} was emitted by no test run: run its package's tests first`);
    }
  }
  for (const [name, sets] of recorded) {
    for (const [label, value] of sets.flatMap((set) => Object.entries(set))) {
      const shape = SHAPES.find(([, pattern]) => typeof value === "string" && pattern.test(value));
      if (shape)
        findings.push(`${name}: the label ${label} carried a value shaped like ${shape[0]}`);
    }
  }
  return [...new Set(findings)];
}

function calls(node: ts.CallExpression, name: string): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === name;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === name;
}

function stringField(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === key && ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function filesIn(folder: string, extension: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return filesIn(path, extension);
    return entry.name.endsWith(extension) ? [path] : [];
  });
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--root");
  const root = resolve(
    flag > 0 ? `${process.argv[flag + 1]}` : join(import.meta.dirname, "../../../.."),
  );
  const findings = checkObservability(root);
  const say = (text: string) => process.stdout.write(`${text}\n`);
  if (findings.length) {
    say(findings.join("\n"));
    say(`observability:check: ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    process.exit(1);
  }
  const count = collectMetrics(root).length;
  say(`observability:check: ok, ${count} metrics, every one emitted, every query known`);
}
