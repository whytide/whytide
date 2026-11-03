# The files port

Files through the S3 API only, each under its workspace's folder `w/<workspaceId>/` ([architecture §7.1](../../../../docs/architecture.md#71-where-state-lives), [coding §5](../../../../docs/rules/coding.md#5-data)): CSV imports, exports, raw provider payloads. `PROVIDER_FILES` names the adapter: `s3` ([s3/README.md](s3/README.md)), MinIO from the shared stack in development, or `fake`, in memory. `port.ts` exports `filesPort` and `filesConfig`: a host runs `await getAdapter(filesPort, filesConfig.PROVIDER_FILES)` at start.

| Method | Takes | Gives |
|---|---|---|
| `put` | `workspaceId`, `key`, `body`, `contentType`, `maxBytes` if lower than the cap | `{ key, size }`; a second put replaces the file |
| `get` | `workspaceId`, `key` | `{ key, body, contentType, size }`, or `files_not_found` |
| `delete` | `workspaceId`, `key` | nothing; a missing file is no error, so a retried activity may delete twice |
| `presignDownload` | `workspaceId`, `key`, `ttl` in seconds, 1 to 86 400 (a day, until a caller needs more) | `{ url }`, a download that works for `ttl` seconds, or `files_not_found` |
| `list` | `workspaceId`, `prefix`, empty for the whole folder | `{ files: [{ key, size, modifiedAt }] }`, every file under the prefix, sorted by key |

## Keys

A key is relative to the workspace's folder, `imports/job_….csv`, or the whole key a method gave back, `w/<workspaceId>/imports/job_….csv`; every key a method gives is whole. `fileKey(workspaceId, key)` and `filePrefix(workspaceId, prefix)` are the guard an adapter calls before anything else, since S3 keys are literal strings and the store protects nothing: a key is segments of letters, digits, `.`, `_` and `-`, none empty, `.` or `..` or over 255 characters, at most 1 024 characters whole, and a first segment `w` names this workspace's folder only. Everything else, a leading `/`, a backslash, a percent sign, a control character, another workspace's folder, is `files_key_outside_workspace`, the reason in `details`, never the key. A workspace id is `wsp_` and letters or digits. Workspace B asking for A's relative key looks in its own folder and gets `files_not_found`.

## Bodies

`put` takes bytes (a `Buffer` is one), a string, stored as UTF-8, or a Node `Readable`, read to its end first (`size` is what was stored), all held in memory: at most `FILE_MAX_BYTES`, 25 MiB, or the lower `maxBytes` a caller gives, past which it is `files_too_large`, a stream read no further and destroyed. `contentType` is a media type, `type/subtype` and optional parameters, at most 255 printable ASCII characters. `get` gives a Node `Readable`, which the caller reads to its end or destroys; an error midway, a cut connection, reaches the reader as `files_error_unmapped`. Both bodies are `z.custom` in the schemas, the boundary's opt-out for opaque values ([../README.md](../README.md) "The boundary").

## Lifecycle

`filesLifecycle`: a file under `raw/` lives 72 hours at most ([architecture §7.6](../../../../docs/architecture.md#76-physical-rules), person-level payloads), under `exports/` 7 days, under `imports/` 30 days, elsewhere until it is deleted. A hint is a maximum: the adapter applies it where its store supports it, the fake never. S3 counts whole days and expires a file at the midnight UTC after it is that many days old, up to a day late, so the s3 adapter sets a day less: a file lives between the hint minus a day and the hint, plus the store's delay ([s3/README.md](s3/README.md)).

## Codes

`files_key_outside_workspace` (400), `files_not_found` (404) and `files_too_large` (413), plus the boundary's `files_input_invalid`, `files_output_invalid` and `files_error_unmapped`. Developer-facing: no message keys.

The port never has a public URL, a public-read bucket or object, a bucket per workspace or a key outside a workspace's folder. A new method gets its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter, each calling the guard first. Tests: `files/tests/contract.test.ts`, the guard; `contract.ts` on the fake and on `s3` (`pnpm -F providers test:contract`).
