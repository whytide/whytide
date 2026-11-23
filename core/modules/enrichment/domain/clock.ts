// The time the module reads (docs/concepts.md): the system's, or the one a test sets through
// testing/ useClock. A run's times, the counters' periods and the retry days read it.
const system = () => new Date();
let clock: () => Date = system;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

export const now = (): Date => clock();
