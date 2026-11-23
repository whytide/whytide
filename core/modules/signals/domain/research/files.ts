// The research run's files (README.md "Web research"): each step's own earlier output is read by its
// key, never found by a listing: `files_not_found` is "not there" (whytide-docs diagnosis log,
// 2026-11-19: the port lists whole keys, `w/<workspace>/...`, and reads by the key relative to the
// workspace). The run's folder is raw/signals/<runId>/, which raw/'s 72 hours empty.
import { json } from "node:stream/consumers";
import { isAppError } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { runFolder } from "../process/keys.ts";
import {
  CANDIDATES_FOLDER,
  JUDGE_FOLDER,
  JUDGE_QUEUE_FILE,
  MANAGERS_FOLDER,
  PAGES_FOLDER,
  PEOPLE_FOLDER,
  PEOPLE_QUEUE_FILE,
  PICK_FOLDER,
  PROFILES_FOLDER,
  QUEUE_FILE,
  SITE_FOLDER,
  VERDICT_FOLDER,
} from "./constants.ts";

/** The key of the run's `position`th pick: the results of that search worth reading. */
export const pickKey = (runId: string, position: number): string =>
  `${runFolder(runId)}${PICK_FOLDER}/${position}.json`;
/** The key of the run's queue of pages. */
export const queueKey = (runId: string): string =>
  `${runFolder(runId)}${PAGES_FOLDER}/${QUEUE_FILE}`;
/** The key of the run's `index`th page read, from 1. */
export const pageKey = (runId: string, index: number): string =>
  `${runFolder(runId)}${PAGES_FOLDER}/${index}.json`;

/** What a file holds, or null when there is none under the key. Any other failure is thrown. */
export async function readJsonFile(workspaceId: string, key: string): Promise<unknown> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  try {
    return await json((await files.get({ workspaceId, key })).body);
  } catch (error) {
    if (isAppError(error) && error.code === filesPort.errors.files_not_found) return null;
    throw error;
  }
}

/** The key of the companies the run's `index`th page named, gated: the candidates' step reads it. */
export const namedKey = (runId: string, index: number): string =>
  `${runFolder(runId)}${CANDIDATES_FOLDER}/${index}.json`;

/** The key of the run's queue of candidates to judge (gamma-wr-050). */
export const judgeQueueKey = (runId: string): string =>
  `${runFolder(runId)}${JUDGE_FOLDER}/${JUDGE_QUEUE_FILE}`;
/** The key of the pages of the site of the run's `index`th candidate of the queue, from 1. */
export const siteKey = (runId: string, index: number): string =>
  `${runFolder(runId)}${SITE_FOLDER}/${index}.json`;
/** The key of the gated answer and the verdict on the run's `index`th candidate of the queue. */
export const verdictKey = (runId: string, index: number): string =>
  `${runFolder(runId)}${VERDICT_FOLDER}/${index}.json`;

/** The key of the run's queue of found companies whose people are taken (gamma-wr-060). */
export const peopleQueueKey = (runId: string): string =>
  `${runFolder(runId)}${PEOPLE_FOLDER}/${PEOPLE_QUEUE_FILE}`;

/** The key of the results of the profile search of the `n`th person of a found company's pick (gamma-wr-070). */
export const profileKey = (runId: string, foundCompanyId: string, n: number): string =>
  `${runFolder(runId)}${PROFILES_FOLDER}/${foundCompanyId}-${n}.json`;

/** The key of the results of the managers' search of a found company (gamma-wr-090). */
export const managersKey = (runId: string, foundCompanyId: string): string =>
  `${runFolder(runId)}${MANAGERS_FOLDER}/${foundCompanyId}.json`;
