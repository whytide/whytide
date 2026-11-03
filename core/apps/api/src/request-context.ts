// The first middleware of every request (docs/request-path.md): a request id, sent back as
// X-Request-Id on every answer, and one log line when the response closes, with the method, the route
// template, the status, the duration and the workspace; never the URL, its query, a header or a body.
// The same close counts the request in the metrics (metrics.ts). The guards keep what they learn of
// the request in its state: the principal, then the tenant; the error filter, the code it answered.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger, Principal, TenantContext } from "@whytide/platform";
import { apiMetrics } from "./metrics.ts";

export const REQUEST_ID_HEADER = "x-request-id";

/** The request as the host reads it under Express: node's, with the route and parameters it matched. */
export type HostRequest = IncomingMessage & {
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly route?: { readonly path?: unknown };
};
export type RequestState = {
  readonly requestId: string;
  /** Set by the principal guard. */
  principal?: Principal;
  /** Set by the workspace guard: the workspace the URL names and the principal's membership in it. */
  tenant?: TenantContext;
  /** Set by the error filter: the code of the error answer. */
  code?: string;
};

const states = new WeakMap<IncomingMessage, RequestState>();

/** The request's state; the request-context middleware creates it before anything else runs. */
export function requestState(req: IncomingMessage): RequestState {
  let state = states.get(req);
  if (!state) {
    state = { requestId: randomUUID() };
    states.set(req, state);
  }
  return state;
}

export function requestContext(log: Logger) {
  return (req: HostRequest, res: ServerResponse, next: () => void): void => {
    const started = process.hrtime.bigint();
    const state = requestState(req);
    res.setHeader(REQUEST_ID_HEADER, state.requestId);
    res.once("close", () => {
      const route = req.route?.path;
      const line = {
        request_id: state.requestId,
        method: req.method,
        ...(typeof route === "string" ? { route } : {}),
        status: res.statusCode,
        duration_ms: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
        ...(state.tenant ? { workspace_id: state.tenant.workspaceId } : {}),
        ...(res.writableFinished ? {} : { outcome: "aborted" }),
      };
      log.info(line, "api: request");
      const labels = { method: req.method ?? "", route: line.route ?? "unmatched" };
      const { status } = line;
      apiMetrics["api.requests"].add(1, { ...labels, status, code: state.code ?? "none" });
      apiMetrics["api.request.duration"].record(line.duration_ms / 1000, labels);
    });
    next();
  };
}
