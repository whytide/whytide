// The counted web search (README "Public interface", "Allowances"): one search for every caller. The
// adapters of PROVIDER_WEB_SEARCH are asked in order, each inside its allowance, counted for the
// whole server in `source_usage` under `web-search/<adapter>`; one spent, or failing for any reason,
// passes the search to the next. The answer says which: the results with the adapter that answered,
// every adapter spent, the last failure and its code, or no adapter loaded. The request is the
// port's input as it is, so that a caller of today and one of the web research run alike. Nothing
// here names a query: the warning of a failed search holds the counter and the code only.
import { AppError, isAppError, type Logger } from "@whytide/platform";
import {
  type BoundAdapter,
  getAdapters,
  type WebResult,
  type WebSearch,
  webSearch,
  webSearchConfig,
  webSearchPort,
} from "@whytide/providers";
import { ACTIVITY_FAILED, CODE } from "./constants.ts";
import { log } from "./log.ts";
import { ADAPTER_LOAD_FAILED, counterOf, VENDOR_SPENT } from "./sources/web-search/constants.ts";
import { markSpent, reserveCall } from "./usage.ts";

/** The end of a search: answered by an adapter, or why none could. */
export type WebSearched =
  | {
      readonly status: "answered";
      readonly results: readonly WebResult[];
      readonly adapter: string;
    }
  | { readonly status: "spent" }
  | { readonly status: "failed"; readonly code: string; readonly error: unknown }
  | { readonly status: "no_adapter" };

type Adapter = { readonly name: string; readonly port: BoundAdapter<typeof webSearchPort> };

let names: readonly string[] | undefined;
let loading: Promise<readonly Adapter[]> | undefined;

/** For tests (testing/): the adapters in place of PROVIDER_WEB_SEARCH's; undefined restores it. */
export function useWebSearchAdapters(next: readonly string[] | undefined): void {
  names = next;
  loading = undefined;
}

/** The adapters, loaded once per process, each on its own: one that cannot load is left out. */
function adapters(): Promise<readonly Adapter[]> {
  loading ??= load(names ?? webSearchConfig.PROVIDER_WEB_SEARCH, log());
  return loading;
}

async function load(list: readonly string[], logger: Logger): Promise<readonly Adapter[]> {
  const loaded: Adapter[] = [];
  const leftOut: { provider: string; reason: string }[] = [];
  for (const name of list) {
    try {
      const [port] = await getAdapters(webSearchPort, [name]);
      if (port) loaded.push({ name, port });
    } catch (error) {
      leftOut.push({
        provider: name,
        reason: isAppError(error) ? error.code : ADAPTER_LOAD_FAILED,
      });
    }
  }
  if (leftOut.length > 0) {
    logger.warn(
      { variable: webSearchPort.variable, details: leftOut },
      "enrichment: names left out of the list; the worker runs the others",
    );
  }
  return loaded;
}

const codeOf = (error: unknown) =>
  isAppError(error) && CODE.test(error.code) ? error.code : ACTIVITY_FAILED;

/**
 * One search on the first adapter with room that answers; the next one asked past each spent or
 * failing one. `spent` when every adapter was spent (by its allowance or by the vendor's word),
 * else `failed` with the last failure; a request off the port's form is `failed`
 * `web_search_input_invalid`, before any reservation or call.
 */
export async function searchWeb(request: WebSearch): Promise<WebSearched> {
  // A request off the port's form is refused first: nothing is reserved, nothing is called.
  if (!webSearch.safeParse(request).success) {
    const code = webSearchPort.codes.input;
    return { status: "failed", code, error: new AppError(code) };
  }
  const list = await adapters();
  if (list.length === 0) return { status: "no_adapter" };
  let failure: { readonly code: string; readonly error: unknown } | undefined;
  for (const { name, port } of list) {
    const counter = counterOf(name);
    if (!(await reserveCall(counter, port.allowance))) continue;
    try {
      const { results } = await port.searchWeb(request);
      return { status: "answered", results, adapter: name };
    } catch (error) {
      const code = codeOf(error);
      if (code === VENDOR_SPENT) {
        await markSpent(counter, port.allowance);
        continue;
      }
      failure = { code, error };
      log().warn({ provider: counter, code }, "enrichment: a web search failed; the next is asked");
    }
  }
  return failure === undefined ? { status: "spent" } : { status: "failed", ...failure };
}
