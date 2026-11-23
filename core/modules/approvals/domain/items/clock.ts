// The time "Up next" is read at (README.md "Testing"; queue.ts): the system's, or the one a test sets
// through testing/ useQueueClock, as linkedin's domain/clock.ts, so that a test of the flags and of
// "decided today" holds at any hour, a minute before midnight UTC included (gamma-p6-050).
const system = () => new Date();
let clock: () => Date = system;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

export const now = (): Date => clock();
