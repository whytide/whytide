// @Idempotent() (docs/security.md): a handler that spends credits or calls a provider answers once
// per Idempotency-Key, a UUID the client makes for the request and sends again on a retry; none is
// 400 idempotency_key_required. Inside the tenant run, so that the record and the handler's writes
// commit together or not at all, withIdempotency (core/packages/platform/idempotency) answers a key it
// has seen with the request's stored status and body, marked `Idempotent-Replayed: true`, and the key
// with another request with 422 idempotency_key_reused; otherwise it runs the handler and stores its
// answer for 24 hours. An error is not stored: the retry runs the handler again. The request hash
// covers the method, the path with its query and the body, its keys sorted.
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { idempotencyStore, tenantClient } from "@whytide/db";
import { AppError, type IdempotencyBody, tenantErrors, withIdempotency } from "@whytide/platform";
import { from, lastValueFrom, type Observable } from "rxjs";
import { type HostRequest, requestState } from "../request-context.ts";
import { protectionErrors } from "./errors.ts";

/** The metadata @Idempotent() sets; `pnpm openapi:build` reads it too, for the header it documents. */
export const IDEMPOTENT_METADATA = "whytide:idempotent";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const REPLAYED_HEADER = "idempotent-replayed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A handler answered once per Idempotency-Key: one that spends credits or calls a provider. */
export const Idempotent = () => SetMetadata(IDEMPOTENT_METADATA, true);

/** JSON with every object's keys sorted, so that two equal bodies hash the same; pure. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** The hash a key is stored with: method, path with query, body; pure. */
export function requestHash(request: { method: string; url: string; body: unknown }): string {
  const text = `${request.method.toUpperCase()} ${request.url}\n${canonicalJson(request.body)}`;
  return createHash("sha256").update(text).digest("hex");
}

type IdempotentRequest = HostRequest & { readonly body?: unknown; readonly originalUrl?: string };

export class IdempotencyInterceptor implements NestInterceptor {
  readonly #reflector = new Reflector();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    if (!this.#reflector.getAllAndOverride<boolean>(IDEMPOTENT_METADATA, targets)) {
      return next.handle();
    }
    const http = context.switchToHttp();
    return from(once(http.getRequest(), http.getResponse(), next));
  }
}

async function once(req: IdempotentRequest, res: ServerResponse, next: CallHandler) {
  const key = req.headers[IDEMPOTENCY_KEY_HEADER];
  if (key === undefined) throw new AppError(protectionErrors.idempotency_key_required);
  if (typeof key !== "string" || !UUID.test(key)) {
    throw new AppError("invalid_idempotency_key", { details: { fields: ["key"] } });
  }
  const { tenant } = requestState(req);
  if (!tenant) throw new AppError(tenantErrors.no_tenant_context);
  const url = req.originalUrl ?? req.url ?? "";
  const request = {
    workspaceId: tenant.workspaceId,
    key: key.toLowerCase(),
    requestHash: requestHash({ method: req.method ?? "", url, body: req.body }),
  };
  // The route's status, which NestJS set before the interceptors and sends whatever the handler does.
  const status = res.statusCode;
  const answer = await withIdempotency(idempotencyStore(tenantClient), request, async () => {
    const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    // What Express would send, as JSON, so that the first answer and a replay are the same.
    const json = JSON.stringify(body) as string | undefined;
    return { status, body: JSON.parse(json ?? "null") as IdempotencyBody };
  });
  if (answer.replayed) {
    res.statusCode = answer.status;
    res.setHeader(REPLAYED_HEADER, "true");
  }
  return answer.body;
}
