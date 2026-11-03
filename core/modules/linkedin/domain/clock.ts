// The time the quotas, the action log and the receiver read, and the chance the quotas draw from
// (docs/concepts.md): the system's, or the ones a test sets through testing/ useClock and useRandom.
// Nothing else in the domain asks the system for the time, and nothing else draws a day's limits.
// Math.random is enough: the draw spaces volume, it guards no secret.
const system = () => new Date();
const systemRandom = () => Math.random();
let clock: () => Date = system;
let source: () => number = systemRandom;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

/** For tests (testing/): the numbers in [0, 1) to draw from instead of Math.random; undefined restores it. */
export function useRandom(next: (() => number) | undefined): void {
  source = next ?? systemRandom;
}

export const now = (): Date => clock();

/** A number in [0, 1), from Math.random or the test's source. */
export const random = (): number => source();
