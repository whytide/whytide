// put's body as bytes (README.md "Bodies") for the fake and the adapters; the package root does not
// export it, since it is no part of the port.
import { Readable } from "node:stream";
import { AppError } from "@whytide/platform";
import { type FileBody, filesPort } from "./port.ts";

/** A new buffer of at most `maxBytes`, past which files_too_large: a stream is read no further, and
 * leaving the loop destroys it. An S3 upload needs the length first. */
export async function fileBytes(body: FileBody, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body instanceof Readable ? body : [body]) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new AppError(filesPort.errors.files_too_large, { details: { limit_bytes: maxBytes } });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
