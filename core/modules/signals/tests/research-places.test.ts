// The list of source types of the research plan (README.md "Web research"; gamma-wr-040): nine entries
// ship, one file each, registered by the generated list as the kinds are, every one with its label in
// messages/en.json, its two short texts and its page kind; no entry names a trade, a country or a
// language; a definition off its form, or an id twice, stops the start.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { PAGE_KINDS, PLACE_TEXT_MAX } from "../domain/research/constants.ts";
import { definePlace, type PlaceDefinition } from "../domain/research/places/_contract.ts";
import { listPlaces } from "../domain/research/places/registry.ts";
import { generatePlaceList } from "../scripts/kinds-generate.ts";
import { LANGUAGES } from "../sources/web_research/constants.ts";

const signals = resolve(import.meta.dirname, "..");
const places = join(signals, "domain", "research", "places");
mkdirSync(join(signals, ".tmp"), { recursive: true });
const tmp = mkdtempSync(join(signals, ".tmp", "places-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const messages = JSON.parse(readFileSync(join(signals, "messages", "en.json"), "utf8")) as Record<
  string,
  string
>;

const FIRST_NINE = [
  "association_members",
  "contracts_awarded",
  "customer_sites",
  "dealer_lists",
  "distributor_lists",
  "fair_exhibitors",
  "public_tenders",
  "supplier_registries",
  "web_search",
];

test("the nine entries are registered, each a file named by its id, with its label, its two texts and a page kind of the list", () => {
  const registered = listPlaces();
  assert.deepEqual(
    registered.map(({ id }) => id),
    FIRST_NINE,
  );
  const files = readdirSync(places).filter((name) => /^[a-z][a-z_]*\.ts$/.test(name));
  for (const { id, labelKey, shows, finding, pageKind, source } of registered) {
    assert.ok(files.includes(`${id}.ts`), `${id}.ts`);
    assert.match(source, new RegExp(`/${id}\\.[jt]s$`));
    assert.equal(labelKey, `signals.places.${id}.label`);
    assert.ok((messages[labelKey] ?? "").length > 0, `${labelKey} has no label`);
    for (const text of [shows, finding]) {
      assert.ok(text.trim() !== "" && text.length <= PLACE_TEXT_MAX, `${id}: ${text.length}`);
    }
    assert.ok(PAGE_KINDS.includes(pageKind));
  }
  assert.deepEqual(
    new Set(registered.map(({ pageKind }) => pageKind)),
    new Set(PAGE_KINDS),
    "the nine use each of the three page kinds",
  );
});

test("no entry names a country or a language, as the standard names them in English", () => {
  const regions = new Intl.DisplayNames("en", { type: "region" });
  const names = new Set<string>();
  for (const a of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const name = regions.of(`${a}${b}`);
      if (name !== undefined && name !== `${a}${b}`) names.add(name);
    }
  }
  const languages = new Intl.DisplayNames("en", { type: "language" });
  for (const code of LANGUAGES) {
    const name = languages.of(code);
    if (name !== undefined && name !== code) names.add(name);
  }
  assert.ok(names.size > 200, `${names.size} names`);
  for (const { id, labelKey, shows, finding } of listPlaces()) {
    const text = [messages[labelKey] ?? "", shows, finding].join("\n");
    for (const name of names) {
      const word = new RegExp(
        `(?<![\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`,
        "u",
      );
      assert.ok(!word.test(text), `${id} names ${name}`);
    }
  }
});

test("a definition off its form stops the start, naming its id and its file; an id two files declare names both", () => {
  const good: PlaceDefinition = {
    id: "fixture_one",
    labelKey: "signals.places.fixture_one.label",
    shows: "Something a page shows.",
    finding: "How such a page is found.",
    pageKind: "notice",
  };
  const source = (id: string) => `file:///x/domain/research/places/${id}.ts`;
  const refused = (definition: PlaceDefinition, file = source(definition.id)) => {
    try {
      definePlace(definition, file);
    } catch (error) {
      assert.ok(isAppError(error));
      return error;
    }
    return assert.fail("accepted");
  };
  const invalid = [
    ["Not_snake", { ...good, id: "Not_snake" }],
    ["a label key of another id", { ...good, labelKey: "signals.places.other.label" }],
    ["a blank text", { ...good, shows: "  " }],
    ["a text too long", { ...good, finding: "x".repeat(PLACE_TEXT_MAX + 1) }],
    ["a page kind off the list", { ...good, pageKind: "people" as never }],
  ] as const;
  for (const [name, definition] of invalid) {
    assert.equal(refused(definition).code, "signal_place_invalid", name);
  }
  assert.equal(
    refused(good, source("another_name")).code,
    "signal_place_invalid",
    "the file's name",
  );
  assert.equal(definePlace(good, source("fixture_one")), good);
  const twice = refused(good, "file:///y/places/fixture_one.ts");
  assert.equal(twice.code, "signal_place_duplicate");
  assert.deepEqual(twice.details, {
    id: "fixture_one",
    sources: [source("fixture_one"), "file:///y/places/fixture_one.ts"],
  });
});

test("the generator lists each entry's file, never the registry's own files, and a new file joins with no other change", () => {
  const out = join(tmp, "places.generated.ts");
  const listed = generatePlaceList(places, out).map((file) => file.slice(places.length + 1));
  assert.deepEqual(
    listed,
    FIRST_NINE.map((id) => `${id}.ts`),
  );
  const text = readFileSync(out, "utf8");
  for (const id of FIRST_NINE) assert.ok(text.includes(`${id}.ts"`), id);
  assert.ok(!/registry|_contract|places\.generated/.test(text.replace(/^\/\/.*$/m, "")));
});
