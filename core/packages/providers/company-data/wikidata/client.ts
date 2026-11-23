// The wikidata adapter's HTTP client (README.md "Calls"): Node's fetch from this folder only, to the
// query service and the API, the exception docs/rules/security.md §5 makes for a vendor adapter. No
// key: every request carries the User-Agent with WIKIDATA_CONTACT, as Wikimedia's policy asks. At
// most one request a second per process: the gate starts a request a second after the last one
// started. The answer is read as ../answer.ts reads every vendor's: no redirect, a bounded body, a
// failure in the port's codes; no retry here.
import { setTimeout as sleep } from "node:timers/promises";
import { exchange } from "../answer.ts";
import {
  FORM,
  JSON_TYPE,
  MAX_ANSWER_BYTES,
  MIN_INTERVAL_MS,
  PRODUCT,
  RETRY_AFTER_SEC,
  SEARCH,
  SPARQL_JSON,
  TIMEOUT_MS,
} from "./constants.ts";

export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
};
/** Runs a request once its turn comes: its start at least the interval after the last start. */
export type Gate = <T>(request: () => Promise<T>) => Promise<T>;

/** A gate that spaces the requests' starts by `intervalMs`, in the order they asked. */
export function spacedGate(intervalMs: number, clock: Clock): Gate {
  let last = Number.NEGATIVE_INFINITY;
  let queue: Promise<void> = Promise.resolve();
  return (request) => {
    const turn = queue.then(async () => {
      for (let wait = last + intervalMs - clock.now(); wait > 0; ) {
        await clock.sleep(wait);
        wait = last + intervalMs - clock.now();
      }
    });
    queue = turn;
    return turn.then(() => {
      try {
        return request();
      } finally {
        // After the request started, so that the next one starts a full interval after it.
        last = clock.now();
      }
    });
  };
}

/** The process's gate: every wikidata adapter of the process waits its turn on it. */
export const processGate = spacedGate(MIN_INTERVAL_MS, { now: Date.now, sleep });

export type WikidataClient = {
  /** The query service's answer to a SPARQL query, as JSON. */
  readonly sparql: (query: string) => Promise<unknown>;
  /** The API's wbsearchentities answer for a name, as JSON. */
  readonly search: (name: string) => Promise<unknown>;
};

export function wikidataClient(options: {
  readonly contact: string;
  readonly sparqlUrl: string;
  readonly apiUrl: string;
  readonly gate: Gate;
  readonly now: () => number;
}): WikidataClient {
  const { contact, sparqlUrl, apiUrl, gate, now } = options;
  const userAgent = `${PRODUCT} (${contact})`;
  const answers = { maxBytes: MAX_ANSWER_BYTES, retryAfterSec: RETRY_AFTER_SEC, now };
  const send = (url: URL | string, init: RequestInit) =>
    gate(() =>
      exchange(
        () => fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }),
        answers,
      ),
    );
  return {
    sparql: (query) =>
      send(sparqlUrl, {
        method: "POST",
        headers: { accept: SPARQL_JSON, "content-type": FORM, "user-agent": userAgent },
        body: new URLSearchParams({ query }).toString(),
      }),
    search: (name) => {
      const url = new URL(apiUrl);
      for (const [key, value] of Object.entries({ ...SEARCH, search: name })) {
        url.searchParams.set(key, value);
      }
      return send(url, { headers: { accept: JSON_TYPE, "user-agent": userAgent } });
    },
  };
}
