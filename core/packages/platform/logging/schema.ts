// The log schema (docs/rules/coding.md §9): the keys a log line may carry, at any depth, and the
// value shapes it never carries. log-schema.json next to this file mirrors it for the pipeline's
// secret-shapes check (tools/ci); the logging test keeps the two equal. A host with keys of its own
// passes a wider schema to checkLogLines and keeps its own log-schema.json.
export type LogSchema = { readonly keys: readonly string[]; readonly suffixes: readonly string[] };

export const logSchema: LogSchema = {
  keys: [
    "level",
    "time",
    "pid",
    "hostname",
    "msg",
    "trace_id",
    "span_id",
    "trace_flags",
    "workspace_id",
    "actor",
    "err",
    "type",
    "message",
    "stack",
    "cause",
    "errors",
    "code",
    "status",
    "details",
    "field",
    "variable",
    "reason",
    "purpose",
    "module",
    "event",
    "feature",
    "task",
    "vendor",
    "model",
    "units",
    "provider",
    "kind",
    "state",
    "outcome",
    "attempt",
    "service",
    "version",
    "exporting",
  ],
  suffixes: ["_id", "_ids", "_count", "_ms", "_bytes", "_at", "_version"],
};

const SHAPES: readonly (readonly [string, RegExp])[] = [
  // A domain ends in letters that no longer name follows (a sentence's period may), so a pnpm path
  // (`api@1.9.1/node_modules`) is not one.
  ["an email", /[\w.+-]+@(?:[\w-]+\.)+[a-zA-Z]{2,}(?![\w-]|\.[\w-])/],
  ["a LinkedIn profile URL", /linkedin\.com\/in\//i],
  [
    "a token",
    /\beyJ[\w-]{8,}\.[\w-]{8,}|\bBearer\s+[\w.~+/-]{16,}|\b(?:sk|rk|pk)-[\w-]{16,}|\bghp_\w{20,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b/,
  ],
];

/** A key is allowed by name, or as an id, a count, a duration, a size, a time or a version by suffix. */
export function isAllowedKey(key: string, schema: LogSchema = logSchema): boolean {
  return (
    schema.keys.includes(key) ||
    schema.suffixes.some((suffix) => key.length > suffix.length && key.endsWith(suffix))
  );
}

/** The findings over JSON log lines: a key the schema does not allow, a value shaped like PII. */
export function checkLogLines(lines: Iterable<string>, schema: LogSchema = logSchema): string[] {
  const findings: string[] = [];
  let number = 0;
  for (const line of lines) {
    number += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      findings.push(`line ${number}: not JSON`);
      continue;
    }
    walk(parsed, "", (path, key, value) => {
      if (key !== undefined && !isAllowedKey(key, schema))
        findings.push(`line ${number}: the key "${path}" is not allowed`);
      const shape =
        typeof value === "string" ? SHAPES.find(([, pattern]) => pattern.test(value)) : undefined;
      if (shape) findings.push(`line ${number}: the value of "${path}" looks like ${shape[0]}`);
    });
  }
  return findings;
}

function walk(
  value: unknown,
  path: string,
  visit: (path: string, key: string | undefined, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visit(`${path}[${index}]`, undefined, item);
      walk(item, `${path}[${index}]`, visit);
    });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      visit(here, key, item);
      walk(item, here, visit);
    }
  }
}
