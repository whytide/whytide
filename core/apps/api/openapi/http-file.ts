// The .http files (README "The .http file"), in the subset of the VS Code REST Client and JetBrains
// HTTP Client format that api-calls/README.md uses: a `###` line opens a request, then its request
// line `METHOD URL`, its headers, a blank line and its body; `#` and `//` lines are comments outside a
// body. The runner (tests/http-run.ts) and the coverage check of `pnpm openapi:build` read them here.
import { AppError } from "@whytide/platform";
import { openapiErrors } from "./errors.ts";

export type HttpRequest = {
  readonly file: string;
  /** The request line's, 1-based. */
  readonly line: number;
  readonly title: string;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
  readonly body?: string;
};

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REQUEST_LINE = /^([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/;
const HEADER = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(.*)$/;
const COMMENT = /^(#|\/\/)/;

export function parseHttpFile(text: string, file: string): HttpRequest[] {
  const lines = text.split(/\r?\n/);
  const marks = lines.flatMap((line, at) => (line.startsWith("###") ? [at] : []));
  // The lines before the first ### line are a block too: a file's header comment, or a request.
  const blocks = [
    { from: 0, end: marks[0] ?? lines.length, title: "" },
    ...marks.map((at, index) => ({
      from: at + 1,
      end: marks[index + 1] ?? lines.length,
      title: (lines[at] ?? "").slice(3).trim(),
    })),
  ];
  return blocks.flatMap(({ from, end, title }) => {
    const request = parseBlock(lines, from, end, file);
    return request ? [{ ...request, title }] : [];
  });
}

function parseBlock(lines: readonly string[], from: number, end: number, file: string) {
  let at = from;
  const skip = (line = "") => line.trim() === "" || COMMENT.test(line.trim());
  while (at < end && skip(lines[at])) at++;
  if (at >= end) return undefined; // a block of comments only, such as the file's header
  const invalid = (line: number, expected: string) =>
    new AppError(openapiErrors.http_file_invalid, { details: { file, line: line + 1, expected } });
  const requestLine = REQUEST_LINE.exec((lines[at] ?? "").trim());
  if (!requestLine || !METHODS.has(requestLine[1] ?? "")) {
    throw invalid(at, "a request line: METHOD URL");
  }
  const line = at + 1;
  const headers: [string, string][] = [];
  for (at++; at < end && (lines[at] ?? "").trim() !== ""; at++) {
    const text = (lines[at] ?? "").trim();
    if (COMMENT.test(text)) continue;
    const header = HEADER.exec(text);
    if (!header) throw invalid(at, "a header: Name: value");
    headers.push([header[1] ?? "", header[2] ?? ""]);
  }
  const body = lines
    .slice(at + 1, end)
    .join("\n")
    .trimEnd();
  const [, method = "", url = ""] = requestLine;
  return { file, line, method, url, headers, ...(body ? { body } : {}) };
}

/** `{{name}}` replaced from the environment; a name it does not set is http_variable_missing. */
export function substitute(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, name: string) => {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (value === undefined) {
      throw new AppError(openapiErrors.http_variable_missing, { details: { variable: name } });
    }
    return value;
  });
}

/**
 * The hosts a request may call, by the variable its URL starts with: the api, and the worker's
 * health server (core/apps/worker/README.md "Health"), which the coverage check skips.
 */
export const HOST_VARIABLES = ["baseUrl", "workerHealthUrl"] as const;
export const EXPECTED_URL = HOST_VARIABLES.map((host) => `{{${host}}}/…`).join(" or ");

/** The host variable of a URL written `{{host}}/…`; undefined for any other URL. */
export function requestHost(url: string): (typeof HOST_VARIABLES)[number] | undefined {
  const name = /^\{\{\s*(\w+)\s*\}\}(?:[/?#]|$)/.exec(url)?.[1];
  return HOST_VARIABLES.find((host) => host === name);
}

/** The path a request calls, from a URL written `{{baseUrl}}/…`; undefined for any other URL. */
export function requestPath(url: string): string | undefined {
  const match = /^\{\{\s*baseUrl\s*\}\}(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
  return match ? (match[1] ?? "/") : undefined;
}

/** Whether a request path calls a route path of the document, `{name}` matching any one segment. */
export function callsRoute(template: string, path: string): boolean {
  const want = template.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  return (
    want.length === have.length &&
    want.every((segment, at) => (/^\{[^}]+\}$/.test(segment) ? true : segment === have[at]))
  );
}

/**
 * The coverage check: every route, `GET /v1/…`, needs one request of the files that calls it; a
 * request whose URL does not start with a host variable, {{baseUrl}} or {{workerHealthUrl}}, breaks
 * the convention. Returns the routes no request calls.
 */
export function routesWithoutRequest(
  routes: readonly { readonly method: string; readonly path: string }[],
  requests: readonly HttpRequest[],
): string[] {
  for (const request of requests) {
    if (requestHost(request.url) === undefined) {
      const details = { file: request.file, line: request.line, expected: EXPECTED_URL };
      throw new AppError(openapiErrors.http_file_invalid, { details });
    }
  }
  const api = requests.flatMap((r) => {
    const path = requestPath(r.url);
    return path === undefined ? [] : [{ method: r.method, path }];
  });
  return routes
    .filter(({ method, path }) =>
      api.every((r) => r.method !== method || !callsRoute(path, r.path)),
    )
    .map(({ method, path }) => `${method} ${path}`);
}
