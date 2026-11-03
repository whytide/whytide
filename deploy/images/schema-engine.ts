// Prisma's schema engine for the images (images.md "Prisma's schema engine"), run by Dockerfile only.
// `prisma migrate deploy` runs this native binary, which Prisma otherwise downloads on first use; the
// api's image carries it instead, so a container fetches nothing at run time.
//   node schema-engine.ts fetch <commit> <gz sha256> <binary sha256> <target>
//     downloads it over HTTPS for linux/amd64, checks both hashes, writes the binary to <target>
//   node schema-engine.ts check <commit>
//     fails unless the installed Prisma names that engines commit, so a Prisma update needs a new pin
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const PLATFORM = "debian-openssl-3.0.x";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (message: string): never => {
  process.stderr.write(`schema-engine: ${message}\n`);
  process.exit(1);
};

const [mode, commit = "", ...rest] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`not an engines commit: '${commit}'`);

if (mode === "fetch") {
  const [gzSha, binarySha, target] = rest;
  if (!gzSha || !binarySha || !target)
    fail("usage: fetch <commit> <gz sha256> <binary sha256> <target>");
  // The pin is for one platform; another architecture is deferred (images.md).
  if (process.arch !== "x64") fail(`no pin for ${process.arch}: only linux/amd64 is pinned`);
  const url = `https://binaries.prisma.sh/all_commits/${commit}/${PLATFORM}/schema-engine.gz`;
  const response = await fetch(url);
  if (!response.ok || !response.url.startsWith("https://")) fail(`${url}: HTTP ${response.status}`);
  const gz = new Uint8Array(await response.arrayBuffer());
  if (sha256(gz) !== gzSha) fail(`${url}: sha256 ${sha256(gz)}, pinned ${gzSha}`);
  const binary = gunzipSync(gz);
  if (sha256(binary) !== binarySha)
    fail(`the binary: sha256 ${sha256(binary)}, pinned ${binarySha}`);
  mkdirSync(dirname(target!), { recursive: true });
  writeFileSync(target!, binary, { mode: 0o555 });
  console.log(`schema-engine ${commit} ${PLATFORM}: verified, ${binary.length} bytes`);
} else if (mode === "check") {
  const fromDb = createRequire(resolve("core/packages/db/package.json"));
  const fromPrisma = createRequire(fromDb.resolve("prisma/package.json"));
  const fromEngines = createRequire(fromPrisma.resolve("@prisma/engines/package.json"));
  const installed: string = fromEngines("@prisma/engines-version").enginesVersion;
  if (installed !== commit)
    fail(`Prisma's engines are ${installed}, the pin is ${commit}: pin it (images.md)`);
  console.log(`schema-engine: the installed Prisma names the pinned commit ${commit}`);
} else {
  fail("usage: fetch <commit> <gz sha256> <binary sha256> <target> | check <commit>");
}
