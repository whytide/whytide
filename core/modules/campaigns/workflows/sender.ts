// The sender's activities' bodies (README.md "Worker"; docs/flows.md "The sender"), each in its own
// tenant runs through domain/send/: the claim, with insufficient_credits recorded in a run after the
// claim's rolled back, in its modes around a profile read too (beta-p4-030); the request file written under the workspace's raw/ after the run that read
// it, read before the gate's run, and deleted once the step is settled. No files call inside a run.
// A step left `executing` keeps its file, which beta-p4-040's check writes again and reads, or reads
// as the send left it when it cannot be written again; a check carries no reservation, and the
// gate's pass says how long it holds (domain/send/fresh.ts).
import { text } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import { sendRequestFile } from "@whytide/linkedin";
import { type ActivityContext, creditsCodes, isAppError } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { now } from "../domain/clock.ts";
import type { GateReason } from "../domain/gate/gate.ts";
import {
  type ChargeAnswer,
  type ClaimAnswer,
  chargeStep,
  claimSlot,
  claimStep,
  type ReadRefused,
  readRefused,
  waitForCredits,
} from "../domain/send/claim.ts";
import { type ClaimMode, REQUEST_CONTENT_TYPE } from "../domain/send/constants.ts";
import { gateFreshMs } from "../domain/send/fresh.ts";
import { type CallGate, gateBeforeCall, hashOf } from "../domain/send/gate.ts";
import { prepareRequest, requestKeyOf } from "../domain/send/prepare.ts";
import { putBackUnsent } from "../domain/send/recover.ts";
import type { Holds } from "../domain/send/release.ts";
import { type SendAnswer, type Settled, settleSend } from "../domain/send/settle.ts";

type Context = ActivityContext<TenantClient>;
/** A claimed step and its holds, as the workflow passes them; a check's has no reservation. */
export type ClaimedStep = {
  readonly stepExecutionId: string;
  readonly reservationId: string | null;
  readonly usageId: string | null;
};

const holdsOf = ({ usageId, reservationId }: ClaimedStep): Holds => ({ usageId, reservationId });
const files = () => getAdapter(filesPort, filesConfig.PROVIDER_FILES);

/**
 * campaigns_sender_claim: the read's refusal recorded, or the claim (domain/send/claim.ts); in the
 * mode `credits` its credits alone, and in the mode `slot` the slot of a step charged already.
 */
export async function claim(
  input: {
    stepExecutionId: string;
    scheduledFor: string;
    readRefused?: ReadRefused | undefined;
    mode?: ClaimMode | undefined;
    usageId?: string | null | undefined;
  },
  context: Context,
): Promise<ClaimAnswer | ChargeAnswer> {
  const placed = {
    stepExecutionId: input.stepExecutionId,
    scheduledFor: new Date(input.scheduledFor),
  };
  const { mode, usageId = null } = input;
  const refusal = input.readRefused;
  if (refusal !== undefined) return context.tenant(() => readRefused(placed, refusal));
  if (mode === "slot")
    return context.tenant(() => claimSlot(placed.stepExecutionId, usageId, now()));
  try {
    return await context.tenant<ClaimAnswer | ChargeAnswer>(() =>
      mode === "credits" ? chargeStep(placed, now()) : claimStep(placed, now()),
    );
  } catch (error) {
    if (!(isAppError(error) && error.code === creditsCodes.insufficient_credits)) throw error;
    await context.tenant(() => waitForCredits(placed));
    return { refused: creditsCodes.insufficient_credits, retryAt: null };
  }
}

/** campaigns_sender_prepare: the request read in a run, then written; or why the step waits. */
export async function prepare(
  input: ClaimedStep & { check?: boolean | undefined },
  context: Context,
): Promise<{ requestKey: string; contentHash: string | null } | { waiting: GateReason }> {
  const { stepExecutionId, check = false } = input;
  const prepared = await context.tenant(() =>
    prepareRequest(stepExecutionId, holdsOf(input), now(), check),
  );
  if ("waiting" in prepared) return prepared;
  if ("unbuilt" in prepared) {
    // A check's request that cannot be written again: the file the send left, if any, is checked;
    // with none, no call was made (domain/send/recover.ts putBackUnsent).
    const requestKey = requestKeyOf(stepExecutionId);
    if (await hasFile(context.workspaceId, requestKey)) return { requestKey, contentHash: null };
    const code = prepared.unbuilt;
    await context.tenant(() => putBackUnsent(stepExecutionId, holdsOf(input), code, now()));
    return { waiting: code };
  }
  const { key, file, contentHash } = prepared.request;
  const body = JSON.stringify(file);
  const put = { workspaceId: context.workspaceId, key, body, contentType: REQUEST_CONTENT_TYPE };
  await (await files()).put(put);
  return { requestKey: key, contentHash };
}

/**
 * campaigns_sender_gate: the file's text hashed, then the gate's run; a blocked step's file deleted.
 * A pass holds for `freshForMs` of the workflow's time.
 */
export async function gate(
  input: ClaimedStep,
  context: Context,
): Promise<{ pass: true; freshForMs: number } | Extract<CallGate, { pass: false }>> {
  const key = requestKeyOf(input.stepExecutionId);
  const fileHash = await textHashOf(context.workspaceId, key);
  const holds = holdsOf(input);
  const answer = await context.tenant(() =>
    gateBeforeCall({ stepExecutionId: input.stepExecutionId, holds, fileHash }, now()),
  );
  if (!answer.pass) await deleteRequest(context.workspaceId, key);
  return answer.pass ? { pass: true, freshForMs: gateFreshMs() } : answer;
}

/** campaigns_sender_settle: the settle's run on the answer, then a settled step's file deleted. */
export async function settle(
  input: ClaimedStep & { answer: SendAnswer },
  context: Context,
): Promise<Settled> {
  const { stepExecutionId, answer } = input;
  const holds = holdsOf(input);
  const settled = await context.tenant(() => settleSend({ stepExecutionId, holds, answer }, now()));
  if (settled.outcome !== "kept")
    await deleteRequest(context.workspaceId, requestKeyOf(stepExecutionId));
  return settled;
}

/**
 * The hash of the text in the step's request file: the note (none hashes as empty) or the message;
 * null for a withdrawal's, no file, or one that is no send's. A read that fails otherwise throws, and
 * Temporal retries the activity.
 */
async function textHashOf(workspaceId: string, key: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await text((await (await files()).get({ workspaceId, key })).body);
  } catch (error) {
    if (isAppError(error) && error.code === filesPort.errors.files_not_found) return null;
    throw error;
  }
  const parsed = sendRequestFile.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  const file = parsed.data;
  if (file.actionType === "invite") return hashOf(file.note ?? "");
  return file.actionType === "message" ? hashOf(file.text) : null;
}

/** Whether the file is there. */
async function hasFile(workspaceId: string, key: string): Promise<boolean> {
  try {
    (await (await files()).get({ workspaceId, key })).body.destroy();
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === filesPort.errors.files_not_found) return false;
    throw error;
  }
}

/** The text as JSON, or null when it is none. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The file deleted; one gone already is no error. */
export async function deleteRequest(workspaceId: string, key: string): Promise<void> {
  try {
    await (await files()).delete({ workspaceId, key });
  } catch (error) {
    if (!(isAppError(error) && error.code === filesPort.errors.files_not_found)) throw error;
  }
}
