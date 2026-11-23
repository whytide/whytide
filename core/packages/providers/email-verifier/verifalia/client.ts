// The verifalia adapter's calls (README.md "Covers"): Node's fetch, in this folder only, to the
// vendor's fixed host, with the user's credentials in the Authorization header and nowhere else. One
// check is one job of one entry: POST /v2.7/email-validations with the address alone, asking the
// vendor to wait for it; a job still running (202) is read again by its id, GET …/<id>, until done or
// until the 10-second budget or POLLS_MAX reads run out, which is the provider error, `reason`
// job_unfinished: no retry, the job counted, and enrichment passes the address to the next verifier.
// Each answer is read as ../answer.ts reads every vendor's: 402 the credits gone, 401 and 403 a
// refused user, 429 the rate limit. The job's Location header is never followed.
import { type Answered, exchange, offShape, providerError } from "../answer.ts";
import { JSON_TYPE } from "../constants.ts";
import {
  IN_PROGRESS_STATUS,
  JOB_ID,
  JOBS_PATH,
  MAX_ANSWER_BYTES,
  POLLS_MAX,
  RETRY_AFTER_SEC,
  WAIT_MARGIN_MS,
  WAIT_TIME,
  WAIT_TIME_MAX_MS,
} from "./constants.ts";

/** One check: the finished job's JSON, or one of the port's codes. */
export type VerifaliaClient = (address: string) => Promise<unknown>;

export function verifaliaClient(
  origin: string,
  credentials: { readonly username: string; readonly password: string },
  budgetMs: number,
  now: () => number,
): VerifaliaClient {
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now };
  const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
  const headers = { accept: JSON_TYPE, authorization: `Basic ${basic}` };
  return async (address) => {
    const deadline = now() + budgetMs;
    const send = (path: string, body?: string): Promise<Answered> => {
      const left = deadline - now();
      const url = new URL(path, origin);
      url.searchParams.set(WAIT_TIME, String(Math.min(WAIT_TIME_MAX_MS, left - WAIT_MARGIN_MS)));
      const init = {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? headers : { ...headers, "content-type": JSON_TYPE },
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(left),
      } as const;
      return exchange(() => fetch(url, init), answers);
    };
    let answered = await send(JOBS_PATH, JSON.stringify({ entries: [{ inputData: address }] }));
    for (let polls = 0; answered.status === IN_PROGRESS_STATUS; polls += 1) {
      if (polls >= POLLS_MAX || deadline - now() <= WAIT_MARGIN_MS) {
        throw providerError({ reason: "job_unfinished" });
      }
      answered = await send(`${JOBS_PATH}/${jobIdOf(answered.body)}`);
    }
    return answered.body;
  };
}

/** The running job's id, `overview.id`, a UUID; anything else is off the documented shape. */
function jobIdOf(body: unknown): string {
  const id = (body as { overview?: { id?: unknown } | null } | null)?.overview?.id;
  if (typeof id !== "string" || !JOB_ID.test(id)) throw offShape();
  return id;
}
