// A local stand-in for OpenAI's Responses API, for this folder's tests: POST /v1/responses on
// 127.0.0.1, each request's body and headers kept. The first user message says what to answer:
// - a key of FAILURES: OpenAI's error for it, with its status and headers;
// - `slow`: nothing;
// - `quota stream`, streamed: a stream that is accepted, then fails with insufficient_quota before
//   any output, as OpenAI does, which the SDK throws from doStream;
// - `error event`, streamed: a stream that starts, then fails with a server error event;
// - anything else: an answer of 12 input and 105 output tokens, 100 of them reasoning, generated or
//   streamed: after `json `, the rest of the message; else the object the contract's schema asks
//   for when the call sends a schema, else "yes".
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

type Part = { readonly type?: string; readonly text?: string };
/** The fields of a request body the tests read; the rest as sent. */
export type RequestBody = Readonly<Record<string, unknown>> & {
  readonly model: string;
  readonly input: readonly {
    readonly role?: string;
    readonly content?: string | readonly Part[];
  }[];
  readonly stream?: boolean;
  readonly text?: { readonly format?: { readonly type?: string; readonly strict?: boolean } };
};
export type Received = { readonly body: RequestBody; readonly headers: IncomingHttpHeaders };

type Failure = readonly [status: number, error: Record<string, unknown>, headers?: object];
const RATE_LIMIT = {
  message: "Rate limit reached.",
  type: "requests",
  code: "rate_limit_exceeded",
};
const QUOTA = {
  message: "You exceeded your current quota.",
  type: "insufficient_quota",
  code: "insufficient_quota",
};
/** OpenAI's error answers, by the prompt that asks for one. */
export const FAILURES: Readonly<Record<string, Failure>> = {
  "401": [
    401,
    { message: "Incorrect API key.", type: "invalid_request_error", code: "invalid_api_key" },
  ],
  "429": [429, RATE_LIMIT, { "retry-after": "20" }],
  "429 ms": [429, RATE_LIMIT, { "retry-after-ms": "1500" }],
  quota: [429, QUOTA],
  "500": [500, { message: "The server had an error.", type: "server_error", code: null }],
  "400": [
    400,
    { message: "Invalid schema.", type: "invalid_request_error", code: "invalid_json_schema" },
  ],
};
/** The answer's tokens: OpenAI counts the reasoning inside output_tokens. */
export const USAGE = {
  input_tokens: 12,
  output_tokens: 105,
  output_tokens_details: { reasoning_tokens: 100 },
};
const PARIS = { city: "Paris", country: "France" };
const CREATED = 1_767_225_600;

const firstUserText = ({ input }: RequestBody) => {
  const content = input.find(({ role }) => role === "user")?.content;
  return (Array.isArray(content) ? content[0]?.text : undefined) ?? "";
};

function answer(model: string, text: string) {
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed" };
  const content = [{ type: "output_text", text, annotations: [] }];
  return {
    id: "resp_1",
    created_at: CREATED,
    model,
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
      { ...message, content },
    ],
    usage: USAGE,
  };
}

function events(model: string, prompt: string, text: string): Record<string, unknown>[] {
  const response = { id: "resp_1", created_at: CREATED, model };
  const accepted = [
    { type: "response.created", sequence_number: 0, response },
    { type: "response.in_progress", sequence_number: 1, response },
  ];
  const failed = (code: string, message: string) => ({
    type: "error",
    sequence_number: 3,
    code,
    message,
    param: null,
  });
  if (prompt === "quota stream") return [...accepted, failed(QUOTA.code, QUOTA.message)];
  const item = { type: "message", id: "msg_1" };
  const started = [...accepted, { type: "response.output_item.added", output_index: 0, item }];
  if (prompt === "error event") return [...started, failed("server_error", "The server failed.")];
  return [
    ...started,
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { usage: USAGE } },
  ];
}

/** The stand-in, listening: its base URL, the requests it received, and close(). */
export async function startStandIn() {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as RequestBody;
    received.push({ body, headers: request.headers });
    const prompt = firstUserText(body);
    if (prompt === "slow") return;
    const failure = FAILURES[prompt];
    if (failure) {
      const [status, error, headers] = failure;
      response.writeHead(status, { "content-type": "application/json", ...headers });
      return void response.end(JSON.stringify({ error: { param: null, ...error } }));
    }
    const text = prompt.startsWith("json ")
      ? prompt.slice("json ".length)
      : body.text?.format?.type === "json_schema"
        ? JSON.stringify(PARIS)
        : "yes";
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      return void response.end(JSON.stringify(answer(body.model, text)));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const sse = events(body.model, prompt, text).map(
      (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    response.end(sse.join(""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    received,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
