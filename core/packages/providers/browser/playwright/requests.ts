// One page's requests (README.md "The route filter"): each one through the platform's egress client,
// fetchSafe, which checks the URL, resolves the host once, refuses a blocked address, connects only
// to the addresses it checked and checks every redirect hop again. A page sends MAX_REQUESTS at most,
// the redirects followed included. An answer's body is MAX_RESPONSE_BYTES at most and all of them
// MAX_PAGE_BYTES: each request holds the room for a whole answer until its size is known, and waits
// for it, so that the answers never pass the page's bound. Nothing is fetched past the page's
// deadline, or once the call is over. A refusal or a failure is the port's code, with the egress
// client's code as the reason, never its error or a URL.
import {
  AppError,
  type EgressLists,
  type FetchSafeResponse,
  fetchSafe,
  isAppError,
  type Resolver,
} from "@whytide/platform";
import { browserPort } from "../port.ts";
import {
  BLOCKED_CODES,
  EGRESS_TIMEOUT,
  EGRESS_TOO_LARGE,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  MAX_REQUESTS,
  MAX_RESPONSE_BYTES,
  REASONS,
} from "./constants.ts";

const { errors } = browserPort;

/** What a test may set for the egress client: the local test site's hosts and a resolver for its names. */
export type Egress = { readonly lists?: EgressLists; readonly resolve?: Resolver };

export class PageRequests {
  readonly #egress: Egress;
  readonly #deadline: number;
  readonly #failed = Promise.withResolvers<never>();
  #waiting: (() => void)[] = [];
  #sent = 0;
  /** The bytes of the answers received, and the room held for those on their way. */
  #bytes = 0;
  #running = 0;
  #failure: AppError | undefined;
  #closed = false;

  constructor(egress: Egress, timeoutMs: number) {
    this.#egress = egress;
    this.#deadline = performance.now() + timeoutMs;
    // A failure no one races yet is no unhandled rejection.
    this.#failed.promise.catch(() => undefined);
  }

  /** The whole milliseconds left before the page's deadline. */
  left(): number {
    return Math.floor(this.#deadline - performance.now());
  }

  /** The first failure of the call: a navigation of the page's own that was refused or failed. */
  get failure(): AppError | undefined {
    return this.#failure;
  }

  /** Rejects with that failure, the moment there is one. */
  get failed(): Promise<never> {
    return this.#failed.promise;
  }

  fail(error: AppError): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#failed.reject(error);
  }

  /** The call is over: nothing more is fetched for it, the requests still waiting included. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  /** The answer to a GET of `url`, its redirects followed, or the port's code. */
  async fetch(url: string, accept?: string): Promise<FetchSafeResponse> {
    if (this.#sent >= MAX_REQUESTS) throw providerError(REASONS.requests);
    this.#sent += 1;
    const room = await this.#room();
    let used = 0;
    try {
      const answer = await fetchSafe(url, {
        maxRedirects: MAX_REDIRECTS,
        maxBytes: room,
        timeoutMs: this.left(),
        accept,
        lists: this.#egress.lists,
        resolve: this.#egress.resolve,
      });
      used = answer.body.length;
      this.#sent += answer.hops;
      return answer;
    } catch (error) {
      throw fromEgress(error);
    } finally {
      this.#running -= 1;
      this.#bytes -= room - used;
      this.#wake();
    }
  }

  /**
   * The room for the answer, held: a whole answer's, or, while no other request runs, what is
   * left of the page's. Until then the request waits; past the deadline, or once the call is
   * over, it is not sent.
   */
  async #room(): Promise<number> {
    for (;;) {
      if (this.#closed) throw providerError(REASONS.ended);
      if (this.left() <= 0) throw new AppError(errors.browser_timeout);
      const free = MAX_PAGE_BYTES - this.#bytes;
      if (free >= MAX_RESPONSE_BYTES || (this.#running === 0 && free > 0)) {
        const room = Math.min(free, MAX_RESPONSE_BYTES);
        this.#running += 1;
        this.#bytes += room;
        return room;
      }
      if (this.#running === 0) throw new AppError(errors.browser_too_large);
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
  }

  /** Each request waiting looks again: the room freed, or the call over. */
  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resume of waiting) resume();
  }
}

/** The egress client's refusal or failure as the port's code, its own code as the reason; never its cause. */
export function fromEgress(error: unknown): AppError {
  if (isAppError(error) && Object.hasOwn(errors, error.code)) return error;
  const code = isAppError(error) ? error.code : undefined;
  if (code !== undefined && BLOCKED_CODES.has(code)) {
    return new AppError(errors.browser_blocked, { details: { reason: code } });
  }
  if (code === EGRESS_TIMEOUT) return new AppError(errors.browser_timeout);
  if (code === EGRESS_TOO_LARGE) return new AppError(errors.browser_too_large);
  return providerError(code ?? REASONS.failed);
}

export const providerError = (reason: string) =>
  new AppError(errors.browser_provider_error, { details: { reason } });
