// The erasure (docs/flows.md "Erase"): one tenant run that resolves the person, runs the platform's
// eraser, locks the lead, asks the caller's guard, runs every other registered eraser in dependency
// order, then contacts' erasePerson, which asks the caller's recheck on the person's row, locked,
// with the other erasers' counts, deletes the person and, for a request, leaves its erased hash; then
// it writes the log row with the reason. An error rolls every row back; a dry run rolls back on
// purpose, once it has counted what the erasure deletes, and a refusal of the guard or the recheck
// rolls back too. The 30-day rule (../retention/) and the lead deletion (../lead-delete/) are its
// callers with a guard and a recheck.
import {
  errors as contactsErrors,
  erasePerson,
  findPersonByEmail,
  findPersonByLinkedinUrl,
  getPerson,
  type LockedPerson,
  lockLeadStatus,
} from "@whytide/contacts";
import { withTenant } from "@whytide/db";
import { AppError, servicePrincipal } from "@whytide/platform";
import { givenClient } from "../client.ts";
import { ERASE_TIMEOUT_MS } from "./constants.ts";
import { FIRST, LAST } from "./erasers.ts";
import { type ErasureReason, writeErasureLog } from "./log.ts";
import { type Eraser, type ErasureCounts, registeredErasers } from "./registry.ts";

/** A check under the lead's lock: null to go on, or the code that refuses the erasure. */
export type ErasureGuard = (personId: string) => Promise<string | null>;
/**
 * The check again, on the person's row, locked right before contacts deletes it, with the rows every
 * other eraser deleted, by module: null, or a code.
 */
export type ErasureRecheck = (
  person: LockedPerson,
  erased: Readonly<Record<string, ErasureCounts>>,
) => Promise<string | null>;

export type ErasureRequest = {
  readonly workspaceId: string;
  /**
   * The person, by its id, by its LinkedIn URL, which is normalized first, or by an email address
   * they hold, whose hash finds them, one without a LinkedIn profile too (gamma-rf-050): the address
   * is never logged, printed or kept.
   */
  readonly person:
    | { readonly id: string }
    | { readonly linkedinUrl: string }
    | { readonly email: string };
  /** The operator who runs the command, the log's performed_by. */
  readonly operator: string;
  readonly dryRun: boolean;
  /**
   * `request` by default, the deletion script's; `retention_never_contacted`, the 30-day rule's, and
   * `lead_deleted`, `pnpm lead:delete`'s, write no erased hash and a log row without one.
   */
  readonly reason?: ErasureReason;
  /** Asked right after the lead's lock; a code refuses: the run rolls back and keeps no log row. */
  readonly guard?: ErasureGuard;
  /**
   * Asked with the person's row, read under its lock right before contacts deletes it (contacts'
   * erasePerson, `beforeDelete`), and the rows the other erasers deleted: a touch another run is
   * still writing is waited for and seen. A code refuses, as the guard's does.
   */
  readonly recheck?: ErasureRecheck;
};

export type Erasure = {
  /** The log row's id; null after a dry run, which keeps none. */
  readonly logId: string | null;
  /** The rows deleted, by module, in the order the erasers ran, contacts last. */
  readonly counts: Readonly<Record<string, ErasureCounts>>;
};

/** A refusal of the guard or the recheck: nothing changed, and no log row. */
export type ErasureSkipped = { readonly skipped: string };

/** Thrown to end the dry run's transaction, which rolls back; it carries the counts out. */
class DryRun extends Error {
  readonly erasure: Erasure;
  constructor(erasure: Erasure) {
    super("dry run: rolled back");
    this.erasure = erasure;
  }
}

/** Thrown to end the run a guard or a recheck refused, which rolls back; it carries the code out. */
class Refused extends Error {
  readonly code: string;
  constructor(code: string) {
    super("refused by the guard: rolled back");
    this.code = code;
  }
}

/**
 * Erases the person from the workspace in one tenant run and returns the counts and the log row's
 * id, or the refusal of the guard or the recheck. person_not_found, linkedin_url_invalid, and
 * contacts_input_invalid for a text that is no address: nothing ran. `erasers` is for tests: the
 * registered ones by default.
 */
export function erase(
  request: ErasureRequest & { readonly guard?: undefined; readonly recheck?: undefined },
  erasers?: readonly Eraser[],
): Promise<Erasure>;
export function erase(
  request: ErasureRequest,
  erasers?: readonly Eraser[],
): Promise<Erasure | ErasureSkipped>;
export async function erase(
  request: ErasureRequest,
  erasers: readonly Eraser[] = registeredErasers(),
): Promise<Erasure | ErasureSkipped> {
  const requestedAt = new Date();
  const reason = request.reason ?? "request";
  const context = { workspaceId: request.workspaceId, principal: servicePrincipal("privacy") };
  const { recheck } = request;
  const run = async (): Promise<Erasure> => {
    const personId = await resolve(request.person);
    const counts: Record<string, ErasureCounts> = {};
    const beforeDelete =
      recheck === undefined
        ? undefined
        : async (person: LockedPerson) => {
            const refused = await recheck(person, counts);
            if (refused !== null) throw new Refused(refused);
          };
    // The platform's step first, before any lock: it waits for a delivery that claimed one of its
    // outbox events, whose handler may lock the lead (campaigns' enrollment). With the lead held
    // here, both would wait out the claim's timeout, a cycle Postgres cannot see. Then the lead,
    // before every other step: a reply's hold, an enrollment and a skip lock it before the rows
    // they change, so they wait for the erasure and then find the person gone, rather than
    // deadlock with an eraser that deleted those rows. The guard reads after that lock, a first
    // look only: a writer of the person's touch need not hold the lead (a send's settle before the
    // last step holds its enrollment; inbox's echo locks no lead for a person without one), and
    // a touch it has not committed reads as none. So the recheck reads the person's row again
    // under its lock, at the delete, the last lock the run takes before the log row: the order is
    // the platform's rows, the lead, every other eraser's rows, contacts' own, then the person's.
    for (const eraser of erasers.filter(({ module }) => module === FIRST)) {
      counts[eraser.module] = await eraser.erase(personId);
    }
    await lockLeadStatus(personId);
    const refused = (await request.guard?.(personId)) ?? null;
    if (refused !== null) throw new Refused(refused);
    for (const eraser of erasers.filter(({ module }) => module !== FIRST)) {
      counts[eraser.module] = await eraser.erase(personId);
    }
    const writeErasedHash = reason === "request";
    const { counts: own, hash: personHash } = await erasePerson(personId, {
      writeErasedHash,
      beforeDelete,
    });
    counts[LAST] = own;
    const performedBy = request.operator;
    const entry = { personHash, reason, requestedAt, counts, performedBy };
    const logId = await writeErasureLog(entry);
    if (request.dryRun) throw new DryRun({ logId: null, counts });
    return { logId, counts };
  };
  try {
    return await withTenant(context, run, { client: givenClient(), timeout: ERASE_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof DryRun) return error.erasure;
    if (error instanceof Refused) return { skipped: error.code };
    throw error;
  }
}

async function resolve(person: ErasureRequest["person"]): Promise<string> {
  if ("id" in person) return (await getPerson(person.id)).id;
  const found =
    "email" in person
      ? await findPersonByEmail(person.email)
      : await findPersonByLinkedinUrl(person.linkedinUrl);
  if (found === null) throw new AppError(contactsErrors.person_not_found);
  return found.id;
}
