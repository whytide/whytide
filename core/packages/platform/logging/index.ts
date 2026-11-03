// JSON logs through pino (docs/rules/coding.md §9; architecture §16): the active span's ids on every
// line, the workspace and the actor while a context is set, the PII registry's keys and suffixes
// redacted at any depth, and never a binary value, so no key and no secret blob or plaintext goes out
// as bytes; an error, at any depth, as its type and code, never the message of one that is not an
// AppError (whose message is its code). A line carries ids, counts and durations; the log-schema
// check in schema.ts is the proof.
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import pino from "pino";
import { platformConfig } from "../config/platform.ts";
import { isAppError } from "../errors/index.ts";
import { piiKeySuffixes, piiKeys } from "./pii.ts";

export type Logger = pino.Logger;
export type LogContext = { readonly workspace_id?: string; readonly actor?: string };
/** pino's generic `child`, as the one concrete call this file makes of it. */
type ChildFn = (this: Logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => Logger;
export type LoggerOptions = {
  level?: pino.Level;
  destination?: pino.DestinationStream;
  /** More keys to redact, on top of the PII registry's. */
  redact?: readonly string[];
};

const context = new AsyncLocalStorage<LogContext>();
const DEPTHS = ["", "*.", "*.*.", "*.*.*."];
/** The deepest level of a key the redaction paths cover; below it a line is walked for errors only. */
const FLOOR = DEPTHS.length - 1;
/** The deepest level of a key that may hold an object; deeper, the object is TOO_DEEP (fail closed). */
const MAX_DEPTH = 8;
const CENSOR = "[redacted]";
const TOO_DEEP = "[too deep]";
const CIRCULAR = "[circular]";
/** pino's error key: the one top-level Error instance the serializer turns into its fields. */
const ERROR_KEY = "err";
/** How many causes deep a line follows an error, and how many of an AggregateError's errors it lists. */
const CAUSES = 3;
const LISTED = 10;

/** Runs `fn` with a workspace and an actor on every line it logs, on this async path only. */
export function withLogContext<T>(value: LogContext, fn: () => T): T {
  return context.run(value, fn);
}

/** The redaction paths: every key at the top level and up to three levels down, arrays included. */
export function redactionPaths(keys: readonly string[] = piiKeys): string[] {
  return keys.flatMap((key) => DEPTHS.map((depth) => `${depth}${key}`));
}

export function createLogger({
  level = platformConfig.LOG_LEVEL,
  destination,
  redact = [],
}: LoggerOptions = {}): Logger {
  const options: pino.LoggerOptions = {
    level,
    formatters: { level: (label) => ({ level: label }), log: (object) => redactValues(object) },
    // Not pino's own, which appends the causes' messages and stacks and copies every field.
    serializers: { [ERROR_KEY]: serializeError },
    // pino copies an error's message into msg when the call gives none, and spreads an error from
    // another realm (node:vm) as fields: withHeadline puts it under err and gives its headline.
    hooks: {
      logMethod(args, method) {
        method.apply(this, withHeadline(args) as Parameters<pino.LogFn>);
      },
    },
    mixin: () => ({ ...spanIds(), ...context.getStore() }),
    // A Buffer logged as the object itself would spread its bytes as numbered keys.
    mixinMergeStrategy: (merged, mixin) =>
      Object.assign(mixin, isBinary(merged) ? { binary: CENSOR } : merged),
    redact: { paths: redactionPaths([...piiKeys, ...redact]), censor: CENSOR },
  };
  const logger = destination ? pino(options, destination) : pino(options);
  // pino applies formatters.bindings to the root's own bindings only (pid, hostname), so a child's
  // bindings are walked here, and the ones setBindings adds; children inherit both overrides, so a
  // grandchild's are too.
  const inherited = logger.child as unknown as ChildFn;
  logger.child = function child(this: Logger, bindings, childOptions) {
    return inherited.call(this, redactValues(bindings), childOptions);
  } as ChildFn as unknown as Logger["child"];
  const inheritedSet = logger.setBindings;
  logger.setBindings = function setBindings(this: Logger, bindings: pino.Bindings) {
    inheritedSet.call(this, redactValues(bindings));
  };
  return logger;
}

/**
 * The object with every binary value (a Buffer, a typed array) and every value under a key ending in
 * a PII suffix replaced by the censor, at the depths the redaction paths cover, arrays included.
 * Every object is walked into a plain copy of its own fields, a class instance among them, except a
 * value with its own `toJSON` (a Date, a URL), kept for the shape it chooses, a nested error, copied
 * as errorFields says, and the Error under the top-level `err`, kept for the serializer
 * (serializeError), whose output is walked instead. Below the paths' depth a value is walked for
 * errors only (errorsOnly), and a cycle is written as CIRCULAR.
 */
export function redactValues(
  object: Record<string, unknown>,
  suffixes: readonly string[] = piiKeySuffixes,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  const path = new Set<object>();
  for (const [key, value] of Object.entries(object)) {
    copy[key] =
      key === ERROR_KEY && isError(value) ? value : redactValue(key, value, suffixes, 0, path);
  }
  return copy;
}

/** `depth` is the level of `key`, 0 at the top; `path` holds the objects above, to cut a cycle. */
function redactValue(
  key: string | undefined,
  value: unknown,
  suffixes: readonly string[],
  depth: number,
  path: Set<object>,
): unknown {
  if (isBinary(value)) return CENSOR;
  if (key !== undefined && suffixes.some((s) => key.length > s.length && key.endsWith(s))) {
    return CENSOR;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= FLOOR) return errorsOnly(value, depth, path);
  const each = (v: unknown, k: string | undefined) => redactValue(k, v, suffixes, depth + 1, path);
  // An error is reduced first: some error classes define a toJSON that returns their payload.
  if (isError(value)) return copyOf(errorFields(value, false), path, each);
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
  return copyOf(value, path, each);
}

/**
 * Below the paths' depth: the value as it is, but every error in it, at any depth, as its brief and
 * every binary value censored; an object held deeper than MAX_DEPTH is TOO_DEEP, unread.
 */
function errorsOnly(value: unknown, depth: number, path: Set<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isError(value)) return briefOf(value, 1);
  if (isBinary(value)) return CENSOR;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
  return copyOf(value, path, (v) => errorsOnly(v, depth + 1, path));
}

/** A plain copy of an array's items or an object's own fields, each through `each`. */
function copyOf(
  value: object,
  path: Set<object>,
  each: (value: unknown, key: string | undefined) => unknown,
): unknown {
  if (path.has(value)) return CIRCULAR;
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => each(item, undefined));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, each(v, k)]));
  } finally {
    path.delete(value);
  }
}

/** The top-level `err`: errorFields with the top's message or frames, walked like the rest of the line. */
function serializeError(value: unknown): unknown {
  if (!isError(value)) return value;
  return redactValue(ERROR_KEY, errorFields(value, true), piiKeySuffixes, 0, new Set());
}

/**
 * What a line keeps of an error: its type, its code and status (a string or a number), an AppError's
 * details, its cause as its brief, CAUSES deep, and an AggregateError's errors as theirs, LISTED at
 * most; never another field, nor its toJSON. At the top an AppError adds its message (its code) and
 * stack; any other error only its stack's frames, never its message: a vendor's or Prisma's quotes
 * what the call was given. A read that throws (a getter) leaves `{ type }`, since a line is usually
 * written inside a catch.
 */
function errorFields(error: Error, top: boolean): Record<string, unknown> {
  try {
    const own = error as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = { type: typeOf(error) };
    if (top && keepsMessage(error)) {
      fields.message = error.message;
      fields.stack = error.stack;
    } else if (top) {
      fields.stack = framesOf(error.stack, error.message);
    }
    for (const field of ["code", "status"]) {
      if (Object.hasOwn(error, field) && isScalar(own[field])) fields[field] = own[field];
    }
    if (isAppError(error) && error.details !== undefined) fields.details = error.details;
    if (isError(error.cause)) fields.cause = briefOf(error.cause, CAUSES);
    const aggregate = error instanceof AggregateError || typeOf(error) === "AggregateError";
    const errors = aggregate ? own.errors : undefined;
    if (Array.isArray(errors)) {
      fields.errors = errors
        .slice(0, LISTED)
        .filter(isError)
        .map((item) => briefOf(item, 1));
    }
    return fields;
  } catch {
    return { type: typeOf(error) };
  }
}

/** An error as its type and code (a string or a number), its cause the same way, `levels` deep. */
function briefOf(error: Error, levels: number): Record<string, unknown> {
  try {
    const { code } = error as { code?: unknown };
    const cause = levels > 1 && isError(error.cause) ? briefOf(error.cause, levels - 1) : undefined;
    return {
      type: typeOf(error),
      ...(isScalar(code) ? { code } : {}),
      ...(cause ? { cause } : {}),
    };
  } catch {
    return { type: typeOf(error) };
  }
}

/** An AppError whose message is still its code: the one error a line writes the message of. */
function keepsMessage(error: Error): boolean {
  return isAppError(error) && error.message === error.code;
}

/**
 * A stack's frames, its `    at ` lines, once the message's own lines are dropped: V8 writes the
 * message into the stack unescaped, and a line of it can look like a frame.
 */
function framesOf(stack: unknown, message: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const lines = stack.split("\n").slice(String(message ?? "").split("\n").length);
  const frames = lines.filter((line) => line.startsWith("    at "));
  return frames.length > 0 ? frames.join("\n") : undefined;
}

/**
 * A log call's arguments with an error given first put under `err`, as pino does with one from its
 * own realm (one from another it would spread as fields), and, when the call gives no message, the
 * error's headline as msg in place of the message pino would copy, unless the error keeps it.
 */
function withHeadline(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  const line = isError(first) ? { [ERROR_KEY]: first } : first;
  if (rest[0] === undefined && line !== null && typeof line === "object") {
    const { [ERROR_KEY]: error, msg } = line as Record<string, unknown>;
    if (msg === undefined && isError(error) && !keepsMessage(error)) rest[0] = headlineOf(error);
  }
  return [line, ...rest];
}

/** An error's type and code: the msg of a line about an error that is not an AppError. */
function headlineOf(error: Error): string {
  const { type, code } = briefOf(error, 1);
  return code === undefined ? String(type) : `${type} ${code}`;
}

/** An Error, from this realm or another (node:vm), which `instanceof` alone misses. */
function isError(value: unknown): value is Error {
  return types.isNativeError(value) || value instanceof Error;
}

function isScalar(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** The error's class, as pino names it: the constructor's name, else `name`; Error if neither reads. */
function typeOf(error: Error): string {
  try {
    const type = error.constructor?.name || error.name;
    return typeof type === "string" && type !== "" ? type : "Error";
  } catch {
    return "Error";
  }
}

function isBinary(value: unknown): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function spanIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan()?.spanContext();
  return span && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {};
}

export { piiKeySuffixes, piiKeys } from "./pii.ts";
export { checkLogLines, isAllowedKey, type LogSchema, logSchema } from "./schema.ts";
