// Module webhooks (README "Modules"): POST /v1/<module>/webhooks/<provider> for a module that exports
// `webhooks`, a vendor's call outside the workspaces. No session, no workspace and no tenant run: the
// module finds its account itself, then opens a run (core/modules/linkedin/docs/security.md). Counted
// per client address (`webhook`, RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN); the body read raw, `bodyLimit`
// bytes at most (413), with no Content-Encoding (415), and handed to `receive`, which checks the
// vendor's signature. 204 once it resolves; an error goes on to the error filter.
import type { IncomingMessage, ServerResponse } from "node:http";
import { PayloadTooLargeException, UnsupportedMediaTypeException } from "@nestjs/common";
import { readAtMost } from "./protection/body.ts";
import { addressKey, type RateLimiter } from "./protection/rate-limit.ts";

/** A module's `webhooks` export. */
export type ModuleWebhooks = {
  readonly bodyLimit: number;
  receive(input: {
    readonly provider: string;
    readonly headers: IncomingMessage["headers"];
    readonly rawBody: Uint8Array;
  }): Promise<void>;
};

/** `/v1/<module>/webhooks/<provider>`, lower case, no query. */
const ROUTE = /^\/v1\/([a-z][a-z0-9-]*)\/webhooks\/([a-z][a-z0-9-]*)$/;

/** The middleware, mounted ahead of the routes: any other request goes on. */
export function moduleWebhooks(
  byModule: ReadonlyMap<string, ModuleWebhooks>,
  limiter: RateLimiter,
) {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const [, module = "", provider = ""] = ROUTE.exec(req.url ?? "") ?? [];
    const hooks = byModule.get(module);
    if (!hooks || req.method !== "POST") return next();
    receive(req, res, limiter, hooks, provider).then(
      () => void res.writeHead(204).end(),
      (error: unknown) => {
        // The rest of the body is never read: the connection ends with the answer.
        if (!res.headersSent) res.setHeader("connection", "close");
        next(error);
      },
    );
  };
}

async function receive(
  req: IncomingMessage,
  res: ServerResponse,
  limiter: RateLimiter,
  hooks: ModuleWebhooks,
  provider: string,
): Promise<void> {
  await limiter.enforce("webhook", addressKey(req), res);
  const encoding = req.headers["content-encoding"]?.trim().toLowerCase() ?? "identity";
  if (encoding !== "identity") throw new UnsupportedMediaTypeException();
  if (Number(req.headers["content-length"] ?? 0) > hooks.bodyLimit) {
    throw new PayloadTooLargeException();
  }
  const rawBody = await readAtMost(req, hooks.bodyLimit);
  await hooks.receive({ provider, headers: req.headers, rawBody });
}
