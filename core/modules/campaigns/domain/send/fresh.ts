// How long the gate's pass right before the call holds (constants.ts GATE_FRESH_MS): the sender's
// gate activity answers with it, and the workflow asks the gate again once its pass is older when
// the call is scheduled. The constant, or, under APP_ENV=test only, the time a test sets through
// testing/ useGateFreshMs: the tests' Temporal has no time skipping, so a test cannot age a pass by
// a minute. Any other environment refuses it, as useProfileReadWait (wait.ts) is refused.
import { platformConfig } from "@whytide/platform";
import { GATE_FRESH_MS } from "./constants.ts";

let freshMs = GATE_FRESH_MS;

/** For tests (testing/): how long a gate's pass holds; undefined restores GATE_FRESH_MS. */
export function useGateFreshMs(ms: number | undefined): void {
  if (platformConfig.APP_ENV !== "test") throw new Error("useGateFreshMs: only under APP_ENV=test");
  freshMs = ms ?? GATE_FRESH_MS;
}

export const gateFreshMs = (): number => freshMs;
