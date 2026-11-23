// The fake as the contract's team channel (../../contract.ts): what it was sent, the calls it saw, and
// its next failure through failNext, a rate limit with the contract's seconds.
import { type AlertsChannel, RETRY_AFTER_SEC } from "../../contract.ts";
import type { AlertsFake } from "../index.ts";

export const fakeChannel = (fake: AlertsFake): AlertsChannel => ({
  received: () => fake.sent(),
  calls: () => fake.recordedCalls.length,
  failNext: (code) =>
    fake.failNext(
      code,
      code === "alerts_rate_limited" ? { retryAfterSec: RETRY_AFTER_SEC } : undefined,
    ),
});
