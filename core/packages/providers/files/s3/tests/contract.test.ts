// The s3 adapter's one contractSuite call (../../../README.md "The contract suite"), against the
// shared stack's MinIO and the slice's bucket from .env.local, never skipped: the port's cases, and
// what only the real store shows: the presigned URL's expiry, the lifecycle rules on the bucket and
// the tags, the variables checked before any client exists; and, on a stand-in store, a rule write
// that fails.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectTaggingCommand,
  type LifecycleRule,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { filesCases, testWorkspace } from "../../contract.ts";
import { filesPort } from "../../port.ts";

// What the environment already sets wins over the file, as for every package.
const envLocal = join(import.meta.dirname, "../../../../../../.env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);
const { lifecycleRules, s3Adapter, s3Files, s3Store } = await import("../index.ts");
const { client, bucket: Bucket } = s3Store();
const setRules = (Rules: LifecycleRule[]) =>
  client.send(
    new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules } }),
  );
/** An object as S3's XML, an element per key, for the stand-in store. */
const xml = (value: unknown): string =>
  typeof value !== "object" || value === null
    ? String(value)
    : Object.entries(value)
        .map(([name, inner]) => `<${name}>${xml(inner)}</${name}>`)
        .join("");

contractSuite(filesPort, s3Adapter, {
  ...filesCases,
  "presignDownload: the URL works for ttl seconds against MinIO, and not after": async (
    files,
    t,
  ) => {
    const workspaceId = testWorkspace(files, t);
    await files.put({ workspaceId, key: "exports/e.csv", body: "a,b\n", contentType: "text/csv" });
    const signedAt = Date.now();
    const { url } = await files.presignDownload({ workspaceId, key: "exports/e.csv", ttl: 2 });
    const now = await fetch(url);
    const disposition = now.headers.get("content-disposition");
    assert.deepEqual([now.status, disposition, await now.text()], [200, "attachment", "a,b\n"]);
    await sleep(signedAt + 3_100 - Date.now()); // the signature's time counts in whole seconds
    const late = await fetch(url);
    assert.deepEqual(
      [late.status, (await late.text()).includes("Request has expired")],
      [403, true],
    );
  },
  "a first hinted put writes a rule per hint beside the bucket's own; tags": async (_files, t) => {
    const raw = { Key: "whytide-lifecycle", Value: "raw" };
    await setRules([
      { ID: "ops-tmp", Status: "Enabled", Filter: { Prefix: "tmp/" }, Expiration: { Days: 1 } },
      {
        ID: "whytide-lifecycle-raw",
        Status: "Enabled",
        Filter: { Tag: raw },
        Expiration: { Days: 1 },
      },
    ]);
    t.after(() => setRules(lifecycleRules()));
    const fresh = bindPort(filesPort, s3Files(), { adapter: "s3" }); // a new process's first put
    const workspaceId = testWorkspace(fresh, t);
    // A file under raw/, exports/ or imports/ is tagged with that prefix; a file elsewhere is not.
    for (const key of ["raw/run_1/1.json", "exports/e.csv", "imports/i.csv", "notes/n.txt"]) {
      const put = await fresh.put({ workspaceId, key, body: "{}", contentType: "text/plain" });
      const { TagSet } = await client.send(new GetObjectTaggingCommand({ Bucket, Key: put.key }));
      const [Value] = key.split("/");
      assert.deepEqual(TagSet, Value === "notes" ? [] : [{ Key: "whytide-lifecycle", Value }], key);
    }
    const { Rules = [] } = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket }),
    );
    const rules = Rules.map((rule) => [
      rule.ID,
      rule.Filter?.Tag?.Value ?? rule.Filter?.Prefix,
      rule.Expiration?.Days,
    ]);
    assert.deepEqual(rules.sort(), [
      ["ops-tmp", "tmp/", 1],
      ["whytide-lifecycle-exports", "exports", 6],
      ["whytide-lifecycle-imports", "imports", 29],
      ["whytide-lifecycle-raw", "raw", 2],
    ]);
  },
  "stand-in: no write when ours are there; a refused one fails hinted puts": async (_files, t) => {
    let rules: string[] = []; // the store's lifecycle configuration: none, then ours
    const requests: string[] = [];
    const store = createServer((request, response) => {
      const lifecycle = request.url?.includes("?lifecycle") ?? false;
      requests.push(`${request.method} ${lifecycle ? "lifecycle" : "object"}`);
      request.resume();
      const error = (Code: string) => xml({ Error: { Code } });
      if (!lifecycle) response.writeHead(200, { etag: '"e"' }).end();
      else if (request.method === "PUT") response.writeHead(403).end(error("AccessDenied"));
      else if (!rules.length) response.writeHead(404).end(error("NoSuchLifecycleConfiguration"));
      else response.end(xml({ LifecycleConfiguration: rules.join("") }));
    });
    await new Promise<void>((resolve) => store.listen(0, "127.0.0.1", resolve));
    t.after(() => store.close().closeAllConnections());
    const S3_ENDPOINT = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
    const standIn = s3Files({ ...process.env, S3_ENDPOINT });
    const files = bindPort(filesPort, standIn, { adapter: "s3" });
    const put = (key: string) =>
      files.put({ workspaceId: "wsp_1", key, body: "{}", contentType: "application/json" });
    const denied = (error: unknown) =>
      isAppError(error) &&
      error.code === "files_error_unmapped" &&
      error.details?.code === "AccessDenied";
    await assert.rejects(put("raw/1.json"), denied);
    assert.equal((await put("notes/1.json")).size, 2);
    await assert.rejects(put("exports/1.csv"), denied);
    rules = lifecycleRules().map((Rule) => xml({ Rule }));
    assert.equal((await put("imports/1.csv")).size, 2);
    assert.deepEqual(requests, [
      ...["GET lifecycle", "PUT lifecycle"], // refused
      "PUT object", // no hint: no rules needed
      ...["GET lifecycle", "PUT lifecycle"], // the next hinted put tries again
      ...["GET lifecycle", "PUT object"], // ours there: no write
    ]);
  },
  "an empty variable is config_invalid before any client exists, never the SDK's own chain": () => {
    assert.throws(
      () => s3Store({ ...process.env, S3_ACCESS_KEY: "" }),
      (error: unknown) =>
        isAppError(error) &&
        error.code === "config_invalid" &&
        String(error.details?.variables) === "S3_ACCESS_KEY: required by the s3 adapter",
    );
  },
});
