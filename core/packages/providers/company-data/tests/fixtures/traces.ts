// What a run of a vendor adapter leaves behind, for its mapping test's check that no key, token or
// input's value reaches an error, a log line, the console or a metric label: each call's error,
// logged as a host logs a refusal, the console mocked, the port's metric labels, for vendor.ts's
// leaked() to search whole. Unlike vendor.ts's failuresSeen(), a call may be any lookup: one held
// past its timeout, one to a port nothing listens on. That no source of the port's folder logs,
// prints or opens a span is ../contract.test.ts's check.
import type { TestContext } from "node:test";
import { collectLogs, createLogger, recordedMetrics } from "@whytide/platform";

/** The errors of `calls`, and everything the run wrote. */
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
    logger.error({ err: error }, "company lookup failed"); // as a host logs a refusal
  }
  const labels = (recordedMetrics().get("providers.calls") ?? []).filter(
    (label) => label.port === "company_data",
  );
  const seen = [errors, logs.raw, printed, labels];
  return { errors, seen, logged: logs.lines().length, counted: labels.length };
}
