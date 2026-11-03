// OpenTelemetry on every host (architecture §16; decisions §7): the Node SDK with the
// auto-instrumentations for HTTP, NestJS, pg, redis, ioredis and pino, exporting over OTLP only
// while OTEL_EXPORTER_OTLP_ENDPOINT is set. Without it a tracer provider still runs, so trace ids
// reach the logs, but there is no exporter, no reader, no processor: nothing connects anywhere.
// No span carries a URL's query, in either direction. No usage telemetry of any kind. A host starts
// this from a module it preloads (README "Telemetry").

import { createRequire } from "node:module";
import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  getNodeAutoInstrumentations,
  type InstrumentationConfigMap,
} from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK, type NodeSDKConfiguration, resources, tracing } from "@opentelemetry/sdk-node";
import { platformConfig } from "../config/platform.ts";
import { isAppError } from "../errors/index.ts";
import { isAllowedKey } from "../logging/schema.ts";

export type Telemetry = { readonly exporting: boolean; shutdown(): Promise<void> };
type SpanProcessor = NonNullable<NodeSDKConfiguration["spanProcessors"]>[number];
type Sampler = NodeSDKConfiguration["sampler"];

const ENABLED = ["http", "nestjs-core", "pg", "redis", "ioredis", "pino"];
/** The URL attributes a span may carry a query in, the stable ones and the older http.* ones. */
const URLS = ["url.full", "url.original", "http.url", "http.target"];
// Everything else the auto-instrumentations package bundles, off by name, so nothing is on by accident.
const DISABLED = [
  "amqplib",
  "aws-lambda",
  "aws-sdk",
  "bunyan",
  "cassandra-driver",
  "connect",
  "cucumber",
  "dataloader",
  "dns",
  "express",
  "fs",
  "generic-pool",
  "graphql",
  "grpc",
  "hapi",
  "host-metrics",
  "kafkajs",
  "knex",
  "koa",
  "lru-memoizer",
  "memcached",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "net",
  "openai",
  "oracledb",
  "restify",
  "router",
  "runtime-node",
  "socket.io",
  "tedious",
  "undici",
  "winston",
];
const KEEP_IDS_ONLY: SpanProcessor = {
  onStart() {},
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
let hooked = false;

/**
 * Registers the ESM loader hook the instrumentations need (OpenTelemetry's import-in-the-middle),
 * in this thread, before the instrumented modules load. pnpm keeps only direct dependencies next to
 * this package and the hook belongs to @opentelemetry/instrumentation, a dependency of the SDK, so
 * it is resolved from the SDK's own place.
 */
export function registerInstrumentationHook(): void {
  if (hooked) return;
  hooked = true;
  const fromSdk = createRequire(import.meta.resolve("@opentelemetry/sdk-node"));
  const fromInstrumentation = createRequire(
    fromSdk.resolve("@opentelemetry/instrumentation/package.json"),
  );
  const hooks = fromInstrumentation("import-in-the-middle/register-hooks.mjs") as {
    register(): void;
  };
  hooks.register();
}

export function startTelemetry({ serviceName }: { serviceName: string }): Telemetry {
  registerInstrumentationHook();
  const exporting = platformConfig.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined;
  const sdk = new NodeSDK({
    serviceName,
    autoDetectResources: false,
    resource: resources.resourceFromAttributes({
      "deployment.environment.name": platformConfig.APP_ENV,
    }),
    // Every span is recorded: a caller's traceparent that says "not sampled" cannot turn it off.
    sampler: withoutQueries(
      new tracing.ParentBasedSampler({
        root: new tracing.AlwaysOnSampler(),
        remoteParentNotSampled: new tracing.AlwaysOnSampler(),
      }),
    ),
    instrumentations: [getNodeAutoInstrumentations(instrumentationConfig())],
    ...(exporting
      ? {}
      : { spanProcessors: [KEEP_IDS_ONLY], logRecordProcessors: [], metricReaders: [] }),
  });
  sdk.start();
  return { exporting, shutdown: () => sdk.shutdown() };
}

/**
 * `inner`, taking the query off a span's URL as the span starts, whatever instrumentation set it: no
 * `url.query` (an inbound request's, a sign-in link's token), and each of URLS up to its path, before
 * any `?` or `#` (an outbound request's url.full, a vendor SDK's; NestJS's request span
 * `<Controller>.<handler>`, whose url.full is the inbound path and query). A sampler, since NodeSDK
 * takes span processors only in place of the exporters it builds from the environment, and the
 * tracer lays a sampler's attributes over the span's own.
 */
function withoutQueries(inner: Sampler): Sampler {
  return {
    shouldSample(context, traceId, name, kind, attributes, links) {
      const result = inner.shouldSample(context, traceId, name, kind, attributes, links);
      const queryless: Attributes = { "url.query": undefined }; // undefined unsets the attribute
      for (const key of URLS) {
        const url = attributes[key];
        if (typeof url === "string") queryless[key] = url.replace(/[?#].*$/s, "");
      }
      return { ...result, attributes: { ...result.attributes, ...queryless } };
    },
    toString: () => `WithoutQueries{${inner.toString()}}`,
  };
}

function instrumentationConfig(): InstrumentationConfigMap {
  const entries = [
    ...ENABLED.map((name) => [name, true]),
    ...DISABLED.map((name) => [name, false]),
  ];
  return Object.fromEntries(
    entries.map(([name, enabled]) => [`@opentelemetry/instrumentation-${name}`, { enabled }]),
  ) as InstrumentationConfigMap;
}

/** Runs `fn` inside a span with the allowed attributes; on a throw the status carries the code only. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  const options = { attributes: allowedAttributes(attributes) };
  return trace.getTracer("whytide").startActiveSpan(name, options, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      const code = isAppError(error) ? error.code : "error";
      span.setStatus({ code: SpanStatusCode.ERROR, message: code });
      span.setAttribute("code", code);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The attributes a span may carry: the log schema's keys, with primitive values or lists of strings. */
export function allowedAttributes(attributes: Record<string, unknown>): Attributes {
  const allowed: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isAllowedKey(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      allowed[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      allowed[key] = value as string[];
    }
  }
  return allowed;
}

export * from "./metrics.ts";
