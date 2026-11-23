// The time invites are made, renewed, revoked, accepted and checked at (README.md "Invites"): the
// system's, or the one a test sets through testing/ useIdentityClock. Nothing else in the module
// asks the system for the time, so a test moves an invite past its expiry without waiting.
const system = () => new Date();
let clock: () => Date = system;

/** For tests (testing/): the clock to read instead of the system's; undefined restores it. */
export function useClock(next: (() => Date) | undefined): void {
  clock = next ?? system;
}

export const now = (): Date => clock();
