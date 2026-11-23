// The place list's build (README "The place list"; scripts/places-build.ts) on three tiny synthetic
// GeoNames files: what it keeps of each, the CRLF lines of countryInfo.txt, the date on the first
// line; run in a child process under Node's permission model, it reads only those three files and
// its own sources, and reaches no network. The committed list names its source and its date.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FOLDER = here("fixtures/geonames");
const SCRIPT = here("../scripts/places-build.ts");
const OUT_DIR = here("../.tmp/places-build");
const OUT = `${OUT_DIR}/places.tsv.gz`;
const FILES = ["cities15000.txt", "admin1CodesASCII.txt", "countryInfo.txt"];

/** The permission flags of the build's run: its sources and the three files read, OUT written. */
const FLAGS = [
  "--permission",
  ...[
    SCRIPT,
    here("../scripts/constants.ts"),
    here("../domain/constants.ts"),
    here("../package.json"),
    ...FILES.map((file) => `${FOLDER}/${file}`),
  ].map((path) => `--allow-fs-read=${path}`),
  `--allow-fs-write=${OUT}`,
];
/** The script in a child process under FLAGS: a network call or another read would fail it. */
const build = (...args: string[]) =>
  execFileSync(process.execPath, [...FLAGS, SCRIPT, FOLDER, "--out", OUT, ...args], {
    encoding: "utf8",
  });
const lines = () => gunzipSync(readFileSync(OUT)).toString("utf8").split("\n");

test("places:build keeps each place's name, ASCII name, country, division and population, each division's code and names, of the countries countryInfo lists; the first line names the source and the date", () => {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const printed = build("--date", "2026-11-13");
  assert.equal(printed, "places_built: 2 places, 3 divisions, 2 countries\n");
  assert.deepEqual(lines(), [
    "# GeoNames (https://www.geonames.org/), CC BY 4.0: cities15000.txt, admin1CodesASCII.txt, countryInfo.txt, downloaded 2026-11-13",
    "D\tUS\tMA\tMassachusetts\t",
    "D\tCA\t08\tOntario\t",
    "D\tCA\t10\tQuébec\tQuebec",
    "P\tBoston\t\tUS\tMA\t653833",
    "P\tMontréal\tMontreal\tCA\t10\t1600000",
    "",
  ]);
  const again = readFileSync(OUT);
  build("--date", "2026-11-13");
  assert.deepEqual(readFileSync(OUT), again, "the same files give the same bytes");
});

test("under the build's flags, a network connection and a read of any other file are denied: the build above made none", () => {
  const probe = `
    const denied = (fn) => { try { fn(); return "allowed"; } catch (error) { return error.code; } };
    const read = denied(() => require("node:fs").readFileSync(${JSON.stringify(here("../README.md"))}));
    require("node:net").connect(443, "127.0.0.1").on("error", (error) => console.log(read, error.code));`;
  const printed = execFileSync(process.execPath, [...FLAGS, "-e", probe], { encoding: "utf8" });
  assert.equal(printed, "ERR_ACCESS_DENIED ERR_ACCESS_DENIED\n");
});

test("places:build refuses a call without its folder or with a date off its form, with the usage", () => {
  for (const args of [[], [FOLDER, "--date", "13/11/2026"], [FOLDER, "--unknown"]]) {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }),
      (error: { status?: number; stdout?: string }) =>
        error.status === 2 && /^usage: pnpm -F contacts places:build/.test(error.stdout ?? ""),
    );
  }
});

test("the committed place list names GeoNames, its licence and the download date on its first line", () => {
  const text = gunzipSync(readFileSync(here("../data/places.tsv.gz"))).toString("utf8");
  const first = text.slice(0, text.indexOf("\n"));
  assert.match(
    first,
    /^# GeoNames \(https:\/\/www\.geonames\.org\/\), CC BY 4\.0: .* downloaded 2026-11-13$/,
  );
});
