// The error filter (docs/request-path.md): every error a request meets, in a guard, a pipe, a handler
// or a middleware ahead of the routes (the authentication handler's or a protection's next(error)),
// answers `{ code, details }` with the code's status, the details below 500 only. An HTTP error of
// NestJS or of the body parser keeps its status under a code of ours; anything else is 500
// internal_error. Never a message or a stack trace, in any environment: a 5xx is logged instead, with
// the error's type, code and frames (the platform's logger keeps no message but an AppError's).
import type { ServerResponse } from "node:http";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { isAppError, type Logger } from "@whytide/platform";
import { hostErrors } from "./errors.ts";
import { type HostRequest, requestState } from "./request-context.ts";

export type ErrorBody = { readonly code: string; readonly details?: Record<string, unknown> };
export type ErrorResponse = { readonly status: number; readonly body: ErrorBody };

/** The codes of the HTTP errors that are not ours, by status. */
const HTTP_CODES: Readonly<Record<number, string>> = { 404: "not_found", 413: "payload_too_large" };

/** The answer to an error; pure, the unit test's subject. */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (isAppError(error)) {
    const { code, status, details } = error;
    return { status, body: details !== undefined && status < 500 ? { code, details } : { code } };
  }
  const status = httpStatusOf(error);
  const code = HTTP_CODES[status] ?? (status < 500 ? "invalid_request" : hostErrors.internal_error);
  return { status, body: { code } };
}

/** A NestJS HttpException's status, or a body parser error's (http-errors, `expose` when 4xx); else 500. */
function httpStatusOf(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  const { status, expose } = (error ?? {}) as { status?: unknown; expose?: unknown };
  return typeof status === "number" && status >= 400 && status < 500 && expose === true
    ? status
    : 500;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<ServerResponse>();
    const { status, body } = toErrorResponse(error);
    const state = requestState(http.getRequest<HostRequest>());
    state.code = body.code;
    if (status >= 500) {
      this.#log.error({ err: error, request_id: state.requestId, status }, "api: request failed");
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}
