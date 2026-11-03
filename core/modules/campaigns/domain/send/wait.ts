// The wait between a profile read and the connection request it is for (docs/flows.md "The read
// before an invite"; beta-p4-030): MIN_MINUTES_AFTER_PROFILE_READ, or, under APP_ENV=test only, the
// one a test sets through testing/ useProfileReadWait, so that a worker test does not wait 3 minutes.
// Any other environment refuses it (not in the sources).
import { platformConfig } from "@whytide/platform";
import { MS_PER_MINUTE } from "../constants.ts";
import { MIN_MINUTES_AFTER_PROFILE_READ } from "./constants.ts";

let shortened: number | undefined;

/** For tests (testing/): the wait in ms instead of the 3 minutes; undefined restores them. */
export function useProfileReadWait(ms: number | undefined): void {
  if (platformConfig.APP_ENV !== "test") {
    throw new Error("useProfileReadWait: only under APP_ENV=test");
  }
  shortened = ms;
}

/** The wait after a profile read, in ms. */
export const profileReadWaitMs = (): number =>
  shortened ?? MIN_MINUTES_AFTER_PROFILE_READ * MS_PER_MINUTE;
