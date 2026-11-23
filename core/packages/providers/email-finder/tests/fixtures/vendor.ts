// A vendor on 127.0.0.1 for the email-finder adapters' mapping tests (../../README.md "Adapters"):
// company-data's recording server (company-data/tests/fixtures/vendor.ts), and what every finder's
// tests share: the contract's offline world on such a vendor, the pattern's redirect, bound and
// timeout with the finder's code, and what a run leaves behind for leaked() to search. Nothing here
// reaches past 127.0.0.1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { collectLogs, createLogger, isAppError, recordedMetrics } from "@whytide/platform";
import type { Answer, Vendor } from "../../../company-data/tests/fixtures/vendor.ts";
import type { EmailFinderFailure, OfflineWorld, WorldPerson } from "../../contract.ts";
import type { FindEmailInput } from "../../port.ts";

export {
  type Answer,
  closedOrigin,
  leaked,
  type Received,
  startVendor,
  type Vendor,
} from "../../../company-data/tests/fixtures/vendor.ts";

/**
 * The contract's offline world on a vendor: its person found without and with the vendor's check,
 * an unknown one, the vendor's answer for each code, its calls. `calls` counts the requests that
 * reach the vendor by default; snov's counts its finder calls only, its token call aside.
 */
export const vendorWorld = (
  vendor: Vendor,
  people: { readonly person: WorldPerson; readonly checked: WorldPerson },
  unknown: FindEmailInput,
  failures: Readonly<Record<EmailFinderFailure, Answer | readonly Answer[]>>,
  calls: () => number = () => vendor.requests.length,
): OfflineWorld => ({
  live: false,
  person: () => people.person,
  checked: () => people.checked,
  unknown: () => unknown,
  failNext: (code) => {
    const answers = failures[code];
    for (const answer of Array.isArray(answers) ? answers : [answers]) vendor.answerNext(answer);
  },
  calls,
});

export const failsWith = (code: string, details: Record<string, unknown>) => (caught: unknown) => {
  assert.ok(isAppError(caught), String(caught));
  assert.deepEqual([caught.code, caught.details], [code, details]);
  return true;
};

/**
 * The pattern every finder keeps, on `lookup()`'s first request: a redirect never followed, an
 * answer past `maxBytes` never read whole, no answer within `timeoutMs` given up; each one
 * finder_provider_error with its reason. The adapter's timer, asked for `timeoutMs`, fires after
 * 50 ms here.
 */
export async function checkPattern(
  t: TestContext,
  vendor: Vendor,
  lookup: () => Promise<unknown>,
  { maxBytes, timeoutMs }: { readonly maxBytes: number; readonly timeoutMs: number },
): Promise<void> {
  const first = vendor.requests.length;
  vendor.answerNext({ status: 302, headers: { location: `${vendor.origin}/followed` } });
  const redirect = failsWith("finder_provider_error", { status: 302, reason: "redirect" });
  await assert.rejects(lookup(), redirect);
  assert.equal(vendor.requests.length - first, 1, "the redirect not followed");
  vendor.answerNext({ body: "x".repeat(maxBytes + 1) });
  const tooLarge = failsWith("finder_provider_error", { status: 200, reason: "answer_too_large" });
  await assert.rejects(lookup(), tooLarge);
  const asked: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    asked.push(ms);
    return timeout(50);
  });
  vendor.answerNext({ silent: true });
  await assert.rejects(lookup(), failsWith("finder_provider_error", { reason: "timeout" }));
  assert.deepEqual(asked, [timeoutMs]);
  t.mock.restoreAll();
}

/** The errors of `calls`, each logged as a host logs a refusal, and everything the run wrote. */
export async function traces(t: TestContext, calls: readonly (() => Promise<unknown>)[]) {
  const logs = collectLogs();
  const host = createLogger({ destination: logs.destination });
  const printed: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => void printed.push(args));
  }
  const errors: unknown[] = [];
  for (const call of calls) {
    const error = await call().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (error === undefined) continue;
    errors.push(error);
    host.error({ err: error }, "address lookup failed");
  }
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (label) => label.port === "email_finder",
  );
  const seen = [errors, logs.raw, printed, labels];
  return { errors, seen, logged: logs.lines().length, counted: labels.length };
}

/**
 * The finder `name` taken from the registry as a host takes it, in a child process with `env` added
 * and `<allowanceVariable>` empty unless `env` sets it: its allowance as JSON, or the code it fails with.
 */
export async function allowanceAtStart(
  name: string,
  allowanceVariable: string,
  env: Record<string, string>,
): Promise<string> {
  const script = [
    "try {",
    `  const { getAdapters } = await import(${JSON.stringify(import.meta.resolve("../../../registry.ts"))});`,
    `  const { emailFinderPort } = await import(${JSON.stringify(import.meta.resolve("../../port.ts"))});`,
    `  const [finder] = await getAdapters(emailFinderPort, [${JSON.stringify(name)}]);`,
    "  console.log(JSON.stringify(finder.allowance));",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...process.env, APP_ENV: "test", [allowanceVariable]: "", ...env } },
  );
  return stdout.trim();
}
