// The time and the random bytes the module reads (docs/concepts.md): the system's, or the ones a test
// sets through testing/ useClock and useRandom. Nothing else in the module asks for either.
import { randomBytes } from "node:crypto";

const system = () => new Date();
let clock: () => Date = system;
let source: (size: number) => Buffer = randomBytes;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

/** For tests (testing/): the bytes to draw instead of crypto's; undefined restores it. */
export function useRandom(next: ((size: number) => Buffer) | undefined): void {
  source = next ?? randomBytes;
}

export const now = (): Date => clock();

export const random = (size: number): Buffer => source(size);
