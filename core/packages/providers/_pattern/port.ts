// A port in our words (docs/architecture.md §9 rule 1, docs/rules/coding.md §6): its methods as Zod
// input and output schemas and its error codes, `<port>_<reason>`. bindPort() is the boundary
// around an adapter's implementation: every call parses its input, and an error that is not one of
// the port's codes is wrapped as `<prefix>_error_unmapped`, so that no vendor payload reaches a log
// line (coding §9). Outside production the output is checked too (checkOutputs) and the vendor
// error kept as the cause (keepCause), so that a vendor object fails loudly with the method's name.
// Production keeps no cause, and passes outputs through unless the port is defined with
// alwaysCheckOutputs, as the LinkedIn port is. Every call is counted by its outcome (metrics.ts).
import { AppError, defineErrors, isAppError, platformConfig } from "@whytide/platform";
import type { z } from "zod";
import { ADAPTER_DECLARATIONS } from "./constants.ts";
import { patternErrors } from "./errors.ts";
import { FAKE_CONTROLS, isFake } from "./fake.ts";
import { providerMetrics } from "./metrics.ts";

export type MethodSchema = { readonly input: z.ZodType; readonly output: z.ZodType };
export type MethodSchemas = Record<string, MethodSchema>;
export type PortErrors = Record<string, { readonly status?: number }>;

export type PortDefinition<
  M extends MethodSchemas = MethodSchemas,
  E extends PortErrors = PortErrors,
> = {
  readonly name: string;
  readonly methods: M;
  /** The port's codes as themselves: `port.errors.llm_rate_limited`. */
  readonly errors: { readonly [K in keyof E & string]: K };
  /** `PROVIDER_<PORT>`, the variable that selects the adapter. */
  readonly variable: string;
  /** The codes bindPort() throws: an input off the schema, an output off it, an error off the list. */
  readonly codes: { readonly input: string; readonly output: string; readonly error: string };
  /** Every binding checks the outputs, in production too, whatever its BindOptions say. */
  readonly alwaysCheckOutputs: boolean;
};
export type AnyPort = PortDefinition<MethodSchemas, PortErrors>;
export type PortErrorCode<P extends AnyPort> = keyof P["errors"] & string;

/** What a caller sees: the methods, each taking the schema's input and returning its output. */
export type PortInstance<P extends AnyPort> = {
  readonly [K in keyof P["methods"]]: (
    input: z.input<P["methods"][K]["input"]>,
  ) => Promise<z.output<P["methods"][K]["output"]>>;
};
/** What an adapter provides: the same methods, given the parsed input. */
export type PortImplementation<P extends AnyPort> = {
  readonly [K in keyof P["methods"]]: (
    input: z.output<P["methods"][K]["input"]>,
  ) => Promise<z.output<P["methods"][K]["output"]>>;
};

export type BindOptions = {
  /** The adapter's name, for the errors. */
  readonly adapter: string;
  /**
   * Check every output against the method's schema; the default is every environment but
   * production. A port defined with `alwaysCheckOutputs` is checked whatever this says.
   */
  readonly checkOutputs?: boolean;
  /**
   * Keep a vendor error as the cause of `<prefix>_error_unmapped`; the default is every
   * environment but production.
   */
  readonly keepCause?: boolean;
};

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const METHOD = /^[a-z][A-Za-z0-9]*$/;
const ports = new Map<string, AnyPort>();

export function definePort<M extends MethodSchemas, E extends PortErrors>(definition: {
  name: string;
  methods: M;
  errors: E;
  /** The prefix of the codes when it is not the port's name: `mail` for `app_mail`. */
  errorPrefix?: string;
  /** Check the outputs in every environment, production included (README.md "The boundary"). */
  alwaysCheckOutputs?: boolean;
}): PortDefinition<M, E> {
  const { name, methods, errorPrefix = name, alwaysCheckOutputs = false } = definition;
  const invalid = (reason: string, extra: Record<string, unknown> = {}) =>
    new AppError(patternErrors.port_invalid, { details: { port: name, reason, ...extra } });
  if (!SNAKE.test(name)) throw invalid("the name is not snake_case");
  if (ports.has(name))
    throw new AppError(patternErrors.duplicate_port, { details: { port: name } });
  if (Object.keys(methods).length === 0) throw invalid("no methods");
  for (const method of Object.keys(methods)) {
    if (!METHOD.test(method)) throw invalid("a method is not a camelCase name", { method });
    if (FAKE_CONTROLS.includes(method))
      throw invalid("a method is named like a fake's control", { method });
    if (ADAPTER_DECLARATIONS.includes(method))
      throw invalid("a method is named like an adapter's declaration", { method });
  }
  for (const code of Object.keys(definition.errors)) {
    if (!code.startsWith(`${errorPrefix}_`))
      throw invalid("a code is not <port>_<reason>", { code });
  }
  const errors = defineErrors(definition.errors);
  const codes = {
    input: `${errorPrefix}_input_invalid`,
    output: `${errorPrefix}_output_invalid`,
    error: `${errorPrefix}_error_unmapped`,
  };
  defineErrors({
    [codes.input]: { status: 400 },
    [codes.output]: { status: 500 },
    [codes.error]: { status: 500 },
  });
  const port: PortDefinition<M, E> = Object.freeze({
    name,
    methods,
    errors,
    variable: `PROVIDER_${name.toUpperCase()}`,
    codes,
    alwaysCheckOutputs,
  });
  ports.set(name, port);
  return port;
}

export const registeredPorts = (): ReadonlyMap<string, AnyPort> => ports;

/** The adapter behind the port's boundary: the shape checked once, every call guarded. */
export function bindPort<P extends AnyPort>(
  port: P,
  implementation: PortImplementation<P>,
  options: BindOptions,
): PortInstance<P> {
  const given = implementation as Record<string, unknown>;
  const names = Object.keys(port.methods);
  const missing = names.filter((method) => typeof given[method] !== "function");
  const extra = isFake(given)
    ? []
    : Object.keys(given).filter((key) => !Object.hasOwn(port.methods, key));
  if (missing.length || extra.length) {
    throw new AppError(patternErrors.port_shape_mismatch, {
      details: { port: port.name, adapter: options.adapter, missing, extra },
    });
  }
  const outsideProduction = platformConfig.APP_ENV !== "production";
  const checkOutputs = port.alwaysCheckOutputs || (options.checkOutputs ?? outsideProduction);
  const keepCause = options.keepCause ?? outsideProduction;
  // The descriptors, not a spread: a fake's live `state` getter and its controls stay reachable.
  const bound = Object.defineProperties({}, Object.getOwnPropertyDescriptors(given));
  for (const method of names) {
    const schema = port.methods[method] as MethodSchema;
    const call = async (raw: unknown): Promise<unknown> => {
      const input = schema.input.safeParse(raw);
      if (!input.success) {
        throw new AppError(port.codes.input, {
          details: { method, issues: issuesOf(input.error) },
        });
      }
      let output: unknown;
      try {
        // Looked up on every call, so a fake may swap its methods on reset.
        output = await (given[method] as (input: unknown) => unknown).call(given, input.data);
      } catch (error) {
        if (isPortError(port, error)) throw error;
        // The vendor error itself travels only where a person reads it, never into a production log.
        throw new AppError(port.codes.error, {
          details: { method, code: vendorCode(error) },
          cause: keepCause ? error : undefined,
        });
      }
      if (checkOutputs) checkOutput(port, method, schema.output, output);
      return output;
    };
    const labels = { port: port.name, adapter: options.adapter, method };
    const counted = async (raw: unknown): Promise<unknown> => {
      try {
        const output = await call(raw);
        providerMetrics["providers.calls"].add(1, { ...labels, outcome: "ok" });
        return output;
      } catch (error) {
        const outcome = isAppError(error) ? error.code : port.codes.error;
        providerMetrics["providers.calls"].add(1, { ...labels, outcome });
        throw error;
      }
    };
    Object.defineProperty(bound, method, { value: counted, enumerable: true, writable: true });
  }
  return bound as PortInstance<P>;
}

function isPortError(port: AnyPort, error: unknown): boolean {
  return (
    isAppError(error) && (Object.hasOwn(port.errors, error.code) || error.code === port.codes.input)
  );
}

/** The vendor error's own `code`, `name` or `status` when it is a number or one short word; never its message. */
export function vendorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, name, status } = error as { code?: unknown; name?: unknown; status?: unknown };
  return [code, name, status].find(
    (value) => typeof value === "number" || (typeof value === "string" && /^\S{1,64}$/.test(value)),
  ) as string | number | undefined;
}

/** The output parses, and parsing changed nothing: a dropped key is a vendor's field, a changed value a transform. */
function checkOutput(port: AnyPort, method: string, schema: z.ZodType, output: unknown): void {
  const parsed = schema.safeParse(output);
  if (!parsed.success) {
    throw new AppError(port.codes.output, { details: { method, issues: issuesOf(parsed.error) } });
  }
  const mismatch = outputMismatch(output, parsed.data);
  if (mismatch) {
    throw new AppError(port.codes.output, {
      details: { method, path: mismatch.path, reason: mismatch.reason },
    });
  }
}

type Mismatch = { readonly path: string; readonly reason: string };
const UNDECLARED = "a field the port does not declare";
const TRANSFORMS = "the schema transforms";

/** Where `parsed` differs from `raw`; objects of any class and arrays are walked, their keys the vendor's fields. */
function outputMismatch(
  raw: unknown,
  parsed: unknown,
  at: readonly string[] = [],
): Mismatch | undefined {
  const found = (reason: string, path = at): Mismatch => ({ path: path.join(".") || ".", reason });
  if (Object.is(raw, parsed)) return undefined;
  if (typeof raw !== "object" || raw === null) return found(TRANSFORMS);
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return found(TRANSFORMS);
    for (const [index, item] of raw.entries()) {
      const inner = outputMismatch(item, parsed[index], [...at, String(index)]);
      if (inner) return inner;
    }
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    // A Map or a Set that Zod rebuilt keeps its prototype and is a leaf; anything else is a transform.
    const rebuilt =
      typeof parsed === "object" &&
      parsed !== null &&
      Object.getPrototypeOf(parsed) === Object.getPrototypeOf(raw);
    return rebuilt ? undefined : found(TRANSFORMS);
  }
  // A class instance, a vendor SDK's response, is walked like a plain object: its fields are own keys.
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key)) return found(UNDECLARED, [...at, key]);
    const inner = outputMismatch((raw as Record<string, unknown>)[key], parsed[key], [...at, key]);
    if (inner) return inner;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `path: message` per issue; Zod's messages name types and our own literals, never the value. */
function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "."}: ${issue.message}`);
}
