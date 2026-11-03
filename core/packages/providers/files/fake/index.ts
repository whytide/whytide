// The files port's fake (../../README.md "The fake"): the files in memory by whole key, behind the
// same guard as every adapter; the module tests and the Compose smoke test run on it.
import { Readable } from "node:stream";
import { AppError } from "@whytide/platform";
import { createFake, defineAdapter } from "../../_pattern/index.ts";
import { fileBytes } from "../body.ts";
import { fileKey, filePrefix, filesPort } from "../port.ts";

type Stored = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly modifiedAt: Date;
};

export const filesFake = createFake(filesPort, {
  state: () => ({ files: new Map<string, Stored>() }),
  methods: (fake) => {
    const stored = (workspaceId: string, key: string) => {
      const whole = fileKey(workspaceId, key);
      const file = fake.state.files.get(whole);
      if (!file) throw new AppError(filesPort.errors.files_not_found);
      return { whole, file };
    };
    return {
      put: async ({ workspaceId, key, body, contentType, maxBytes }) => {
        const whole = fileKey(workspaceId, key);
        const bytes = await fileBytes(body, maxBytes); // a copy: the caller may reuse its buffer
        fake.state.files.set(whole, { bytes, contentType, modifiedAt: new Date() });
        return { key: whole, size: bytes.byteLength };
      },
      get: async ({ workspaceId, key }) => {
        const { whole, file } = stored(workspaceId, key);
        const body = Readable.from([file.bytes], { objectMode: false });
        return { key: whole, body, contentType: file.contentType, size: file.bytes.byteLength };
      },
      delete: async ({ workspaceId, key }) => {
        fake.state.files.delete(fileKey(workspaceId, key));
      },
      presignDownload: async ({ workspaceId, key, ttl }) => ({
        url: `https://files.fake.invalid/${stored(workspaceId, key).whole}?ttl=${ttl}`,
      }),
      list: async ({ workspaceId, prefix }) => {
        const start = filePrefix(workspaceId, prefix);
        const files = [...fake.state.files]
          .filter(([key]) => key.startsWith(start))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, file]) => ({
            key,
            size: file.bytes.byteLength,
            modifiedAt: file.modifiedAt,
          }));
        return { files };
      },
    };
  },
});

export const filesFakeAdapter = defineAdapter(filesPort, { name: "fake", create: () => filesFake });
