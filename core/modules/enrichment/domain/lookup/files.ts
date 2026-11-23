// A lookup's candidates (docs/security.md "The raw/ files"): each kept candidate in a file of its
// own under the workspace's raw/, `raw/enrichment/<requestId>/<n>.json`, through the files port, so
// that no address enters the workflow, the request's row or a log line. A file lives 72 hours at
// most (the port's raw/ rule), and the settle deletes the lookup's files once it committed.
import { AppError, isAppError } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { z } from "zod";
import { errors } from "../../errors.ts";
import {
  CONTACT_KINDS,
  RAW_CONTENT_TYPE,
  RAW_FOLDER,
  RAW_MAX_BYTES,
  VERDICTS,
} from "./constants.ts";

const candidate = z.strictObject({
  address: z.string().min(3).max(254),
  kind: z.enum(CONTACT_KINDS),
  /** The source that proposed it, its class and the provider that answered. */
  source: z.string().max(100),
  sourceClass: z.string().max(64),
  provider: z.string().max(64),
  /** The verifier's verdict once one gave it, and that verifier. */
  verdict: z.enum(VERDICTS).optional(),
  verifier: z.string().max(100).optional(),
});
export type Candidate = z.infer<typeof candidate>;

const files = () => getAdapter(filesPort, filesConfig.PROVIDER_FILES);
const folderOf = (requestId: string) => `${RAW_FOLDER}/${requestId}`;
const keyOf = (requestId: string, n: number) => `${folderOf(requestId)}/${n}.json`;

export async function writeCandidate(
  workspaceId: string,
  requestId: string,
  n: number,
  body: Candidate,
): Promise<void> {
  const key = keyOf(requestId, n);
  const text = JSON.stringify(candidate.parse(body));
  await (await files()).put({
    workspaceId,
    key,
    body: text,
    contentType: RAW_CONTENT_TYPE,
    maxBytes: RAW_MAX_BYTES,
  });
}

/** The candidate's file; enrichment_file_invalid when it is gone or off its shape. */
export async function readCandidate(
  workspaceId: string,
  requestId: string,
  n: number,
): Promise<Candidate> {
  try {
    const { body } = await (await files()).get({ workspaceId, key: keyOf(requestId, n) });
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    const parsed = candidate.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch (error) {
    if (!(isAppError(error) && error.code === filesPort.errors.files_not_found)) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new AppError(errors.enrichment_file_invalid, { details: { n } });
}

/** Every candidate of the lookup so far, by n. */
export async function readCandidates(
  workspaceId: string,
  requestId: string,
): Promise<Map<number, Candidate>> {
  const { files: listed } = await (await files()).list({
    workspaceId,
    prefix: `${folderOf(requestId)}/`,
  });
  const found = new Map<number, Candidate>();
  for (const { key } of listed) {
    const n = Number(/\/(\d+)\.json$/.exec(key)?.[1]);
    if (Number.isInteger(n)) found.set(n, await readCandidate(workspaceId, requestId, n));
  }
  return found;
}

/** The lookup's files deleted; one gone already is no error. */
export async function deleteCandidates(workspaceId: string, requestId: string): Promise<void> {
  const port = await files();
  const { files: listed } = await port.list({ workspaceId, prefix: `${folderOf(requestId)}/` });
  for (const { key } of listed) await port.delete({ workspaceId, key });
}
