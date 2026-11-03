// The fake pattern (docs/rules/coding.md §6 rule 4): an in-memory adapter the module tests and the
// Compose smoke test run on, written with the port, before the vendor adapter. createFake() wraps a
// port implementation so that every call is recorded, a failure can be injected for the next one,
// and the next call of a method can answer what a test gives, off the port's words if need be; the
// helpers are the port's own hooks for tests (seeding, reading what was sent). The fake validates
// nothing: bindPort() does, around it, as around any adapter.
import { AppError } from "@whytide/platform";
import { patternErrors } from "./errors.ts";
import type { AnyPort, PortErrorCode, PortImplementation } from "./port.ts";

export const FAKE: unique symbol = Symbol("whytide.fake");
/** The names a fake's controls take on it, which no port method may take. */
export const FAKE_CONTROLS: readonly string[] = [
  "recordedCalls",
  "failNext",
  "answerNext",
  "reset",
  "state",
  "record",
];

export type RecordedCall = { readonly method: string; readonly input: unknown };

export type FakeControls<P extends AnyPort> = {
  /** Every port call since the last reset, in order, with the parsed input, plus what record() added. */
  readonly recordedCalls: readonly RecordedCall[];
  /** Records a call the port does not see, under the name of the thing called. */
  record(method: string, input: unknown): void;
  /** The next call, whatever the method, throws this code; several calls queue up. */
  failNext(code: PortErrorCode<P>, details?: Record<string, unknown>): void;
  /**
   * The next call of `method` answers `answer` as given, or throws it when it is an Error: what a
   * vendor might send, so that a test reaches the boundary's generated codes. Answers queue up per
   * method; a pending failNext goes first.
   */
  answerNext(method: keyof P["methods"] & string, answer: unknown): void;
  /** Fresh state, no recorded calls, no pending failure or answer. */
  reset(): void;
};
export type FakeContext<P extends AnyPort, S> = FakeControls<P> & {
  /** The live state: read it on every call, never keep it. */
  readonly state: S;
};
export type FakeOptions<P extends AnyPort, S, H> = {
  /** A fresh in-memory state, built at creation and on every reset. */
  state: () => S;
  methods: (fake: FakeContext<P, S>) => PortImplementation<P>;
  helpers?: (fake: FakeContext<P, S>) => H;
};
export type Fake<P extends AnyPort, S, H> = PortImplementation<P> &
  FakeContext<P, S> &
  H & { readonly [FAKE]: true };

export function createFake<P extends AnyPort, S, H extends object = Record<never, never>>(
  port: P,
  options: FakeOptions<P, S, H>,
): Fake<P, S, H> {
  let state = options.state();
  const recordedCalls: RecordedCall[] = [];
  const failures: { code: string; details?: Record<string, unknown> }[] = [];
  const answers = new Map<string, unknown[]>();
  const invalid = (reason: string, details: Record<string, unknown>) =>
    new AppError(patternErrors.adapter_invalid, {
      details: { port: port.name, adapter: "fake", reason, ...details },
    });
  const context: FakeContext<P, S> = {
    recordedCalls,
    get state() {
      return state;
    },
    record: (method, input) => void recordedCalls.push({ method, input }),
    failNext(code, details) {
      if (!Object.hasOwn(port.errors, code)) {
        throw invalid("a code the port does not declare", { code });
      }
      failures.push({ code, details });
    },
    answerNext(method, answer) {
      if (!Object.hasOwn(port.methods, method)) {
        throw invalid("a method the port does not declare", { method });
      }
      const queued = answers.get(method) ?? [];
      queued.push(answer);
      answers.set(method, queued);
    },
    reset() {
      state = options.state();
      recordedCalls.length = 0;
      failures.length = 0;
      answers.clear();
    },
  };
  const methods = options.methods(context) as Record<string, (input: unknown) => Promise<unknown>>;
  const extra = Object.keys(methods).filter((method) => !Object.hasOwn(port.methods, method));
  if (extra.length) throw invalid("a method the port does not declare", { extra });
  const fake = Object.defineProperties(
    { [FAKE]: true, ...options.helpers?.(context) } as Record<string | symbol, unknown>,
    Object.getOwnPropertyDescriptors(context),
  );
  for (const [method, call] of Object.entries(methods)) {
    fake[method] = async (input: unknown) => {
      recordedCalls.push({ method, input });
      const failure = failures.shift();
      if (failure) throw new AppError(failure.code, { details: failure.details });
      const queued = answers.get(method);
      if (queued?.length) {
        const answer = queued.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return call.call(methods, input);
    };
  }
  return fake as Fake<P, S, H>;
}

export function isFake(value: unknown): value is FakeControls<AnyPort> {
  return (
    typeof value === "object" && value !== null && (value as { [FAKE]?: unknown })[FAKE] === true
  );
}
