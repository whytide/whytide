// The request body (docs/security.md), read here in place of NestJS's parsers, which the host turns
// off: once the guards passed, before the tenant run, with the route's limit. JSON only, 1 MB unless
// the route says @BodyLimit(bytes); over it, 413 payload_too_large, at once when Content-Length says
// so, otherwise as soon as the bytes read pass it, and the rest is never read: the answer closes the
// connection. multipart/form-data reaches a route that declares @Multipart() only, unread, for its
// own streaming parser, which keeps to the same limit (alpha-p5-030). Any other body, a charset but
// UTF-8 or a Content-Encoding is 415. The handler gets the value as @Body() and the bytes as
// req.rawBody, for a signature check.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type HttpException,
  type NestInterceptor,
  PayloadTooLargeException,
  SetMetadata,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { from, type Observable, switchMap } from "rxjs";

export const JSON_BODY_LIMIT = 1024 * 1024;
const LIMIT_METADATA = "whytide:body-limit";
const MULTIPART_METADATA = "whytide:multipart";
/** A route's own body limit in bytes, in place of JSON_BODY_LIMIT. */
export const BodyLimit = (bytes: number) => SetMetadata(LIMIT_METADATA, bytes);
/** A route that takes multipart/form-data and parses it itself. */
export const Multipart = () => SetMetadata(MULTIPART_METADATA, true);

type BodyRequest = IncomingMessage & { body?: unknown; rawBody?: Buffer };
type Route = { readonly limit: number; readonly multipart: boolean };

export class BodyInterceptor implements NestInterceptor {
  readonly #reflector = new Reflector();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    const read = <T>(key: string) => this.#reflector.getAllAndOverride<T | undefined>(key, targets);
    const route = {
      limit: read<number>(LIMIT_METADATA) ?? JSON_BODY_LIMIT,
      multipart: read<boolean>(MULTIPART_METADATA) === true,
    };
    const http = context.switchToHttp();
    const body = readBody(
      http.getRequest<BodyRequest>(),
      http.getResponse<ServerResponse>(),
      route,
    );
    return from(body).pipe(switchMap(() => next.handle()));
  }
}

async function readBody(req: BodyRequest, res: ServerResponse, route: Route): Promise<void> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (req.headers["transfer-encoding"] === undefined && !(declared > 0)) return;
  const refuse = (error: HttpException) => {
    // Nothing more of the request is read: the connection ends with the answer.
    if (!res.headersSent) res.setHeader("connection", "close");
    return error;
  };
  const { essence, charset } = mediaType(req.headers["content-type"]);
  if (declared > route.limit) throw refuse(new PayloadTooLargeException());
  if (essence === "multipart/form-data" && route.multipart) return;
  const encoding = req.headers["content-encoding"]?.trim().toLowerCase() ?? "identity";
  const utf8 = charset === undefined || charset === "utf-8" || charset === "utf8";
  if (essence !== "application/json" || !utf8 || encoding !== "identity") {
    throw refuse(new UnsupportedMediaTypeException());
  }
  const bytes = await readAtMost(req, route.limit).catch((error: HttpException) => {
    throw refuse(error);
  });
  if (bytes.length === 0) return;
  try {
    req.body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BadRequestException();
  }
  req.rawBody = bytes;
}

/** The type and charset of a Content-Type header, lowercase. */
function mediaType(header = ""): { essence: string; charset?: string } {
  const [essence = "", ...parameters] = header.split(";").map((part) => part.trim().toLowerCase());
  const charset = parameters
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^"(.*)"$/, "$1");
  return { essence, ...(charset === undefined ? {} : { charset }) };
}

/** The request's bytes, `limit` at most: past it, the stream stops and the promise rejects, 413. */
export function readAtMost(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Read already, by something ahead of the routes: refused, not awaited.
    if (req.readableEnded) return reject(new BadRequestException());
    const chunks: Buffer[] = [];
    let received = 0;
    const settle = (error?: HttpException) => {
      req.off("data", onData).off("end", onEnd).off("error", onError).off("close", onClose);
      if (!error) return resolve(Buffer.concat(chunks, received));
      req.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) settle(new PayloadTooLargeException());
      else chunks.push(chunk);
    };
    const onEnd = () => settle();
    // The client went away or the stream broke: no answer will reach it.
    const onError = () => settle(new BadRequestException());
    const onClose = () => settle(new BadRequestException());
    req.on("data", onData).on("end", onEnd).on("error", onError).on("close", onClose);
  });
}
