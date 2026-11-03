// GET /health (README "Health"): on 127.0.0.1 only, since the worker has no inbound port
// (architecture §3); a container's health check runs inside it. 200 with `ok` while Temporal answers
// for the namespace within two seconds and the worker runs, else 503 with `failing`, as when the
// report itself fails.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type HealthReport = {
  readonly status: "ok" | "failing";
  readonly namespace: string;
  readonly task_queue: string;
  readonly workflow_count: number;
  readonly temporal: "connected" | "unreachable";
  /** The SDK worker's state: RUNNING, STOPPING, FAILED, … */
  readonly worker: string;
  /** The end of the outbox loop's last pass. */
  readonly last_poll_at: string | null;
};
export type HealthServer = { readonly url: string; close(): Promise<void> };

export async function startHealth(
  port: number,
  report: () => Promise<HealthReport>,
): Promise<HealthServer> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const answer = (status: number, body: object) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" }).end(text);
    };
    // A report that rejects answers 503 as well: an unhandled rejection would end the process.
    void report()
      .then((body) => answer(body.status === "ok" ? 200 : 503, body))
      .catch(() => (res.headersSent ? res.destroy() : answer(503, { status: "failing" })));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", resolve);
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}/health`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
