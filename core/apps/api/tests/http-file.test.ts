// The .http parser (openapi/http-file.ts) that the runner and the coverage check read the files with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { parseHttpFile, routesWithoutRequest, substitute } from "../openapi/http-file.ts";

const file = [
  "# a header comment",
  "",
  "### POST /v1/x: makes one",
  "POST {{baseUrl}}/v1/x?dry=1 HTTP/1.1",
  "Content-Type: application/json",
  "# a comment between headers",
  "Cookie: {{sessionCookie}}",
  "",
  '{ "name": "{{name}}" }',
  "",
  "### GET /v1/x/{id}",
  "// a comment",
  "GET {{baseUrl}}/v1/x/{{id}}",
].join("\n");

test("the parser reads the requests, their headers and bodies; the coverage check and the variables", () => {
  const [post, get] = parseHttpFile(file, "x.http");
  assert.deepEqual(post, {
    file: "x.http",
    line: 4,
    title: "POST /v1/x: makes one",
    method: "POST",
    url: "{{baseUrl}}/v1/x?dry=1",
    headers: [
      ["Content-Type", "application/json"],
      ["Cookie", "{{sessionCookie}}"],
    ],
    body: '{ "name": "{{name}}" }',
  });
  assert.deepEqual(
    [get?.line, get?.method, get?.url, get?.body],
    [13, "GET", "{{baseUrl}}/v1/x/{{id}}", undefined],
  );

  const details = { file: "y.http", line: 2, expected: "a request line: METHOD URL" };
  assert.throws(
    () => parseHttpFile("###\nFETCH /x", "y.http"),
    appError("http_file_invalid", details),
  );
  assert.equal(substitute("{{ a }}-{{b}}", { a: "1", b: "2" }), "1-2");
  assert.throws(
    () => substitute("{{c}}", {}),
    appError("http_variable_missing", { variable: "c" }),
  );

  const routes = [
    { method: "POST", path: "/v1/x" },
    { method: "GET", path: "/v1/x/{id}" },
    { method: "DELETE", path: "/v1/x/{id}" },
  ];
  assert.ok(post && get);
  assert.deepEqual(routesWithoutRequest(routes, [post, get]), ["DELETE /v1/x/{id}"]);
  const worker = { ...get, url: "{{workerHealthUrl}}/health" };
  assert.deepEqual(routesWithoutRequest(routes, [post, worker]), [
    "GET /v1/x/{id}",
    "DELETE /v1/x/{id}",
  ]);
  const literal = { ...get, url: "http://127.0.0.1:3001/v1/x" };
  assert.throws(() => routesWithoutRequest(routes, [literal]), appError("http_file_invalid"));
});

function appError(code: string, details?: Record<string, unknown>) {
  return (error: unknown) => {
    assert.ok(isAppError(error), String(error));
    assert.deepEqual([error.code, details ?? error.details], [code, error.details]);
    return true;
  };
}
