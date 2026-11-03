// The files port's contract (../README.md "The contract suite"): what every adapter does, run by each
// adapter's tests/contract.test.ts, the fake's included. Each case works in fresh workspaces of its
// own, emptied when it ends, so the s3 suite leaves the slice's bucket as it found it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import { isAppError } from "@whytide/platform";
import type { PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import { FILE_MAX_BYTES, type FileBody, type filesPort } from "./port.ts";

type Files = PortInstance<typeof filesPort>;

/** A fresh workspace id for one case; its files are deleted when the case ends. */
export function testWorkspace(files: Files, t: TestContext): string {
  const workspaceId = `wsp_test${randomBytes(6).toString("hex")}`;
  t.after(async () => {
    for (const { key } of (await files.list({ workspaceId })).files) {
      await files.delete({ workspaceId, key });
    }
  });
  return workspaceId;
}

const fails = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
const csv = "a,b\n1,2\n";

export const filesCases: ContractCases<typeof filesPort> = {
  "put, then get by the relative or the whole key: bytes, type and size under w/<workspaceId>/":
    async (files, t) => {
      const workspaceId = testWorkspace(files, t);
      const put = await files.put({
        workspaceId,
        key: "imports/job_1.csv",
        body: Buffer.from(csv),
        contentType: "text/csv",
      });
      assert.deepEqual(put, { key: `w/${workspaceId}/imports/job_1.csv`, size: 8 });
      for (const key of ["imports/job_1.csv", put.key]) {
        const { body, ...file } = await files.get({ workspaceId, key });
        assert.deepEqual(
          { ...file, text: await text(body) },
          { key: put.key, contentType: "text/csv", size: 8, text: csv },
        );
      }
    },
  "put takes a string as UTF-8 and a stream; a second put replaces the file": async (files, t) => {
    const workspaceId = testWorkspace(files, t);
    const key = "exports/golden-set.jsonl";
    await files.put({ workspaceId, key, body: '{"é":1}\n', contentType: "application/x-ndjson" });
    const first = await files.get({ workspaceId, key }); // a body is read or destroyed
    assert.deepEqual([first.size, await text(first.body)], [9, '{"é":1}\n']);
    const stream = Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]);
    const contentType = "text/plain; charset=utf-8";
    const put = await files.put({ workspaceId, key, body: stream, contentType });
    assert.equal(put.size, 4);
    const file = await files.get({ workspaceId, key });
    assert.deepEqual([file.contentType, await text(file.body)], [contentType, "a\nb\n"]);
  },
  "put stops at FILE_MAX_BYTES or a lower maxBytes: files_too_large": async (files, t) => {
    const workspaceId = testWorkspace(files, t);
    const put = (body: FileBody, maxBytes?: number) =>
      files.put({ workspaceId, key: "imports/a.csv", body, contentType: "text/csv", maxBytes });
    const stream = () => Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]);
    for (const body of [csv, Buffer.from(csv), stream()]) {
      await assert.rejects(put(body, 7), fails("files_too_large"));
    }
    const large = Readable.from(Array(64).fill(Buffer.alloc(1024 * 1024))); // 64 MiB
    await assert.rejects(put(large), fails("files_too_large"));
    assert.ok(large.destroyed && !large.readableEnded); // read no further than the cap
    await assert.rejects(put(csv, FILE_MAX_BYTES + 1), fails("files_input_invalid"));
    assert.deepEqual((await files.list({ workspaceId })).files, []);
    assert.equal((await put(stream(), 8)).size, 8);
  },
  "contentType is a media type of at most 255 printable ASCII characters": async (files, t) => {
    const workspaceId = testWorkspace(files, t);
    const types = ["text/csv\r\nX-Injected: 1", "téxt/csv", "csv", `text/${"x".repeat(251)}`];
    for (const contentType of types) {
      const put = files.put({ workspaceId, key: "exports/e.csv", body: csv, contentType });
      await assert.rejects(put, fails("files_input_invalid"), contentType);
    }
  },
  "a key outside w/<workspaceId>/ is files_key_outside_workspace, and nothing is written": async (
    files,
    t,
  ) => {
    const [workspaceId, other] = [testWorkspace(files, t), testWorkspace(files, t)];
    for (const key of [`w/${other}/imports/a.csv`, "../a.csv", "/a.csv", "imports/../../a.csv"]) {
      const put = files.put({ workspaceId, key, body: csv, contentType: "text/csv" });
      await assert.rejects(put, fails("files_key_outside_workspace"), key);
    }
    const lists = [workspaceId, other].map(
      async (id) => (await files.list({ workspaceId: id })).files,
    );
    assert.deepEqual(await Promise.all(lists), [[], []]);
  },
  "workspace B does not reach workspace A's file: files_not_found": async (files, t) => {
    const [a, b] = [testWorkspace(files, t), testWorkspace(files, t)];
    const key = "raw/signals/run_1/1.json";
    await files.put({ workspaceId: a, key, body: "{}", contentType: "application/json" });
    await assert.rejects(files.get({ workspaceId: b, key }), fails("files_not_found"));
    const presign = files.presignDownload({ workspaceId: b, key, ttl: 60 });
    await assert.rejects(presign, fails("files_not_found"));
    assert.deepEqual((await files.list({ workspaceId: b })).files, []);
  },
  "every method refuses a key outside the workspace, A's whole key from B": async (files, t) => {
    const [a, b] = [testWorkspace(files, t), testWorkspace(files, t)];
    const file = { workspaceId: a, key: "exports/e.csv", body: csv, contentType: "text/csv" };
    const { key } = await files.put(file);
    const outside = fails("files_key_outside_workspace");
    for (const bad of [key, "../e.csv", "/e.csv"]) {
      await assert.rejects(files.get({ workspaceId: b, key: bad }), outside, bad);
      await assert.rejects(files.delete({ workspaceId: b, key: bad }), outside, bad);
      const presign = files.presignDownload({ workspaceId: b, key: bad, ttl: 60 });
      await assert.rejects(presign, outside, bad);
    }
    for (const prefix of [`w/${a}/`, "../", "/"]) {
      await assert.rejects(files.list({ workspaceId: b, prefix }), outside, prefix);
    }
    assert.equal((await files.list({ workspaceId: a })).files.length, 1);
  },
  "list: the workspace's files under a prefix, sorted by key": async (files, t) => {
    const workspaceId = testWorkspace(files, t);
    for (const key of ["imports/b.csv", "exports/c.csv", "imports/a.csv"]) {
      await files.put({ workspaceId, key, body: csv, contentType: "text/csv" });
    }
    const listed = async (prefix?: string) => (await files.list({ workspaceId, prefix })).files;
    const keys = async (prefix?: string) => (await listed(prefix)).map((file) => file.key);
    const under = (key: string) => `w/${workspaceId}/${key}`;
    assert.deepEqual(await keys("imports/"), [under("imports/a.csv"), under("imports/b.csv")]);
    assert.deepEqual(await keys(), ["exports/c.csv", "imports/a.csv", "imports/b.csv"].map(under));
    const [first] = await listed("exports/");
    assert.ok(first?.size === 8 && first.modifiedAt instanceof Date);
  },
  "delete removes the file, and deleting a missing file is no error": async (files, t) => {
    const workspaceId = testWorkspace(files, t);
    const key = "exports/e.csv";
    await files.put({ workspaceId, key, body: csv, contentType: "text/csv" });
    await files.delete({ workspaceId, key });
    await files.delete({ workspaceId, key });
    await assert.rejects(files.get({ workspaceId, key }), fails("files_not_found"));
  },
  "presignDownload: a URL for a file the workspace holds, files_not_found otherwise": async (
    files,
    t,
  ) => {
    const workspaceId = testWorkspace(files, t);
    await files.put({ workspaceId, key: "exports/e.csv", body: csv, contentType: "text/csv" });
    const { url } = await files.presignDownload({ workspaceId, key: "exports/e.csv", ttl: 60 });
    assert.ok(url.includes(`w/${workspaceId}/exports/e.csv`), url);
    const missing = files.presignDownload({ workspaceId, key: "exports/none.csv", ttl: 60 });
    await assert.rejects(missing, fails("files_not_found"));
    const long = files.presignDownload({ workspaceId, key: "exports/e.csv", ttl: 86_401 });
    await assert.rejects(long, fails("files_input_invalid"));
  },
};
