// The documents of `pnpm knowledge:draft --file` without a database (knowledge-draft; README "The
// documents"): a PDF's text through unpdf, a text file's and a Markdown file's, the cut at 50,000
// characters, and each refusal with the file it names. Reading a PDF fetches nothing and prints
// nothing. The fixtures are tests/fixtures/documents/, the PDFs made by its make-pdf.ts. The files'
// limits are the settings' defaults here; tests/document-limits.test.ts sets them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { readDocuments } from "../cli/documents.ts";
import { DOCUMENT_LIMITS } from "../domain/constants.ts";
import { documentText } from "../domain/documents.ts";
import { settings } from "../settings.ts";
import { FETCH_LIMITS } from "../workflows/fetch-website.ts";

const onboarding = resolve(import.meta.dirname, "..");
const FIXTURES = join(import.meta.dirname, "fixtures", "documents");
mkdirSync(join(onboarding, ".tmp"), { recursive: true });
const tmp = mkdtempSync(join(onboarding, ".tmp", "documents-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** The code and file of a refusal, or the documents read. */
async function read(files: string[], cwd = FIXTURES) {
  const result = await readDocuments(files, cwd);
  return result.ok ? result.documents : { code: result.code, file: result.file };
}

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
/** `fn`'s result, with what it tried to send (a fetch, a socket) or print, each refused or kept. */
async function watched<T>(fn: () => Promise<T>): Promise<{ result: T; tried: unknown[] }> {
  const tried: unknown[] = [];
  const saved = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect };
  const methods = Object.fromEntries(METHODS.map((name) => [name, console[name]]));
  const refuse = (what: string) => (): never => {
    tried.push(what);
    throw new Error(`refused: ${what}`);
  };
  globalThis.fetch = refuse("fetch");
  net.Socket.prototype.connect = refuse("connect");
  for (const name of METHODS) console[name] = (...args: unknown[]) => tried.push([name, args]);
  try {
    return { result: await fn(), tried };
  } finally {
    Object.assign(globalThis, { fetch: saved.fetch });
    net.Socket.prototype.connect = saved.connect;
    Object.assign(console, methods);
  }
}

test("a PDF gives its pages' text, a .txt and a .md theirs as they are, by paths from the folder given, in the order given; nothing sent, nothing printed", async () => {
  const files = ["deck.pdf", "notes.txt", join(FIXTURES, "faq.md")];
  const { result, tried } = await watched(() => read(files));
  // Nor on the PDF with no text, nor on the encrypted one.
  const refused = await watched(() => read(["scan.pdf"]));
  const locked = await watched(() => read(["locked.pdf"]));
  assert.deepEqual([tried, refused.tried, locked.tried], [[], [], []]);
  assert.deepEqual(result, [
    {
      name: "deck.pdf",
      mediaType: "application/pdf",
      status: "read",
      text: "Corvid Freight\nSame-day parcels for small shops.\nTrusted by 300 shops in the city.",
    },
    {
      name: "notes.txt",
      mediaType: "text/plain",
      status: "read",
      text: "Corvid Freight rate card\n\nParcels across the city from 4 euros, collected before noon and delivered the same day.\n",
    },
    {
      name: "faq.md",
      mediaType: "text/markdown",
      status: "read",
      text: "# Questions shops ask\n\n## Do you deliver on Sundays?\n\nYes: **Sunday** deliveries cost the same as any other day.\n",
    },
  ]);
});

test("a text past 50,000 characters, the fetch's limit for a page, is cut there and truncated, never inside a character; one at the limit is read; U+0000 goes before the cut", async () => {
  assert.equal(DOCUMENT_LIMITS.text, FETCH_LIMITS.text);
  const limit = DOCUMENT_LIMITS.text;
  const write = (name: string, text: string) => writeFileSync(join(tmp, name), text);
  write("at.txt", "a".repeat(limit));
  write("past.md", `${"b".repeat(limit)}c`);
  // An emoji, two UTF-16 units, across the limit: it goes whole.
  write("across.txt", `${"d".repeat(limit - 1)}😀 and more`);
  // Postgres refuses U+0000 in a text.
  write("nul.txt", `\u0000${"e".repeat(limit)}\u0000`);
  const documents = await read(["at.txt", "past.md", "across.txt", "nul.txt"], tmp);
  assert.ok(Array.isArray(documents));
  assert.deepEqual(
    documents.map(({ name, status, text }) => [name, status, text.length]),
    [
      ["at.txt", "read", limit],
      ["past.md", "truncated", limit],
      ["across.txt", "truncated", limit - 1],
      ["nul.txt", "read", limit],
    ],
  );
  assert.equal(documents[2]?.text, "d".repeat(limit - 1));
});

test("each refusal names its file: an unknown extension, a missing file, one past 10 MB, a sixth file, a PDF with no text, an encrypted or damaged PDF, text not UTF-8, a name twice", async () => {
  const big = join(tmp, "big.pdf");
  writeFileSync(big, "");
  assert.deepEqual(
    [settings.ONBOARDING_MAX_FILES, settings.ONBOARDING_MAX_FILE_BYTES],
    [5, 10 << 20],
  );
  truncateSync(big, settings.ONBOARDING_MAX_FILE_BYTES + 1); // sparse: never read
  writeFileSync(join(tmp, "broken.pdf"), "%PDF-1.4\nnot a PDF\n");
  writeFileSync(join(tmp, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  writeFileSync(join(tmp, "blank.md"), " \n\t\n");
  writeFileSync(join(tmp, "notes.txt"), "Other notes");
  const six = ["deck.pdf", "notes.txt", "faq.md", "scan.pdf", "locked.pdf", "sixth.txt"];
  const cases: [string[], string, string][] = [
    [["notes.txt", "deck.docx"], "document_type_unsupported", "deck.docx"],
    [["deck.pdf", "missing.pdf"], "document_not_found", "missing.pdf"],
    [[big], "document_too_large", big],
    [six, "documents_too_many", "sixth.txt"],
    [["scan.pdf"], "document_no_text", "scan.pdf"],
    [[join(tmp, "blank.md")], "document_no_text", join(tmp, "blank.md")],
    [["locked.pdf"], "document_encrypted", "locked.pdf"],
    [[join(tmp, "broken.pdf")], "document_unreadable", join(tmp, "broken.pdf")],
    [[join(tmp, "latin1.txt")], "document_unreadable", join(tmp, "latin1.txt")],
    [["bad\u0007name.txt"], "document_name_invalid", "bad\u0007name.txt"],
    [["notes.txt", join(tmp, "notes.txt")], "document_name_repeated", join(tmp, "notes.txt")],
  ];
  for (const [files, code, file] of cases) {
    assert.deepEqual(await read(files), { code, file }, files.join(" "));
  }
});

test("a text's other control characters become spaces and a lone surrogate U+FFFD, tabs and line breaks kept: its JSON then takes at most three bytes a character, so five fit the api's body", () => {
  assert.deepEqual(documentText("a\u0001b\u001fc\td\r\ne\ud800f\udc00g😀"), {
    status: "read",
    text: "a b c\td\r\ne\ufffdf\ufffdg😀",
  });
  assert.equal(documentText("\u0000 \u0001\n"), null);
  // The costliest characters in JSON, past the limit.
  const worst = documentText('\u0001\ud800€"\\'.repeat(DOCUMENT_LIMITS.text));
  assert.equal(worst?.status, "truncated");
  const text = worst?.text ?? "";
  assert.equal(text.length, DOCUMENT_LIMITS.text);
  assert.ok(Buffer.byteLength(JSON.stringify(text)) <= 3 * text.length + 2);
});
