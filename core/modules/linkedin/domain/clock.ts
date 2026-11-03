// The time the read quota and the action log read (docs/concepts.md): the system's, or the one a test
// sets through testing/ useClock. Nothing else in the domain asks the system for the time.
const system = () => new Date();
let clock: () => Date = system;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

export const now = (): Date => clock();
