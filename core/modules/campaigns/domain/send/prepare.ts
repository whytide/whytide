// A claimed step's request file (docs/flows.md "The sender", step 5), read in the caller's tenant
// run in linkedin's sendRequestFile shape: the person's member id from contacts' providerRefs under
// MEMBER_REF_KEY, the approved text from approvals (a connection request's note, left out when it is
// empty, or a message's text) and the step's own key. campaigns stores no provider ref; the file is
// written under the workspace's raw/ after the run (workflows/sender.ts), so the text and the member
// id never enter a workflow's input, result or history. A person with no member id known waits
// (member_ref_unknown); one erased meanwhile waits as person_not_found, which the next gate stops.
// beta-p4-040: a file off the port's schema is a defect, the step failed (linkedin_input_invalid)
// with its holds freed; for a check (`check`), the file is written again from the step left
// `executing`, and when it cannot be, why, with no write: the activity checks with the file the send
// left, or, with none, puts the step back (recover.ts putBackUnsent).
import { approvedContent } from "@whytide/approvals";
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { type SendRequestFile, sendRequestFile } from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import { STEP_NOT_READY } from "../gate/constants.ts";
import { checkGate, type GateReason } from "../gate/gate.ts";
import type { StepReasonCode } from "../steps/constants.ts";
import { INPUT_INVALID, MEMBER_REF_KEY, REQUEST_FILE, REQUEST_FOLDER } from "./constants.ts";
import { blockClaimed } from "./gate.ts";
import { failStep } from "./recover.ts";
import { type Holds, releaseHolds, waitAgain } from "./release.ts";

/** The file to write, at its key, and the approved text's hash (none for a withdrawal). */
export type SendRequest = {
  readonly key: string;
  readonly file: SendRequestFile;
  readonly contentHash: string | null;
};
export type Prepared =
  | { readonly request: SendRequest }
  | { readonly waiting: GateReason }
  /** A check's request that cannot be written again, and why: nothing written. */
  | { readonly unbuilt: StepReasonCode };

/** The request file's key of a step: `raw/campaigns/<stepExecutionId>/send.json`. */
export const requestKeyOf = (stepExecutionId: string): string =>
  `${REQUEST_FOLDER}/${stepExecutionId}/${REQUEST_FILE}`;

/**
 * The claimed step's request at `at`, or why it waits, its holds then freed; for a check, its holds
 * kept (the file's header).
 */
export async function prepareRequest(
  stepExecutionId: string,
  holds: Holds,
  at: Date,
  check = false,
): Promise<Prepared> {
  const id = stepExecutionId;
  const step = await tenantClient.stepExecution.findFirst({
    where: { id, status: "executing" },
    select: { personId: true, actionType: true, idempotencyKey: true },
  });
  if (step === null && check) return { waiting: STEP_NOT_READY };
  if (step === null) return { waiting: (await blockClaimed(id, holds, STEP_NOT_READY)).reason };
  const { personId, actionType, idempotencyKey } = step;
  const memberRef = await memberRefOf(personId);
  if (memberRef === null || memberRef === GONE) {
    const code = memberRef === GONE ? "person_not_found" : "member_ref_unknown";
    if (check) return { unbuilt: code };
    await releaseHolds(holds);
    await waitAgain({ id, status: "executing" }, code);
    return { waiting: code };
  }
  const base = { stepExecutionId: id, personId, memberRef, idempotencyKey };
  const request = { id, key: requestKeyOf(id), holds, at, check };
  if (actionType === "withdraw") return parsed(request, { ...base, actionType }, null);
  const content = await approvedContent(id);
  if (content === null && check) return { unbuilt: "not_approved" };
  if (content === null) {
    // No longer approved since the claim: the gate stops it as it would right before the call.
    const gate = await checkGate(id, { at });
    return {
      waiting: (await blockClaimed(id, holds, gate.pass ? "not_approved" : gate.reason)).reason,
    };
  }
  const { text, contentHash } = content;
  const words = actionType === "invite" ? (text === "" ? {} : { note: text }) : { text };
  return parsed(request, { ...base, actionType, ...words }, contentHash);
}

/**
 * The file in the port's schema at its key; off it, a defect: the holds freed and the step failed,
 * its enrollment ended (recover.ts failStep), or for a check the reason alone.
 */
async function parsed(
  request: { id: string; key: string; holds: Holds; at: Date; check: boolean },
  fields: Record<string, unknown>,
  contentHash: string | null,
): Promise<Prepared> {
  const { id, key, holds, at, check } = request;
  const file = sendRequestFile.safeParse(fields);
  if (file.success) return { request: { key, file: file.data, contentHash } };
  if (check) return { unbuilt: INPUT_INVALID };
  await releaseHolds(holds);
  await failStep(id, INPUT_INVALID, true, at);
  return { waiting: INPUT_INVALID };
}

/** contacts' person was erased meanwhile. */
const GONE = Symbol("person_not_found");

/** The person's member id at the provider, null when none is known; GONE for a person erased. */
async function memberRefOf(personId: string): Promise<string | null | typeof GONE> {
  try {
    const refs = (await getPerson(personId)).providerRefs;
    return refs !== null && Object.hasOwn(refs, MEMBER_REF_KEY)
      ? (refs[MEMBER_REF_KEY] ?? null)
      : null;
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return GONE;
    throw error;
  }
}
