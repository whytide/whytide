// The boundary of a model call (llm/boundary.ts), port-level: a vendor's model whose stream fails,
// after some text with an error part or by failing, or before any part, reaches a caller of `ai` as
// llm_error_unmapped with { method, code } only. The prompt, which the vendor error carries in its
// requestBodyValues, stays in the cause, which keepCause keeps or drops. The fake cannot fail this
// way, so a vendor-like model stands in; `pnpm -F providers test:contract` runs this file.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { isAppError } from "@whytide/platform";
import { NoOutputGeneratedError, streamText } from "ai";
import { bindModel } from "../boundary.ts";
import { llmPort } from "../port.ts";

const PROMPT = "Score the lead in the <lead> block. <lead>Ada Lovelace, VP Sales</lead>";
const LEAK = /Ada Lovelace|requestBodyValues|Overloaded/;
/** What a caller may log of an error: its message, its stack and its own fields. */
const shown = (error: unknown) => {
  const { message, stack } = error as Error;
  return JSON.stringify({ ...(error as object), message, stack });
};
type Shape = "error part" | "thrown" | "rejected";
/** Where a caller of streamText meets each failure; after a rejection, text fails with ai's own error. */
const REACHES = {
  "error part": ["fullStream", "onError"],
  thrown: ["fullStream", "text"],
  rejected: ["fullStream", "onError"],
} as const;

/** A vendor's model whose stream sends some text, then fails as a part or thrown, or never starts. */
function failingStream(failure: APICallError, as: Shape): LanguageModelV4 {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "The lead" },
  ];
  if (as === "error part") parts.push({ type: "error", error: failure });
  return {
    specificationVersion: "v4",
    provider: "vendor",
    modelId: "vendor-model",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("not used")),
    doStream: async () => {
      if (as === "rejected") throw failure;
      let sent = 0;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        // One part a read, so that the failure comes after the text has gone out.
        pull(controller) {
          const part = parts[sent++];
          if (part) controller.enqueue(part);
          else if (as === "thrown") controller.error(failure);
          else controller.close();
        },
      });
      return { stream };
    },
  };
}

for (const as of ["error part", "thrown", "rejected"] as const) {
  for (const keepCause of [true, false]) {
    test(`a stream failing, ${as}, keepCause ${keepCause}: llm_error_unmapped, no prompt`, async () => {
      const failure = new APICallError({
        message: "Overloaded",
        url: "https://api.vendor.example/v1/messages",
        statusCode: 529,
        requestBodyValues: { messages: [{ role: "user", content: PROMPT }] },
      });
      // Everything a caller of streamText sees: onError, fullStream's error parts or failure, text.
      const seen: [string, unknown][] = [];
      const model = bindModel(failingStream(failure, as), () => {}, { keepCause });
      const onError = ({ error }: { error: unknown }) => void seen.push(["onError", error]);
      const result = streamText({ model, prompt: PROMPT, onError });
      try {
        for await (const part of result.fullStream)
          if (part.type === "error") seen.push(["fullStream", part.error]);
      } catch (error) {
        seen.push(["fullStream", error]);
      }
      const text = await Promise.resolve(result.text).catch((error: unknown) => error);
      if (as === "rejected")
        assert.ok(NoOutputGeneratedError.isInstance(text) && !LEAK.test(shown(text)));
      else if (text instanceof Error) seen.push(["text", text]);
      assert.deepEqual(seen.map(([where]) => where).sort(), REACHES[as]);
      for (const [, error] of seen) {
        assert.ok(isAppError(error), "an AppError");
        assert.equal(error.code, llmPort.codes.error);
        assert.deepEqual(error.details, { method: "model", code: 529 });
        assert.doesNotMatch(shown(error), LEAK);
        assert.equal(error.cause, keepCause ? failure : undefined);
      }
    });
  }
}
