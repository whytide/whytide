// The Anthropic adapter's tests, all in its folder (README.md "Tests"), run by
// `pnpm -F providers test:contract`. First the LLM port's contract suite against Anthropic, with a
// made-up key's refusal, skipped while LLM_ANTHROPIC_API_KEY is empty in the environment. Then, with
// no vendor and a key made up for the run: the same suite against a local stand-in for the Messages
// API; the vendor's failures as the port's codes, with no fragment of the key in an error, its causes
// or a log; the models it serves; the base URL and the key from code; create() in production and
// misconfigured; and the lint that keeps the two SDKs in this folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { inspect } from "node:util";
import { isAppError } from "@whytide/platform";
import { generateText, streamText } from "ai";
import { contractSuite } from "../../../testing/index.ts";
import { llmCases } from "../../contract.ts";
import { llmPort } from "../../port.ts";
import { anthropicAdapter, anthropicLlm } from "../index.ts";

/** Made up for the run, so that no string in the repository looks like a key. */
const KEY = randomBytes(24).toString("base64url");
/** Every eight characters of the key in a row: none may show where a person or a log line reads. */
const FRAGMENTS = Array.from({ length: KEY.length - 7 }, (_, at) => KEY.slice(at, at + 8));
/** The fragments in a value's message, stack, own fields, hidden or not, and cause chain, all deep. */
const leaks = (value: unknown) => {
  const text = inspect(value, { depth: Number.POSITIVE_INFINITY, showHidden: true });
  return FRAGMENTS.filter((fragment) => text.includes(fragment));
};
const withCode = (code: string) => (error: unknown) => isAppError(error) && error.code === code;

contractSuite(llmPort, anthropicAdapter, {
  ...llmCases,
  "a made-up key is llm_invalid_key, with no fragment of it in the error": async () => {
    const llm = anthropicLlm({ apiKey: KEY });
    const { model } = await llm.getModel({ modelRef: "claude-haiku-5-5", onUsage: () => {} });
    const error = await generateText({ model, prompt: "Say yes." }).catch((e: unknown) => e);
    assert.ok(withCode("llm_invalid_key")(error), String(error));
    assert.deepEqual(leaks(error), []);
  },
});

/** Anthropic's error type for each status the stand-in answers with. */
const TYPES: Readonly<Record<string, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};
/** The x-api-key header of every request the stand-in received. */
const received: unknown[] = [];
// A stand-in for the Messages API. The first message says what to answer: a status as Anthropic's
// error, `slow` nothing, `error event` a stream that starts, then fails with Anthropic's overloaded
// event (as its first event, the SDK would throw it from doStream instead); anything else an answer
// of 12 and 5 tokens, generated or streamed: the object a schema asks for, else "yes".
const server = createServer(async (request, response) => {
  received.push(request.headers["x-api-key"]);
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const prompt: string = body.messages[0].content[0].text;
  if (prompt === "slow") return;
  if (Object.hasOwn(TYPES, prompt)) {
    response.writeHead(Number(prompt), { "content-type": "application/json" });
    const error = { type: TYPES[prompt], message: prompt };
    return void response.end(JSON.stringify({ type: "error", error }));
  }
  const text = body.output_config ? JSON.stringify({ city: "Paris", country: "France" }) : "yes";
  const usage = { input_tokens: 12, output_tokens: 5 };
  if (!body.stream) {
    const content = [{ type: "text", text }];
    const message = { id: "msg_1", type: "message", role: "assistant", content, usage };
    response.writeHead(200, { "content-type": "application/json" });
    return void response.end(JSON.stringify({ ...message, stop_reason: "end_turn" }));
  }
  const events = [
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 12 } } },
    ...(prompt === "error event"
      ? [{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]
      : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end(sse.join(""));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
after(() => {
  server.closeAllConnections();
  server.close();
});

// The same suite on the stand-in, so that what bindModel adds, the tokens reported and the URL
// refused, is proven without a key.
const create = () => anthropicLlm({ apiKey: KEY, baseURL });
contractSuite(
  llmPort,
  { port: llmPort, name: "anthropic-stand-in", requires: [], create },
  llmCases,
);

/** What a test logs meanwhile: console's methods, and the process warnings `ai` logs through. */
function logsOf(t: TestContext): unknown[] {
  const logged: unknown[] = [];
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => void logged.push(args));
  }
  const onWarning = (warning: Error) => void logged.push(warning);
  process.on("warning", onWarning);
  t.after(() => void process.off("warning", onWarning));
  return logged;
}

describe("anthropic adapter, offline, against a stand-in for the Messages API", () => {
  const modelOf = async (keepCause?: boolean) => {
    const llm = anthropicLlm({ apiKey: KEY, baseURL, keepCause });
    return (await llm.getModel({ modelRef: "claude-opus-5-5", onUsage: () => {} })).model;
  };

  for (const keepCause of [true, false]) {
    const cause = keepCause
      ? "the vendor error the cause outside production"
      : "no cause in production";
    it(`401, 429, 500 and 400 are mapped, ${cause}; no key in an error or a log`, async (t) => {
      const logged = logsOf(t);
      const model = await modelOf(keepCause);
      const expected = [
        [401, "llm_invalid_key"],
        [429, "llm_rate_limited"],
        [500, "llm_provider_error"],
        [400, "llm_error_unmapped"],
      ] as const;
      for (const [status, code] of expected) {
        const error = await generateText({ model, prompt: String(status) }).catch(
          (e: unknown) => e,
        );
        assert.ok(isAppError(error) && error.code === code, `${status} is ${code}`);
        assert.deepEqual(error.details, { method: "model", code: status });
        const cause = error.cause as { statusCode?: unknown } | undefined;
        assert.equal(cause?.statusCode, keepCause ? status : undefined);
        assert.deepEqual(leaks(error), []);
      }
      assert.deepEqual(leaks(logged), []);
      // The stand-in got the key every time: the checks above are not vacuous.
      assert.ok(received.length > 0 && received.every((key) => key === KEY));
    });
  }

  it("streamed, a 529 before the stream and Anthropic's overloaded event in it are llm_provider_error", async () => {
    const model = await modelOf();
    const seen: unknown[] = [];
    for (const prompt of ["529", "error event"]) {
      await streamText({
        model,
        prompt,
        onError: ({ error }) => void seen.push(error),
      }).consumeStream();
    }
    assert.equal(seen.length, 2);
    for (const error of seen) {
      assert.ok(isAppError(error) && error.code === "llm_provider_error");
      assert.deepEqual(error.details, { method: "model", code: 529 });
    }
  });

  it("a slow answer is llm_timeout, whether ai's timeout or the caller's signal ends the wait", async () => {
    const model = await modelOf();
    for (const stop of [{ timeout: 50 }, { abortSignal: AbortSignal.timeout(50) }]) {
      await assert.rejects(
        generateText({ model, prompt: "slow", ...stop }),
        withCode("llm_timeout"),
      );
    }
  });

  it("lists LLM_MODEL_DEFAULT first, then the current models, and refuses any other", async () => {
    const llm = anthropicLlm({ apiKey: KEY, baseURL, defaultModel: "claude-sonnet-5-5" });
    const listed = (await llm.listModels()).map(({ modelId }) => modelId);
    assert.deepEqual(listed, ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
    const other = llm.getModel({ modelRef: "claude-2", onUsage: () => {} });
    await assert.rejects(other, withCode(llmPort.codes.input));
  });
});

it("the base URL and the key come from code, never from the provider's ANTHROPIC_* variables", async (t) => {
  const decoys = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/decoy", ANTHROPIC_API_KEY: "decoy" };
  for (const [name, value] of Object.entries(decoys)) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  const sent: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent.push([String(input), new Headers(init?.headers).get("x-api-key")]);
    const error = { type: "authentication_error", message: "invalid x-api-key" };
    return Response.json({ type: "error", error }, { status: 401 });
  });
  const llm = anthropicLlm({ apiKey: KEY });
  const { model } = await llm.getModel({ modelRef: "claude-opus-5-5", onUsage: () => {} });
  await assert.rejects(generateText({ model, prompt: "hi" }), withCode("llm_invalid_key"));
  assert.deepEqual(sent, [["https://api.anthropic.com/v1/messages", KEY]]);
});

it("create(): LLM_MODEL_DEFAULT first, no vendor error in production; an empty key or an unserved model refused", () => {
  // The configuration is read at import: a child process for each environment, its fetch stubbed.
  const [adapter, ai] = [import.meta.resolve("../index.ts"), import.meta.resolve("ai")];
  const script = [
    `const { anthropicAdapter } = await import(${JSON.stringify(adapter)});`,
    `const { generateText } = await import(${JSON.stringify(ai)});`,
    'const error = { type: "authentication_error", message: "invalid x-api-key" };',
    'globalThis.fetch = async () => Response.json({ type: "error", error }, { status: 401 });',
    "try {",
    "  const llm = anthropicAdapter.create();",
    "  const [first] = await llm.listModels();",
    "  const { model } = await llm.getModel({ modelRef: first.modelId, onUsage() {} });",
    '  const failed = await generateText({ model, prompt: "hi" }).catch((e) => e);',
    "  console.log(JSON.stringify([first.modelId, failed.code, failed.cause === undefined]));",
    "} catch (refused) {",
    "  console.log(JSON.stringify([refused.code, refused.details]));",
    "}",
  ].join("\n");
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
  const model = "claude-sonnet-5-5";
  const production = run({
    APP_ENV: "production",
    LLM_ANTHROPIC_API_KEY: KEY,
    LLM_MODEL_DEFAULT: model,
  });
  assert.equal(
    production.stdout,
    `${JSON.stringify([model, "llm_invalid_key", true])}\n`,
    production.stderr,
  );
  const misconfigured = run({ LLM_ANTHROPIC_API_KEY: "", LLM_MODEL_DEFAULT: "claude-2" });
  const variables = [
    "LLM_ANTHROPIC_API_KEY: required by the anthropic adapter",
    "LLM_MODEL_DEFAULT: one of claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5",
  ];
  const refused = ["config_invalid", { block: "packages/providers", variables }];
  assert.equal(misconfigured.stdout, `${JSON.stringify(refused)}\n`, misconfigured.stderr);
});

it("a module file importing @ai-sdk/anthropic or @anthropic-ai/sdk fails the lint; this folder passes", () => {
  // The repository's vendor list over two files in a temporary workspace: a module's file and this
  // folder's, each importing both SDKs, so that no file here imports them for the package's own lint.
  const repository = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");
  const imports = [
    'import { createAnthropic } from "@ai-sdk/anthropic";',
    'import Anthropic from "@anthropic-ai/sdk";',
    "export { Anthropic, createAnthropic };",
  ].join("\n");
  const root = mkdtempSync(join(tmpdir(), "whytide-anthropic-lint-"));
  try {
    const files = {
      "pnpm-workspace.yaml": "",
      "tools/lint/vendor-sdks.json": readFileSync(join(repository, "tools/lint/vendor-sdks.json")),
      "core/modules/qualification/agents/assess.ts": imports,
      "core/packages/providers/llm/anthropic/index.ts": imports,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const lint = spawnSync(process.execPath, [join(repository, "tools/lint/lint.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(lint.status, 1, lint.stdout + lint.stderr);
    for (const sdk of ["@ai-sdk/anthropic", "@anthropic-ai/sdk"]) {
      const finding = `^core/modules/qualification/agents/assess\\.ts:\\d+:\\d+ vendor-sdk-in-adapter-only ${sdk} is the SDK of the adapter in core/packages/providers/llm/anthropic/`;
      assert.match(lint.stdout, new RegExp(finding, "m"));
    }
    assert.match(lint.stdout, /^2 problems in 1 file$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
