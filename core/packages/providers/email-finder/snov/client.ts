// The snov adapter's calls (README.md "Covers"): Node's fetch, in this folder only, to Snov.io's fixed
// host. The client's id and secret go only in the token call's form body; the token stays in this
// closure, in memory, reused until TOKEN_MARGIN_SEC before it expires, and travels as a bearer
// token. A 401 on a finder call fetches the token again, once, and sends that call again, once. A
// lookup starts Snov.io's task with the one person, then reads its result every POLL_MS, all within
// one BUDGET_MS signal: a result not ready by then is the provider error, `reason: "not_ready"`.
// Every answer is read as ../answer.ts reads every finder's. No other retry here.
import { setTimeout as delay } from "node:timers/promises";
import { AppError, isAppError } from "@whytide/platform";
import { z } from "zod";
import { exchange, providerError, type Reading, shaped } from "../answer.ts";
import { JSON_TYPE, MS_PER_SECOND } from "../constants.ts";
import { emailFinderPort, type FindEmailInput } from "../port.ts";
import {
  BEARER,
  FORM_TYPE,
  GRANT_TYPE,
  MAX_ANSWER_BYTES,
  REFUSED_CLIENT,
  RESULT_PATH,
  RETRY_AFTER_SEC,
  START_PATH,
  TASK_STATUS,
  TOKEN_MARGIN_SEC,
  TOKEN_PATH,
  UNAUTHORIZED_STATUS,
} from "./constants.ts";

const { errors } = emailFinderPort;

export type SnovClientOptions = {
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly budgetMs: number;
  readonly pollMs: number;
  readonly now: () => number;
};
/** One lookup: the completed result's JSON, or one of the port's codes. */
export type SnovClient = (input: FindEmailInput) => Promise<unknown>;

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const startAnswer = z.object({
  data: z.object({ task_hash: z.string().min(1).optional() }).nullish(),
  meta: z.object({ task_hash: z.string().min(1).optional() }).nullish(),
});
const resultAnswer = z.object({ status: z.string() });

export function snovClient(options: SnovClientOptions): SnovClient {
  const { origin, clientId, clientSecret, budgetMs, pollMs, now } = options;
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now };
  let cached: { readonly token: string; readonly until: number } | undefined;

  /** The cached token, or a new one from the token call. */
  async function tokenOf(signal: AbortSignal): Promise<string> {
    if (cached && now() < cached.until) return cached.token;
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const headers = { accept: JSON_TYPE, "content-type": FORM_TYPE };
    const init = { method: "POST", headers, body, redirect: "manual", signal } as const;
    const answer = await exchange(() => fetch(new URL(TOKEN_PATH, origin), init), {
      ...answers,
      read: refusedClient,
    });
    const { access_token, expires_in } = shaped(tokenAnswer, answer);
    const until = now() + (expires_in - TOKEN_MARGIN_SEC) * MS_PER_SECOND;
    cached = { token: access_token, until };
    return access_token;
  }

  /** A finder call with the token; a 401 drops it, fetches another and sends the call once more. */
  async function authed(request: (token: string) => Promise<Response>, signal: AbortSignal) {
    const token = await tokenOf(signal);
    try {
      return await exchange(() => request(token), answers);
    } catch (error) {
      if (!isAppError(error) || error.details?.status !== UNAUTHORIZED_STATUS) throw error;
      cached = undefined;
      const again = await tokenOf(signal);
      return exchange(() => request(again), answers);
    }
  }

  return async ({ firstName, lastName, companyDomain }) => {
    const signal = AbortSignal.timeout(budgetMs);
    const bearer = (token: string) => ({ accept: JSON_TYPE, authorization: `${BEARER} ${token}` });
    const rows = [{ first_name: firstName, last_name: lastName, domain: companyDomain }];
    const started = await authed(
      (token) =>
        fetch(new URL(START_PATH, origin), {
          method: "POST",
          headers: { ...bearer(token), "content-type": JSON_TYPE },
          body: JSON.stringify({ rows }),
          redirect: "manual",
          signal,
        }),
      signal,
    );
    const { data, meta } = shaped(startAnswer, started);
    const taskHash = data?.task_hash ?? meta?.task_hash;
    if (taskHash === undefined) throw providerError({ reason: "off_shape" });
    const url = new URL(RESULT_PATH, origin);
    url.searchParams.set("task_hash", taskHash);
    for (;;) {
      await delay(pollMs, undefined, { signal }).catch(() => {
        throw providerError({ reason: "not_ready" });
      });
      const result = await authed(
        (token) => fetch(url, { headers: bearer(token), redirect: "manual", signal }),
        signal,
      );
      const { status } = shaped(resultAnswer, result);
      if (status === TASK_STATUS.completed) return result;
      if (status === TASK_STATUS.noCredits) {
        throw new AppError(errors.finder_allowance_spent, { details: { status: 200 } });
      }
      if (status !== TASK_STATUS.inProgress) throw providerError({ reason: "off_shape" });
    }
  };
}

/** The token call's own reading: an OAuth error naming a refused client is unauthorized, whatever its status. */
function refusedClient(_status: number, text: string): Reading | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    return typeof error === "string" && REFUSED_CLIENT.has(error)
      ? "finder_unauthorized"
      : undefined;
  } catch {
    return undefined;
  }
}
