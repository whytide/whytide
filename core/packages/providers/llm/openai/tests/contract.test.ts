// The OpenAI adapter's tests (README.md "Tests"), run by `pnpm -F providers test:contract` with
// strict-schemas.test.ts beside it. First the LLM port's contract suite against OpenAI, with a
// made-up key's refusal, skipped while LLM_OPENAI_API_KEY is empty in the environment. Then, with
// no vendor and a key made up for the run: the same suite against a local stand-in for the
// Responses API (stand-in.ts), generated and streamed; the request every call sends; the tokens
// reported; the vendor's failures as the port's codes, with no fragment of the key in an error, its
// causes or a log; the models each effort serves; the provider id; the base URL and the key from
// code; create() in production and misconfigured; and the lint that keeps the SDK in this folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { inspect } from "node:util";
import { isAppError } from "@whytide/platform";
import { generateText, streamText } from "ai";
import { contractSuite } from "../../../testing/index.ts";
import { llmCases } from "../../contract.ts";
import { type LlmUsage, llmPort } from "../../port.ts";
import { EFFORTS } from "../constants.ts";
import { type OpenAIOptions, openaiAdapter, openaiLlm } from "../index.ts";
import { startStandIn } from "./stand-in.ts";

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
const ALL_FIVE = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol"];

contractSuite(llmPort, openaiAdapter, {
  ...llmCases,
  "a made-up key is llm_invalid_key, with no fragment of it in the error": async () => {
    const llm = openaiLlm({ apiKey: KEY });
    const { model } = await llm.getModel({ modelRef: "gpt-6-luna", onUsage: () => {} });
    const error = await generateText({ model, prompt: "Say yes." }).catch((e: unknown) => e);
    assert.ok(withCode("llm_invalid_key")(error), String(error));
    assert.deepEqual(leaks(error), []);
  },
});

const standIn = await startStandIn();
const { baseURL } = standIn;
after(() => standIn.close());
const llmOf = (options: Partial<OpenAIOptions> = {}) =>
  openaiLlm({ apiKey: KEY, baseURL, ...options });

// The same suite on the stand-in, so that what bindModel adds, the tokens reported and the URL
// refused, is proven without a key.
contractSuite(
  llmPort,
  { port: llmPort, name: "openai-stand-in", requires: [], create: () => llmOf() },
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

describe("openai adapter, offline, against a stand-in for the Responses API", () => {
  const modelOf = async (options: Partial<OpenAIOptions> = {}, usages: LlmUsage[] = []) => {
    const llm = llmOf(options);
    const [first] = await llm.listModels();
    const onUsage = (usage: LlmUsage) => void usages.push(usage);
    return (await llm.getModel({ modelRef: first?.modelId ?? "", onUsage })).model;
  };
  const lastBody = () => standIn.received.at(-1)?.body ?? { model: "", input: [] };

  it("every call sends its effort, store false, no reasoning summary and the headroom (none: no headroom); no tool, no URL", async () => {
    for (const effort of EFFORTS) {
      const listed = await llmOf({ effort, defaultModel: "gpt-6-sol" }).listModels();
      assert.equal(listed.length, effort === "none" ? 2 : 5, effort);
      for (const { modelId } of listed) {
        const llm = llmOf({ effort, defaultModel: "gpt-6-sol" });
        const { model } = await llm.getModel({ modelRef: modelId, onUsage: () => {} });
        for (const stream of [false, true]) {
          const call = { model, prompt: "Say yes.", maxOutputTokens: 1_500 };
          if (stream) await streamText(call).consumeStream();
          else await generateText(call);
          const { model: sent, reasoning, store, include, max_output_tokens, ...rest } = lastBody();
          // The effort sent proves the SDK kept it: a model it drops the effort of is not served.
          assert.deepEqual(
            { sent, reasoning, store, include, max_output_tokens },
            {
              sent: modelId,
              reasoning: { effort },
              store: false,
              // The SDK asks for the reasoning's encrypted content when store is false.
              include: ["reasoning.encrypted_content"],
              max_output_tokens: effort === "none" ? 1_500 : 26_500,
            },
            `${modelId} at ${effort}`,
          );
          assert.equal(rest.tools, undefined);
          assert.equal(rest.text, undefined);
          assert.doesNotMatch(JSON.stringify(lastBody()), /https?:/);
        }
      }
    }
    // A call with no cap gets none: the model's own limit.
    await generateText({ model: await modelOf(), prompt: "Say yes." });
    assert.equal(lastBody().max_output_tokens, undefined);
  });

  it("the tokens reported, and so the cost event's, count the reasoning in the output, generated or streamed", async () => {
    const usages: LlmUsage[] = [];
    const model = await modelOf({}, usages);
    await generateText({ model, prompt: "Say yes." });
    await streamText({ model, prompt: "Say yes." }).consumeStream();
    const tokens = { inputTokens: 12, outputTokens: 105 };
    assert.deepEqual(usages, [tokens, tokens]);
  });

  for (const keepCause of [true, false]) {
    const cause = keepCause
      ? "the vendor error the cause outside production"
      : "no cause in production";
    it(`401, 429 with its wait, insufficient_quota, 500 and 400 are mapped, ${cause}; no key in an error or a log`, async (t) => {
      const logged = logsOf(t);
      const model = await modelOf({ keepCause });
      const expected = [
        ["401", 401, "llm_invalid_key", { code: 401 }],
        ["429", 429, "llm_rate_limited", { code: 429, retryAfterSec: 20 }],
        ["429 ms", 429, "llm_rate_limited", { code: 429, retryAfterSec: 2 }],
        ["quota", 429, "llm_provider_error", { code: "insufficient_quota", status: 429 }],
        ["500", 500, "llm_provider_error", { code: 500 }],
        ["400", 400, "llm_error_unmapped", { code: 400 }],
      ] as const;
      for (const [prompt, status, code, details] of expected) {
        const error = await generateText({ model, prompt }).catch((e: unknown) => e);
        assert.ok(isAppError(error) && error.code === code, `${prompt} is ${code}`);
        assert.deepEqual(error.details, { method: "model", ...details });
        const cause = error.cause as { statusCode?: unknown } | undefined;
        assert.equal(cause?.statusCode, keepCause ? status : undefined);
        assert.deepEqual(leaks(error), []);
      }
      assert.deepEqual(leaks(logged), []);
      // The stand-in got the key every time: the checks above are not vacuous.
      const keys = standIn.received.map(({ headers }) => headers.authorization);
      assert.ok(keys.length > 0 && keys.every((key) => key === `Bearer ${KEY}`));
    });
  }

  it("streamed, a 429 and insufficient_quota before the stream and a server error event in it are mapped", async () => {
    const model = await modelOf();
    const seen: unknown[] = [];
    for (const prompt of ["429", "quota stream", "error event"]) {
      await streamText({
        model,
        prompt,
        onError: ({ error }) =>
          void seen.push(isAppError(error) ? [error.code, error.details] : error),
      }).consumeStream();
    }
    assert.deepEqual(seen, [
      ["llm_rate_limited", { method: "model", code: 429, retryAfterSec: 20 }],
      ["llm_provider_error", { method: "model", code: "insufficient_quota", status: 429 }],
      ["llm_provider_error", { method: "model", code: 500 }],
    ]);
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

  it("medium serves all five, LLM_MODEL_DEFAULT first; none only gpt-6-sol and gpt-6-luna; another model is llm_input_invalid", async () => {
    const listed = async (options: Partial<OpenAIOptions>) =>
      (await llmOf(options).listModels()).map(({ modelId }) => modelId);
    assert.deepEqual(await listed({ effort: "medium" }), ALL_FIVE);
    const astra = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol"];
    assert.deepEqual(await listed({ effort: "medium", defaultModel: "gpt-6-astra" }), astra);
    assert.deepEqual(await listed({ effort: "none", defaultModel: "gpt-6-sol" }), [
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    const none = llmOf({ effort: "none", defaultModel: "gpt-6-luna" });
    for (const modelRef of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "claude-opus-5-5"]) {
      const refused = none.getModel({ modelRef, onUsage: () => {} });
      await assert.rejects(refused, withCode(llmPort.codes.input));
    }
    const other = llmOf().getModel({ modelRef: "claude-opus-5-5", onUsage: () => {} });
    await assert.rejects(other, withCode(llmPort.codes.input));
  });

  it("the model's provider id does not start with openai, since Mastra's own openai.strictJsonSchema is refused as any provider option", async () => {
    const model = await modelOf();
    assert.equal(model.provider, "whytide-openai.responses");
    // What Mastra adds to a structured call of a model whose provider id starts with "openai".
    const providerOptions = { openai: { strictJsonSchema: true } };
    const before = standIn.received.length;
    const refused = generateText({ model, prompt: "Say yes.", providerOptions });
    await assert.rejects(refused, withCode(llmPort.codes.input));
    assert.equal(standIn.received.length, before, "nothing sent");
  });
});

it("the base URL and the key come from code, never from OPENAI_* variables; no organization or project is sent", async (t) => {
  const decoys = {
    OPENAI_BASE_URL: "http://127.0.0.1:9/decoy",
    OPENAI_API_KEY: "decoy",
    OPENAI_ORGANIZATION: "org-decoy",
    OPENAI_PROJECT: "proj_decoy",
  };
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
    const headers = new Headers(init?.headers);
    const names = ["authorization", "openai-organization", "openai-project"];
    sent.push([String(input), ...names.map((name) => headers.get(name))]);
    const error = { message: "Incorrect API key.", type: "invalid_request_error", code: null };
    return Response.json({ error }, { status: 401 });
  });
  const { model } = await openaiLlm({ apiKey: KEY }).getModel({
    modelRef: "gpt-6.1-sol",
    onUsage: () => {},
  });
  await assert.rejects(generateText({ model, prompt: "hi" }), withCode("llm_invalid_key"));
  assert.deepEqual(sent, [["https://api.openai.com/v1/responses", `Bearer ${KEY}`, null, null]]);
});

it("create(): LLM_MODEL_DEFAULT first, no vendor error in production; an empty key, a model off the effort or an unknown effort refused", () => {
  // The configuration is read at import: a child process for each environment, its fetch stubbed.
  const [adapter, ai] = [import.meta.resolve("../index.ts"), import.meta.resolve("ai")];
  const script = [
    `const { openaiAdapter } = await import(${JSON.stringify(adapter)});`,
    `const { generateText } = await import(${JSON.stringify(ai)});`,
    'const error = { message: "Incorrect API key.", type: "invalid_request_error", code: null };',
    "globalThis.fetch = async () => Response.json({ error }, { status: 401 });",
    "try {",
    "  const llm = openaiAdapter.create();",
    "  const [first] = await llm.listModels();",
    "  const { model } = await llm.getModel({ modelRef: first.modelId, onUsage() {} });",
    '  const failed = await generateText({ model, prompt: "hi" }).catch((e) => e);',
    "  console.log(JSON.stringify([first.modelId, failed.code, failed.cause === undefined]));",
    "} catch (refused) {",
    "  console.log(JSON.stringify([refused.code, refused.details]));",
    "}",
  ].join("\n");
  const run = (env: Record<string, string>) => {
    const variables = { LLM_OPENAI_API_KEY: KEY, LLM_MODEL_DEFAULT: "", ...env };
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, LLM_OPENAI_REASONING_EFFORT: "", ...variables },
      encoding: "utf8",
    });
    assert.ok(ran.stdout, ran.stderr);
    return JSON.parse(ran.stdout);
  };
  const block = "packages/providers";
  const production = { APP_ENV: "production", LLM_MODEL_DEFAULT: "gpt-6-astra" };
  assert.deepEqual(run(production), ["gpt-6-astra", "llm_invalid_key", true]);
  const atNone = { LLM_OPENAI_REASONING_EFFORT: "none", LLM_MODEL_DEFAULT: "gpt-6-luna" };
  assert.deepEqual(run(atNone), ["gpt-6-luna", "llm_invalid_key", false]);
  const misconfigured = run({ LLM_OPENAI_API_KEY: "", LLM_MODEL_DEFAULT: "claude-opus-5-5" });
  const variables = [
    "LLM_OPENAI_API_KEY: required by the openai adapter",
    `LLM_MODEL_DEFAULT: one of ${ALL_FIVE.join(", ")} at LLM_OPENAI_REASONING_EFFORT=medium`,
  ];
  assert.deepEqual(misconfigured, ["config_invalid", { block, variables }]);
  // none with the default model, gpt-6.1-sol, which reasons at low or more.
  const offEffort = run({ LLM_OPENAI_REASONING_EFFORT: "none" });
  const atNoneOnly =
    "LLM_MODEL_DEFAULT: one of gpt-6-luna, gpt-6-sol at LLM_OPENAI_REASONING_EFFORT=none";
  assert.deepEqual(offEffort, ["config_invalid", { block, variables: [atNoneOnly] }]);
  const unknown = run({ LLM_OPENAI_REASONING_EFFORT: "maximum" });
  const efforts = `LLM_OPENAI_REASONING_EFFORT: one of ${EFFORTS.join(", ")}`;
  assert.deepEqual(unknown, ["config_invalid", { block, variables: [efforts] }]);
});

it("a module file importing @ai-sdk/openai fails the lint; this folder passes", () => {
  // The repository's vendor list over two files in a temporary workspace: a module's file and this
  // folder's, each importing the SDK, so that no file here imports it for the package's own lint.
  const repository = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");
  const imports = 'import { createOpenAI } from "@ai-sdk/openai";\nexport { createOpenAI };\n';
  const root = mkdtempSync(join(tmpdir(), "whytide-openai-lint-"));
  try {
    const files = {
      "pnpm-workspace.yaml": "",
      "tools/lint/vendor-sdks.json": readFileSync(join(repository, "tools/lint/vendor-sdks.json")),
      "core/modules/qualification/agents/assess.ts": imports,
      "core/packages/providers/llm/openai/index.ts": imports,
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
    const finding = String.raw`^core/modules/qualification/agents/assess\.ts:\d+:\d+ vendor-sdk-in-adapter-only @ai-sdk/openai is the SDK of the adapter in core/packages/providers/llm/openai/`;
    assert.match(lint.stdout, new RegExp(finding, "m"));
    assert.match(lint.stdout, /^1 problem in 1 file$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
