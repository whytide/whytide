// The time the plan reads and the chance its times are drawn from (README.md "Testing"): the
// system's, or the ones a test sets through testing/ useClock and useRandom, as linkedin's
// domain/clock.ts. Math.random is enough: the draw spaces the actions, it guards no secret.
const system = () => new Date();
const systemRandom = () => Math.random();
let clock: () => Date = system;
let source: () => number = systemRandom;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

/** For tests (testing/): the numbers in [0, 1) to draw from; undefined restores Math.random. */
export function useRandom(next: (() => number) | undefined): void {
  source = next ?? systemRandom;
}

export const now = (): Date => clock();

/** A number in [0, 1), from Math.random or the test's source. */
export const random = (): number => source();
