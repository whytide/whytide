// The activities' bodies of the profile read before a connection request (beta-p4-030; README.md
// "Worker"; docs/flows.md "The read before an invite"), each in its own tenant runs through
// domain/send/profile.ts: the read reserved in a run, then its request file, the person's stored URL,
// written under the workspace's raw/; linkedin's answer file read before the settle's run, and both
// files deleted after it, so a settle retried with its answer file gone answers from the person
// (beta-p4-040). No files call inside a run, and neither file's body reaches the workflow.
import { text } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import { type ProfileFile, profileFile, profileRequestFile, releaseReads } from "@whytide/linkedin";
import { type ActivityContext, isAppError } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { now } from "../domain/clock.ts";
import type { GateReason } from "../domain/gate/gate.ts";
import { REQUEST_CONTENT_TYPE } from "../domain/send/constants.ts";
import {
  type ProfileAnswer,
  type ProfileSettled,
  profileKeysOf,
  reserveProfileRead,
  settledBefore,
  settleProfileRead,
} from "../domain/send/profile.ts";
import { deleteRequest } from "./sender.ts";

type Context = ActivityContext<TenantClient>;
/** A step claimed and charged for its connection request, no slot yet, as the workflow passes it. */
type ChargedStep = { readonly stepExecutionId: string; readonly usageId: string | null };
/** The read reserved and the two files' keys; or why not, the credits freed. */
export type ProfilePrepared =
  | { readonly reservationId: string; readonly requestKey: string; readonly rawKey: string }
  | { readonly refused: string; readonly retryAt: string | null }
  | { readonly blocked: GateReason };

const files = () => getAdapter(filesPort, filesConfig.PROVIDER_FILES);

/** campaigns_profile_prepare: the read reserved in a run, then its request file; or why not. */
export async function prepareProfile(
  input: ChargedStep,
  context: Context,
): Promise<ProfilePrepared> {
  const { stepExecutionId } = input;
  const holds = { usageId: input.usageId, reservationId: null };
  const reserved = await context.tenant(() => reserveProfileRead(stepExecutionId, holds, now()));
  if (!("reservationId" in reserved)) return reserved;
  const { reservationId, profileUrl } = reserved;
  const { requestKey, rawKey } = profileKeysOf(stepExecutionId);
  const body = JSON.stringify(profileRequestFile.parse({ profileUrl }));
  try {
    const put = {
      workspaceId: context.workspaceId,
      key: requestKey,
      contentType: REQUEST_CONTENT_TYPE,
    };
    await (await files()).put({ ...put, body });
  } catch (error) {
    // Unwritten, the file is never read: the reservation freed before the attempt's retry.
    await context.tenant(() => releaseReads(reservationId));
    throw error;
  }
  return { reservationId, requestKey, rawKey };
}

/** campaigns_profile_settle: linkedin's answer file read, then the settle's run, then both deleted. */
export async function settleProfile(
  input: ChargedStep & {
    reservationId: string;
    answer: { key: string } | { refused: string } | null;
  },
  context: Context,
): Promise<ProfileSettled> {
  const { stepExecutionId, reservationId } = input;
  const { workspaceId } = context;
  const { requestKey, rawKey } = profileKeysOf(stepExecutionId);
  let answer: ProfileAnswer;
  if (input.answer === null || !("key" in input.answer)) answer = input.answer;
  else {
    const profile = await readProfile(workspaceId, rawKey);
    if (profile === null) return context.tenant(() => settledBefore(stepExecutionId, now()));
    answer = { profile };
  }
  const holds = { usageId: input.usageId, reservationId: null };
  const settled = await context.tenant(() =>
    settleProfileRead({ stepExecutionId, holds, reservationId, answer }, now()),
  );
  for (const key of [requestKey, rawKey]) await deleteRequest(workspaceId, key);
  return settled;
}

/**
 * linkedin's answer file: the profile as it wrote it; null once gone, deleted after the settle's run
 * by an attempt whose answer was lost. A read that fails throws, and Temporal retries.
 */
async function readProfile(workspaceId: string, key: string): Promise<ProfileFile | null> {
  try {
    const { body } = await (await files()).get({ workspaceId, key });
    return profileFile.parse(JSON.parse(await text(body)));
  } catch (error) {
    if (isAppError(error) && error.code === filesPort.errors.files_not_found) return null;
    throw error;
  }
}
