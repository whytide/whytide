// A host for tests/egress.test.ts, run as a child process: telemetry starts first, as a host starts
// it, so node:http is instrumented when the client loads; then the client fetches the URL given as
// the argument through the allow-list of the environment, and again with lists of the caller's own:
// one widening, one narrowing, and a getter that would widen on a second read. The last stdout line
// is a JSON report.
import type { EgressLists } from "../../../http/index.ts";
import { startTelemetry } from "../../../telemetry/index.ts";

const telemetry = startTelemetry({ serviceName: "fixture-egress" });
const { isAppError } = await import("../../../errors/index.ts");
const { fetchSafe, parseHostList } = await import("../../../http/index.ts");
const url = new URL(process.argv[2] ?? "");
const response = await fetchSafe(url, { maxRedirects: 1 });
const codeOf = (lists: EgressLists, target: URL | string = url) =>
  fetchSafe(target, { maxRedirects: 1, lists }).then(
    () => "fetched",
    (error: unknown) => (isAppError(error) ? error.code : "error"),
  );
const widened = await codeOf({ allowHosts: parseHostList(url.host) });
const narrowed = await codeOf({ denyHosts: parseHostList(url.hostname) });
let reads = 0;
const twoFaced = {
  get allowHosts() {
    reads += 1; // nothing to the production check, then a list that opens localhost
    return reads === 1 ? undefined : parseHostList(`localhost:${url.port}`);
  },
};
const getter = await codeOf(twoFaced, `http://localhost:${url.port}/hop/0`);
await telemetry.shutdown();
const { status, hops } = response;
process.stdout.write(`${JSON.stringify({ status, hops, widened, narrowed, getter })}\n`);
