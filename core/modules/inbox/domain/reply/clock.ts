// The time a reply's settle and its route read (README.md "Testing"): the system's, or the one a test
// sets through testing/ useReplyClock, as linkedin's domain/clock.ts, whose retry_at the settle's
// wait is measured against.
const system = () => new Date();
let clock: () => Date = system;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

export const now = (): Date => clock();
