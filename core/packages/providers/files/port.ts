// The files port (docs/architecture.md §7.1, §9; docs/rules/coding.md §5): files through the S3 API
// only, each under its workspace's folder `w/<workspaceId>/`. S3 keys are literal strings, so the
// guard, fileKey() and filePrefix(), is the boundary, not the store: every adapter calls it before
// anything else, and the contract suite proves each one does. The lifecycle hints say how long at
// most a file under a prefix lives; an adapter applies them where its store can (README.md).
import { Readable } from "node:stream";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";

export { filesConfig } from "./config.ts";

const WORKSPACE_ID = /^wsp_[0-9A-Za-z]{1,64}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** S3's limit in bytes; a guarded key is ASCII. */
const MAX_KEY = 1024;
/** A file name's limit on MinIO's disks; the guard holds every store to it. */
const MAX_SEGMENT = 255;
/** `type/subtype` and its parameters in printable ASCII, so no line break reaches a header. */
const MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?: *;[ -~]*)?$/;
/** The most bytes `put` reads, since it holds the body in memory (README.md "Bodies"). */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

/** What `put` takes; `get` returns a Readable. Opaque to Zod, hence `z.custom` (README.md "Bodies"). */
export type FileBody = Uint8Array | string | Readable;
const body = z.custom<FileBody>(
  (value) => typeof value === "string" || value instanceof Uint8Array || value instanceof Readable,
  "bytes, a string or a Readable",
);
const size = z.int().nonnegative();
const contentType = z.string().max(255).regex(MEDIA_TYPE, "a media type");
const maxBytes = z.int().min(1).max(FILE_MAX_BYTES).default(FILE_MAX_BYTES);
const file = { workspaceId: z.string().regex(WORKSPACE_ID, "a workspace id"), key: z.string() };

export const filesPort = definePort({
  name: "files",
  methods: {
    put: {
      input: z.object({ ...file, body, contentType, maxBytes }),
      output: z.strictObject({ key: z.string(), size }),
    },
    get: {
      input: z.object(file),
      output: z.strictObject({
        key: z.string(),
        body: z.custom<Readable>((value) => value instanceof Readable, "a Readable"),
        contentType: z.string(),
        size,
      }),
    },
    delete: { input: z.object(file), output: z.void() },
    presignDownload: {
      // Seconds, a day at most until a caller needs more; a SigV4 signature lives seven.
      input: z.object({ ...file, ttl: z.int().min(1).max(86_400) }),
      output: z.strictObject({ url: z.url() }),
    },
    list: {
      input: z.object({ workspaceId: file.workspaceId, prefix: z.string().default("") }),
      output: z.strictObject({
        files: z.array(z.strictObject({ key: z.string(), size, modifiedAt: z.date() })),
      }),
    },
  },
  errors: {
    files_key_outside_workspace: { status: 400 },
    files_not_found: {},
    files_too_large: { status: 413 },
  },
});

/** Hours a file lives at most under each first-level prefix; elsewhere it stays until deleted. */
export const filesLifecycle: Readonly<Record<string, number>> = {
  "raw/": 72,
  "exports/": 7 * 24,
  "imports/": 30 * 24,
};

/** `w/<workspaceId>/<key>` for a key relative to the workspace's folder, or the whole key back. */
export function fileKey(workspaceId: string, key: string): string {
  return guard(workspaceId, key, false);
}

/** The same for a listing prefix, which may also be empty (the whole folder) or end in `/`. */
export function filePrefix(workspaceId: string, prefix: string): string {
  return guard(workspaceId, prefix, true);
}

function guard(workspaceId: string, key: string, prefix: boolean): string {
  const refuse = (reason: string) =>
    new AppError(filesPort.errors.files_key_outside_workspace, { details: { reason } });
  if (!WORKSPACE_ID.test(workspaceId)) throw refuse("not a workspace id");
  const folder = `w/${workspaceId}/`;
  const whole = key === "w" || key.startsWith("w/");
  if (whole && !key.startsWith(folder)) throw refuse("not this workspace's folder");
  const rest = whole ? key.slice(folder.length) : key;
  if (!(prefix && rest === "")) {
    const path = prefix && rest.endsWith("/") ? rest.slice(0, -1) : rest;
    for (const segment of path.split("/")) {
      if (segment === "") throw refuse("an empty segment");
      if (segment === "." || segment === "..") throw refuse("a . or .. segment");
      if (!SEGMENT.test(segment))
        throw refuse("a character other than letters, digits, ., _ and -");
      if (segment.length > MAX_SEGMENT) throw refuse("a segment longer than 255 characters");
    }
  }
  if (folder.length + rest.length > MAX_KEY) throw refuse("longer than 1024 characters");
  return folder + rest;
}
