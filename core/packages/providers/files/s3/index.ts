// The s3 adapter of the files port (README.md): any S3-compatible store through the AWS SDK, MinIO
// from the shared stack in development, the slice's bucket. Path-style requests; the credentials and
// the region go to the client, so the SDK never walks its credential chain (AWS_*, ~/.aws, the
// cloud metadata address). Before a process's first put under a hinted prefix the bucket gets one
// lifecycle rule per hint, unless it has them, matching the tag put sets on each such file.
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type LifecycleRule,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError, defineConfig, type Env, secret } from "@whytide/platform";
import { z } from "zod";
import { defineAdapter, type PortImplementation, vendorCode } from "../../_pattern/index.ts";
import { fileBytes } from "../body.ts";
import { fileKey, filePrefix, filesLifecycle, filesPort } from "../port.ts";

/** MinIO's default region, which it ignores unless configured with one (README.md). */
const REGION = "us-east-1";
/** The object tag a lifecycle rule matches, `whytide-lifecycle=raw`, and our rules' id prefix. */
const TAG = "whytide-lifecycle";

/** The client and the bucket from the adapter's variables in `env`, read when the adapter starts. */
export function s3Store(env: Env = process.env): { client: S3Client; bucket: string } {
  const variables = defineConfig(
    "packages/providers",
    {
      S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
      S3_BUCKET: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "a bucket name")
        .optional(),
      S3_ACCESS_KEY: z.string().optional(),
      S3_SECRET_KEY: secret(z.string().optional()),
    },
    env,
  );
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = variables;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    const given = { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY };
    const missing = Object.entries(given).filter(([, value]) => !value);
    throw new AppError("config_invalid", {
      details: {
        block: "packages/providers",
        variables: missing.map(([name]) => `${name}: required by the s3 adapter`),
      },
    });
  }
  const credentials = { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY };
  return {
    client: new S3Client({
      endpoint: S3_ENDPOINT,
      region: REGION,
      credentials,
      forcePathStyle: true,
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
    }),
    bucket: S3_BUCKET,
  };
}

/** The port over the store `env` names; the registry calls it once per process. */
export function s3Files(env?: Env): PortImplementation<typeof filesPort> {
  const { client, bucket: Bucket } = s3Store(env);
  let lifecycle: Promise<void> | undefined;
  return {
    put: async ({ workspaceId, key, body, contentType, maxBytes }) => {
      const Key = fileKey(workspaceId, key);
      const bytes = await fileBytes(body, maxBytes);
      const hint = Object.keys(filesLifecycle).find((at) =>
        Key.startsWith(`w/${workspaceId}/${at}`),
      );
      if (hint) {
        // Only a file the rules expire waits for them, and fails with them.
        lifecycle ??= applyLifecycle(client, Bucket).catch((error: unknown) => {
          lifecycle = undefined; // the next put tries again
          throw error;
        });
        await lifecycle;
      }
      const Tagging = hint && `${TAG}=${hint.slice(0, -1)}`;
      const upload = { Bucket, Key, Body: bytes, ContentType: contentType, Tagging };
      await client.send(new PutObjectCommand(upload));
      return { key: Key, size: bytes.byteLength };
    },
    get: async ({ workspaceId, key }) => {
      const Key = fileKey(workspaceId, key);
      const object = await found(client.send(new GetObjectCommand({ Bucket, Key })));
      // Our own stream over the SDK's: destroying it, read or not, closes the response too.
      const source = object.Body as Readable;
      const body = Readable.from(relay(source), { objectMode: false });
      body.once("close", () => source.destroy());
      const contentType = object.ContentType ?? "application/octet-stream";
      return { key: Key, body, contentType, size: object.ContentLength ?? 0 };
    },
    delete: async ({ workspaceId, key }) => {
      await client.send(new DeleteObjectCommand({ Bucket, Key: fileKey(workspaceId, key) }));
    },
    presignDownload: async ({ workspaceId, key, ttl }) => {
      const Key = fileKey(workspaceId, key);
      await found(client.send(new HeadObjectCommand({ Bucket, Key })));
      const download = new GetObjectCommand({
        Bucket,
        Key,
        ResponseContentDisposition: "attachment",
      });
      return { url: await getSignedUrl(client, download, { expiresIn: ttl }) };
    },
    list: async ({ workspaceId, prefix }) => {
      const Prefix = filePrefix(workspaceId, prefix);
      const files: { key: string; size: number; modifiedAt: Date }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }),
        );
        for (const { Key = "", Size = 0, LastModified = new Date(0) } of page.Contents ?? []) {
          files.push({ key: Key, size: Size, modifiedAt: LastModified });
        }
        ContinuationToken = page.NextContinuationToken;
      } while (ContinuationToken);
      return { files };
    },
  };
}

export const s3Adapter = defineAdapter(filesPort, { name: "s3", create: () => s3Files() });

/** `files_not_found` for a key the bucket does not hold; any other failure stays the store's. */
async function found<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    if (name === "NoSuchKey" || name === "NotFound") {
      throw new AppError(filesPort.errors.files_not_found);
    }
    throw error;
  }
}

/** One rule per hint on the tag put sets, in whole days, S3's unit, a day less than the hint and
 * rounded down (72 hours is 2 days): S3 expires a file at the midnight UTC after it is that many
 * days old, so it lives between the hint minus a day and the hint, a maximum. */
export function lifecycleRules(): LifecycleRule[] {
  return Object.entries(filesLifecycle).map(([prefix, hours]): LifecycleRule => {
    const Value = prefix.slice(0, -1);
    return {
      ID: `${TAG}-${Value}`,
      Status: "Enabled",
      Filter: { Tag: { Key: TAG, Value } },
      Expiration: { Days: Math.max(1, Math.floor(hours / 24) - 1) },
    };
  });
}

/** Our rules over the bucket's others, which stay, since the write replaces the bucket's whole set;
 * no write when ours are there already. A store without lifecycles answers NotImplemented. */
async function applyLifecycle(client: S3Client, Bucket: string): Promise<void> {
  let rules: LifecycleRule[] = [];
  try {
    rules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules ?? [];
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    if (name === "NotImplemented") return;
    if (name !== "NoSuchLifecycleConfiguration") throw error;
  }
  const ours = lifecycleRules();
  const others = rules.filter((rule) => !rule.ID?.startsWith(`${TAG}-`));
  const present = (rule: LifecycleRule) => rules.some((it) => isDeepStrictEqual(it, rule));
  if (others.length + ours.length === rules.length && ours.every(present)) return;
  const LifecycleConfiguration = { Rules: [...others, ...ours] };
  await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration }));
}

/** The SDK's stream behind ours: an error midway, a cut connection or a checksum mismatch, reaches
 * the caller as files_error_unmapped with the vendor's code, never its message. */
async function* relay(source: Readable): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of source) yield chunk as Uint8Array;
  } catch (error) {
    const details = { method: "get", code: vendorCode(error) };
    throw new AppError(filesPort.codes.error, { details });
  }
}
