// The URLs create() refuses (../README.md "Variables"): an http: URL off EGRESS_ALLOW_HOSTS, user
// info, a host on EGRESS_DENY_HOSTS, an empty variable and the egress rules' other refusals, each
// config_invalid naming ALERTS_WEBHOOK_URL and the rule, with nothing of the URL. Then the marker,
// planted in the URL's path and in every answer's body: a child host (marker-host.ts), whose
// telemetry exports to an OTLP receiver here, posts to a local channel and starts the adapter on the
// refused URLs; no line it wrote and no span, log record or metric it exported holds the marker. The
// platform reads the egress lists when it is imported, so they are set first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { type Answer, closedUrl, startChannel } from "./channel.ts";

/** Made up for the run, so that no string in the repository is what the test looks for. */
const MARKER = `marker${randomBytes(12).toString("hex")}`;
const DENIED = "denied.example.test";
process.env.EGRESS_ALLOW_HOSTS = "127.0.0.1";
process.env.EGRESS_DENY_HOSTS = DENIED;
const { isAppError } = await import("@whytide/platform");
const { webhookAdapter } = await import("../index.ts");

/** Each URL create() refuses, with its reason after the variable's name; the marker in every path. */
function refusals(path: string): (readonly [url: string, reason: string])[] {
  const egress = (code: string) => `refused by the egress rules, ${code}`;
  // User info set through URL, so that no URL with a password sits in the code.
  const withUser = new URL(`https://hooks.example.test${path}`);
  withUser.username = "ops";
  const withPassword = new URL(withUser);
  withPassword.password = MARKER;
  return [
    [`http://hooks.example.test${path}`, "https, or http to a host on EGRESS_ALLOW_HOSTS"],
    [withUser.href, egress("egress_credentials_in_url")],
    [withPassword.href, egress("egress_credentials_in_url")],
    [`https://${DENIED}${path}`, egress("egress_denied_host")],
    [`https://hooks.example.test:8443${path}`, egress("egress_port_not_allowed")],
    [`https://localhost${path}`, egress("egress_blocked_address")],
    [`hooks.example.test${path}`, egress("egress_invalid_url")],
    ["", "required by the webhook adapter"],
  ];
}

/** What create() threw on `url`, or undefined when it started; ALERTS_WEBHOOK_URL put back after. */
function startedOn(url: string): unknown {
  const saved = process.env.ALERTS_WEBHOOK_URL;
  process.env.ALERTS_WEBHOOK_URL = url;
  try {
    webhookAdapter.create();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (saved === undefined) delete process.env.ALERTS_WEBHOOK_URL;
    else process.env.ALERTS_WEBHOOK_URL = saved;
  }
}

test("create() refuses each URL with config_invalid naming ALERTS_WEBHOOK_URL and the rule, never the URL", () => {
  for (const [url, reason] of refusals(`/services/${MARKER}`)) {
    const error = startedOn(url);
    assert.ok(isAppError(error), `${reason}: ${String(error)}`);
    const variables = [`ALERTS_WEBHOOK_URL: ${reason}`];
    const details = { block: "packages/providers", variables };
    assert.deepEqual([error.code, error.details], ["config_invalid", details]);
    const seen = inspect(error, { depth: Number.POSITIVE_INFINITY, showHidden: true });
    assert.ok(!seen.includes(MARKER) && !seen.includes("example.test"), `${reason}: ${seen}`);
  }
});

test("create() takes https on any host, and http on a host of EGRESS_ALLOW_HOSTS", () => {
  const path = `/services/${MARKER}`;
  for (const url of [`https://hooks.example.test${path}`, `http://127.0.0.1:9${path}`]) {
    assert.equal(startedOn(url), undefined, url);
  }
});

type Export = { readonly url: string; readonly body: string };
type Traces = { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };

/** An OTLP receiver on 127.0.0.1 taking http/json: every export, as sent. */
async function startReceiver() {
  const received: Export[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

/** The marker host's run: its exit code, and all it wrote to stdout and stderr. */
async function runHost(env: Record<string, string>) {
  const host = fileURLToPath(new URL("./marker-host.ts", import.meta.url));
  const { OTEL_EXPORTER_OTLP_ENDPOINT: _endpoint, ...inherited } = process.env;
  const child = spawn(process.execPath, [host], {
    env: { ...inherited, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, output };
}

const spanNames = (received: readonly Export[]) =>
  received
    .filter((exported) => exported.url === "/v1/traces")
    .flatMap((exported) => (JSON.parse(exported.body) as Traces).resourceSpans)
    .flatMap(({ scopeSpans }) => scopeSpans.flatMap(({ spans }) => spans.map(({ name }) => name)));

test("the marker, in the URL's path and every answer's body, is in no line, error, span, log record or metric of a host's run", async () => {
  const path = `/services/${MARKER}`;
  const receiver = await startReceiver();
  const channel = await startChannel(path);
  try {
    const body = `{"ok":false,"error":"${MARKER}"}`;
    const answers: Answer[] = [
      { body: `ok ${MARKER}` },
      { status: 302, headers: { location: `${channel.origin}/${MARKER}` }, body },
      { status: 400, body },
      { status: 404, body },
      { status: 429, headers: { "retry-after": "30" }, body },
      { status: 500, body },
      { body: MARKER.repeat(1_000) }, // over 16 KiB
    ];
    for (const answer of answers) channel.answerNext(answer);
    const refused = refusals(path)
      .map(([url]) => url)
      .filter((url) => url !== "");
    const run = await runHost({
      ALERTS_WEBHOOK_URL: channel.url,
      EGRESS_ALLOW_HOSTS: "127.0.0.1",
      EGRESS_DENY_HOSTS: DENIED,
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      MARKER_SENDS: String(answers.length),
      MARKER_CLOSED_URL: await closedUrl(path),
      MARKER_REFUSED: JSON.stringify(refused),
    });
    assert.equal(run.code, 0, run.output);
    // Each answer was played at the marker's path; the 302's Location was not followed.
    assert.deepEqual(
      channel.requests.map((request) => request.path),
      answers.map(() => path),
    );
    // The capture holds the run: a span per call, every failure counted, logged and in the metric.
    const names = spanNames(receiver.received);
    assert.equal(names.filter((name) => name === "alerts.send").length, answers.length + 1);
    assert.equal(names.filter((name) => name === "alerts.start").length, refused.length + 2);
    const report = run.output.split("\n").find((line) => line.startsWith('{"failures":'));
    const failing = answers.filter(({ status }) => status !== undefined).length;
    assert.equal(JSON.parse(report ?? "{}").failures, failing + 1 + refused.length, run.output);
    const exported = (url: string, text: string) =>
      receiver.received.some((e) => e.url === url && e.body.includes(text));
    assert.ok(exported("/v1/logs", "alert failed"), "the failures' log records were exported");
    assert.ok(exported("/v1/metrics", "providers.calls"), "the calls' metric was exported");
    const seen = [run.output, ...receiver.received.map((e) => e.body)];
    assert.deepEqual(
      seen.filter((text) => text.includes(MARKER)),
      [],
    );
  } finally {
    await channel.close();
    await receiver.close();
  }
});
