// A vendor on 127.0.0.1 for the email-verifier adapters' mapping tests (../../README.md "Adapters"):
// company-data's recording server (startVendor), its refused port, its leak check and its child
// process start, which know nothing of a port, and what the verifiers' tests share: the contract's
// offline world on such a vendor, answering each address of fake/tests/world.ts's addressWith() with
// its verdict's answer; the vendor's verdict rows checked in turn; the pattern's redirect, bound and
// timeout as this port's codes; and everything a run leaves behind. Nothing here reaches past 127.0.0.1.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { collectLogs, createLogger, isAppError, recordedMetrics } from "@whytide/platform";
import type { Answer, Vendor } from "../../../company-data/tests/fixtures/vendor.ts";
import { EMAIL_VERDICTS } from "../../constants.ts";
import type { EmailVerifierFailure, OfflineWorld } from "../../contract.ts";
import { addressWith } from "../../fake/tests/world.ts";
import type { EmailVerdict, VerifyEmailResult } from "../../port.ts";

export {
  type Answer,
  closedOrigin,
  leaked,
  type Received,
  startedIn,
  startVendor,
  type Vendor,
} from "../../../company-data/tests/fixtures/vendor.ts";
export { addressWith };

/** The verdict whose address of addressWith() `address` is; undefined for any other. */
export function verdictOfAddress(address: unknown): EmailVerdict | undefined {
  return EMAIL_VERDICTS.find((verdict) => addressWith(verdict) === address);
}

/** The contract's offline world on a vendor that answers each addressWith() address its verdict. */
export const vendorWorld = (
  vendor: Vendor,
  failures: Readonly<Record<EmailVerifierFailure, Answer>>,
): OfflineWorld => ({
  live: false,
  address: (verdict) => addressWith(verdict),
  failNext: (code) => vendor.answerNext(failures[code]),
  calls: () => vendor.requests.length,
});

type Verifier = {
  readonly verifyEmail: (input: { address: string }) => Promise<VerifyEmailResult>;
};

/** Each row's answer, served next, is its verdict: the README's mapping table. */
export async function assertVerdicts(
  verifier: Verifier,
  vendor: Vendor,
  rows: readonly (readonly [label: string, answer: Answer, verdict: EmailVerdict])[],
): Promise<void> {
  for (const [label, answer, verdict] of rows) {
    vendor.answerNext(answer);
    const result = await verifier.verifyEmail({ address: addressWith("valid") });
    assert.equal(result.verdict, verdict, label);
  }
}

/** The error is `code` with exactly `details`. */
export const failsWith = (code: string, details: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, error.details], [code, details]);
  return true;
};

/**
 * The pattern every adapter keeps, on `call()`'s first request: a redirect never followed, an answer
 * past `maxBytes` never read whole, no answer within `timeoutMs` given up; each one
 * verifier_provider_error with its reason. The adapter's timer, asked for `timeoutMs`, fires after
 * 50 ms here.
 */
export async function checkPattern(
  t: TestContext,
  vendor: Vendor,
  call: () => Promise<unknown>,
  { maxBytes, timeoutMs }: { readonly maxBytes: number; readonly timeoutMs: number },
): Promise<void> {
  const error = (details: Record<string, unknown>) => failsWith("verifier_provider_error", details);
  const first = vendor.requests.length;
  vendor.answerNext({ status: 302, headers: { location: `${vendor.origin}/followed` } });
  await assert.rejects(call(), error({ status: 302, reason: "redirect" }));
  assert.equal(vendor.requests.length - first, 1, "the redirect not followed");
  vendor.answerNext({ body: "x".repeat(maxBytes + 1) });
  await assert.rejects(call(), error({ status: 200, reason: "answer_too_large" }));
  const asked: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    asked.push(ms);
    return timeout(50);
  });
  vendor.answerNext({ silent: true });
  await assert.rejects(call(), error({ reason: "timeout" }));
  assert.deepEqual(asked, [timeoutMs]);
}

/**
 * The errors of `calls`, each logged as a host logs a refusal, the console mocked, and the port's
 * metric labels: everything the run wrote, for leaked() to search whole.
 */
export async function traces(t: TestContext, calls: readonly (() => Promise<unknown>)[]) {
  const logs = collectLogs();
  const logger = createLogger({ destination: logs.destination });
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
    logger.error({ err: error }, "address check refused"); // as a host logs a refusal
  }
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (label) => label.port === "email_verifier",
  );
  const seen = [errors, logs.raw, printed, labels];
  return { errors, seen, logged: logs.lines().length, counted: labels.length };
}
