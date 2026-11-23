// What the reads of a signal run share (README.md "Worker"): the engager and the profile reads
// (index.ts) and the posts read (posts.ts) ask beforeRead just before their port call, on every
// attempt, and log each call's row with logRead, its error's health in the same run.
import { findAccount } from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import { now } from "../domain/clock.ts";
import { readControls } from "../domain/controls/controls.ts";
import { afterPortError } from "../domain/health/signals.ts";
import { type ReadCallRefusal, readCallRefusal } from "../domain/send/state.ts";
import type { RefContext } from "./decrypt.ts";

/**
 * Just before a read's port call, on every attempt (Temporal retries a read that threw): the switches
 * and the account read again, as its reservation read them, so that a stop, a lost connection, a
 * warning or the third error of an attempt before, or of a send meanwhile, stops the call:
 * readCallRefusal's code, answered with no row, as no call was made; else null.
 */
export async function beforeRead(
  context: RefContext,
  accountId: string,
): Promise<ReadCallRefusal | null> {
  return context.tenant(async () => {
    const account = await findAccount(accountId);
    return readCallRefusal(account, await readControls(), now());
  });
}

/** A read's row; after a port error, the account's health in the same run (domain/health/signals.ts). */
export async function logRead(entry: Parameters<typeof logAction>[0], error: unknown) {
  const logged = await logAction(entry);
  if (error !== undefined) await afterPortError(entry.accountId, error, now());
  return logged;
}
