// The webhook adapter of the alerts port (README.md): one POST of {"text": …} to the team channel's
// incoming webhook (Slack's, Discord's /slack address, a Teams workflow's) through Node's fetch, the
// exception docs/rules/security.md §5 makes for an adapter, since fetchSafe is GET only. No SDK. The
// URL is the operator's, from the server's .env, never a user's: create() runs the egress rules on it
// once and refuses http: off EGRESS_ALLOW_HOSTS. A redirect is never followed, and the answer's body
// is read up to ALERTS_ANSWER_MAX_BYTES and dropped. The URL is a secret, its path the channel's
// token: no error, detail or log line holds the URL, its path or the answer's body; an error carries
// the status, the seconds a rate limit asks for, or why nothing answered, and never a cause.
import { AppError, checkUrl, isAllowListed, isAppError } from "@whytide/platform";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { alertsPort } from "../port.ts";
import { webhookConfig } from "./config.ts";
import {
  ALERTS_ANSWER_MAX_BYTES,
  ALERTS_TIMEOUT_MS,
  CONTENT_TYPE,
  HTTPS,
  NETWORK_CODE,
  NO_ANSWER,
  RATE_LIMITED,
  REFUSALS,
  REFUSED,
  RETRY_AFTER,
  RETRY_AFTER_SECONDS,
  TAKEN,
  URL_VARIABLE,
} from "./constants.ts";

const { errors } = alertsPort;

function webhookAlerts(url: URL): PortImplementation<typeof alertsPort> {
  return {
    send: async ({ text }) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": CONTENT_TYPE },
          body: JSON.stringify({ text }),
          redirect: "manual",
          signal: AbortSignal.timeout(ALERTS_TIMEOUT_MS),
        });
      } catch (error) {
        throw unanswered(error);
      }
      await drain(response.body);
      return answered(response);
    },
  };
}

export const webhookAdapter = defineAdapter(alertsPort, {
  name: "webhook",
  requires: [URL_VARIABLE],
  create: () => webhookAlerts(webhookUrl()),
});

/** ALERTS_WEBHOOK_URL through the egress rules; a refusal names the variable and the rule, never the URL. */
function webhookUrl(): URL {
  const { ALERTS_WEBHOOK_URL: value } = webhookConfig();
  if (!value) throw refused(REFUSALS.required);
  let url: URL;
  try {
    url = checkUrl(value);
  } catch (error) {
    // checkUrl's refusals carry their rule's code and nothing of the URL.
    throw refused(isAppError(error) ? `${REFUSALS.egress} ${error.code}` : REFUSALS.unparsed);
  }
  if (url.protocol !== HTTPS && !isAllowListed(url)) throw refused(REFUSALS.insecure);
  return url;
}

const refused = (reason: string) =>
  new AppError("config_invalid", {
    details: { block: "packages/providers", variables: [`${URL_VARIABLE}: ${reason}`] },
  });

/** The answer's status as the port's words: taken, refused, a rate limit, or unreachable (a 5xx). */
function answered({ status, headers }: Response): Record<string, never> {
  if (status >= TAKEN.min && status <= TAKEN.max) return {};
  if (status === RATE_LIMITED) {
    const seconds = headers.get(RETRY_AFTER)?.trim() ?? "";
    const retryAfterSec = RETRY_AFTER_SECONDS.test(seconds) ? Number(seconds) : undefined;
    const details = retryAfterSec === undefined ? { status } : { status, retryAfterSec };
    throw new AppError(errors.alerts_rate_limited, { details });
  }
  if (status >= REFUSED.min && status <= REFUSED.max) {
    throw new AppError(errors.alerts_rejected, { details: { status } });
  }
  throw new AppError(errors.alerts_unreachable, { details: { status } });
}

/** A post that got no answer: past the timeout, else the network error by its short code. */
function unanswered(error: unknown): AppError {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return new AppError(errors.alerts_unreachable, { details: { reason: NO_ANSWER.timeout } });
  }
  const code = (error as { cause?: { code?: unknown } | null } | null)?.cause?.code;
  const known = typeof code === "string" && NETWORK_CODE.test(code);
  const details = { reason: NO_ANSWER.network, ...(known ? { code } : {}) };
  return new AppError(errors.alerts_unreachable, { details });
}

/**
 * Reads the answer's body into one buffer of ALERTS_ANSWER_MAX_BYTES, a byte reader taking no more
 * than the room left, then cancels it, so nothing past that is ever read; what it read is dropped.
 * A body cut short or past the timeout changes nothing: the status has decided.
 */
async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  let reader: ReadableStreamBYOBReader | undefined;
  try {
    reader = body.getReader({ mode: "byob" });
    let buffer = new ArrayBuffer(ALERTS_ANSWER_MAX_BYTES);
    let read = 0;
    while (read < ALERTS_ANSWER_MAX_BYTES) {
      const { done, value } = await reader.read(new Uint8Array(buffer, read));
      if (done || value === undefined) break;
      buffer = value.buffer as ArrayBuffer;
      read += value.byteLength;
    }
  } catch {
    // Dropped with the rest.
  } finally {
    await (reader ?? body).cancel().catch(() => undefined);
  }
}
