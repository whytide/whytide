// The erasure (docs/flows.md "Erase"): one tenant run that resolves the person, runs the platform's
// eraser, locks the lead, runs every other registered eraser in dependency order, then contacts'
// erasePerson, which deletes the person and leaves its erased hash, and writes the log row. An
// error rolls every row back; a dry run rolls back on purpose, once it has counted what the
// erasure deletes.
import {
  errors as contactsErrors,
  erasePerson,
  findPersonByLinkedinUrl,
  getPerson,
  lockLeadStatus,
} from "@whytide/contacts";
import { withTenant } from "@whytide/db";
import { AppError, servicePrincipal } from "@whytide/platform";
import { givenClient } from "../client.ts";
import { FIRST, LAST } from "./erasers.ts";
import { writeErasureLog } from "./log.ts";
import { type Eraser, type ErasureCounts, registeredErasers } from "./registry.ts";

export type ErasureRequest = {
  readonly workspaceId: string;
  /** The person, by its id or by its LinkedIn URL, which is normalized first. */
  readonly person: { readonly id: string } | { readonly linkedinUrl: string };
  /** The operator who runs the command, the log's performed_by. */
  readonly operator: string;
  readonly dryRun: boolean;
};

export type Erasure = {
  /** The log row's id; null after a dry run, which keeps none. */
  readonly logId: string | null;
  /** The rows deleted, by module, in the order the erasers ran, contacts last. */
  readonly counts: Readonly<Record<string, ErasureCounts>>;
};

/** How long the run may take before Prisma ends its transaction, which rolls every row back. */
const TIMEOUT_MS = 120_000;

/** Thrown to end the dry run's transaction, which rolls back; it carries the counts out. */
class DryRun extends Error {
  readonly erasure: Erasure;
  constructor(erasure: Erasure) {
    super("dry run: rolled back");
    this.erasure = erasure;
  }
}

/**
 * Erases the person from the workspace in one tenant run and returns the counts and the log row's
 * id. person_not_found, linkedin_url_invalid: nothing ran. `erasers` is for tests: the registered
 * ones by default.
 */
export async function erase(
  request: ErasureRequest,
  erasers: readonly Eraser[] = registeredErasers(),
): Promise<Erasure> {
  const requestedAt = new Date();
  const context = { workspaceId: request.workspaceId, principal: servicePrincipal("privacy") };
  const run = async (): Promise<Erasure> => {
    const personId = await resolve(request.person);
    const counts: Record<string, ErasureCounts> = {};
    // The platform's step first, before any lock: it waits for a delivery that claimed one of its
    // outbox events, whose handler may lock the lead (campaigns' enrollment). With the lead held
    // here, both would wait out the claim's timeout, a cycle Postgres cannot see. Then the lead,
    // before every other step: a reply's hold, an enrollment and a skip lock it before the rows
    // they change, so they wait for the erasure and then find the person gone, rather than
    // deadlock with an eraser that deleted those rows.
    for (const eraser of erasers.filter(({ module }) => module === FIRST)) {
      counts[eraser.module] = await eraser.erase(personId);
    }
    await lockLeadStatus(personId);
    for (const eraser of erasers.filter(({ module }) => module !== FIRST)) {
      counts[eraser.module] = await eraser.erase(personId);
    }
    const { counts: own, hash: personHash } = await erasePerson(personId);
    counts[LAST] = own;
    const performedBy = request.operator;
    const logId = await writeErasureLog({ personHash, requestedAt, counts, performedBy });
    if (request.dryRun) throw new DryRun({ logId: null, counts });
    return { logId, counts };
  };
  try {
    return await withTenant(context, run, { client: givenClient(), timeout: TIMEOUT_MS });
  } catch (error) {
    if (error instanceof DryRun) return error.erasure;
    throw error;
  }
}

async function resolve(person: ErasureRequest["person"]): Promise<string> {
  if ("id" in person) return (await getPerson(person.id)).id;
  const found = await findPersonByLinkedinUrl(person.linkedinUrl);
  if (found === null) throw new AppError(contactsErrors.person_not_found);
  return found.id;
}
