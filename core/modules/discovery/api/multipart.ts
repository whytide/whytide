// The upload's body (README.md "POST …/imports"; docs/security.md): multipart/form-data with one part,
// the file, named *.csv, read with busboy as it arrives. busboy holds the file to its limit and
// refuses any field and a second part; it has no limit on the whole body, so the request's bytes are
// counted here against the route's, and the whole body has two minutes. The first refusal stops the
// reading of the request: nothing more is read, the parser and its file are destroyed, and the route
// answers with the connection closing (api/imports.controller.ts).
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { BadRequestException, RequestTimeoutException } from "@nestjs/common";
import { AppError } from "@whytide/platform";
import busboy from "busboy";
import { errors } from "../errors.ts";

/** How long the whole body may take. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** The file's bytes, and the body's, framing and other parts included. */
export type UploadLimits = { readonly fileBytes: number; readonly bodyBytes: number };
export type FilePart = { readonly name: string; readonly stream: Readable };

/**
 * Reads the request's file with `read` and the rest of its body; settles when both are done, or at
 * the first refusal: a body that is not multipart/form-data or has no file named *.csv, a field or a
 * second part (import_unsupported_type), a file or a body over its limit (import_too_large), a
 * request that broke off (400) or ran out of time (408), or what `read` threw.
 */
export function receiveFile<T>(
  req: IncomingMessage,
  limits: UploadLimits,
  read: (file: FilePart) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unsupported = () => new AppError(errors.import_unsupported_type);
    const tooLarge = () => new AppError(errors.import_too_large);
    let parser: busboy.Busboy | undefined;
    let settled = false;
    let parsed = false;
    let file = false;
    let value: { readonly read: T } | undefined;
    let received = 0;
    const end = () => {
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      end();
      req.pause();
      // On the next tick: busboy calls fail() from its own events, and goes on with the part after them.
      const stopped = parser;
      if (stopped !== undefined) process.nextTick(() => stopped.destroy());
      reject(error);
    };
    const succeed = () => {
      if (settled || !parsed || value === undefined) return;
      end();
      resolve(value.read);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limits.bodyBytes) return fail(tooLarge());
      if (parser?.write(chunk) === false) {
        req.pause();
        parser.once("drain", () => settled || req.resume());
      }
    };
    const timer = setTimeout(() => fail(new RequestTimeoutException()), UPLOAD_TIMEOUT_MS);

    const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (type !== "multipart/form-data") return fail(unsupported());
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        // A file of exactly fileSize bytes is marked truncated: one more than the limit is over it.
        limits: {
          files: 1,
          fields: 0,
          parts: 2,
          fileSize: limits.fileBytes + 1,
          fieldSize: 1024,
          headerPairs: 16,
        },
      });
    } catch {
      // No boundary, say.
      return fail(unsupported());
    }
    parser.on("file", (_field, stream: Readable & { truncated?: boolean }, info) => {
      stream.on("error", () => fail(unsupported()));
      stream.on("limit", () => fail(tooLarge()));
      file = true;
      const name = info.filename ?? "";
      // A refused file is never read: fail() destroys the parser and the file with it.
      if (!/\.csv$/i.test(name)) return fail(unsupported());
      read({ name, stream }).then((result) => {
        if (stream.truncated) return fail(tooLarge());
        value = { read: result };
        succeed();
      }, fail);
    });
    for (const limit of ["filesLimit", "fieldsLimit", "partsLimit"]) {
      parser.on(limit, () => fail(unsupported()));
    }
    parser.on("error", () => fail(unsupported()));
    parser.on("close", () => {
      parsed = true;
      if (!file) fail(unsupported());
      succeed();
    });
    req.on("data", onData);
    req.on("end", () => settled || parser?.end());
    req.on("error", () => fail(new BadRequestException()));
    req.on("close", () => req.readableEnded || fail(new BadRequestException()));
  });
}
