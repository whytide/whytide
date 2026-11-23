// Reading a message as text (RFC 5322 header blocks; RFC 2045 to 2047 types, parts, transfer
// encodings, charsets and encoded words): what raw.ts checks, and what match.ts and reports.ts read
// for the adapters and the fake. A message is text, as an adapter reads the provider's bytes, in
// UTF-8. Plain parsing, no dependency: a line ends in CRLF or LF, a header block at its first empty
// line, a folded field is one field, and a field name may have spaces before its colon, as RFC
// 5322's obsolete syntax allows and some programs still read. The reading is pure and never throws;
// it reads at most READ_MAX_CHARS of a message and FIELD_READ_MAX_CHARS of a field's value before any
// regular expression does, and each of those reads in linear time.
import {
  ADDRESS_MAX_CHARS,
  ANY_ADDRESS,
  BETWEEN_ENCODED_WORDS,
  CR_LINE_END,
  ENCODED_WORD,
  FIELD_NAMES,
  FIELD_READ_MAX_CHARS,
  HEX_DIGITS,
  HEX_RADIX,
  MESSAGE_ID_MAX_CHARS,
  MIME,
  MIME_DEPTH_MAX,
  READ_MAX_CHARS,
} from "./constants.ts";

export type HeaderField = { readonly name: string; readonly value: string };
export type ReadText = {
  /** Names in lower case, values unfolded and trimmed; undefined when a line is neither a field nor a fold. */
  readonly fields: readonly HeaderField[] | undefined;
  /** What follows the empty line, with LF line ends. */
  readonly body: string;
};
export type ContentType = {
  /** In lower case: text/plain when the field is missing. */
  readonly type: string;
  /** Names in lower case, values unquoted. */
  readonly params: ReadonlyMap<string, string>;
};

const FIELD = /^([!-9;-~]+)[ \t]*:(.*)$/s;
const FOLD = /^[ \t]/;
const byteOf = (char: string) => char.charCodeAt(0);
const [EQUALS, CR, LF] = [byteOf("="), byteOf("\r"), byteOf("\n")];
/** A hex digit's value by its byte, either case. */
const HEX_VALUE = new Map(
  [...HEX_DIGITS, ...HEX_DIGITS.toUpperCase()].map((digit) => [
    byteOf(digit),
    Number.parseInt(digit, HEX_RADIX),
  ]),
);

export function readText(text: string): ReadText {
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf("");
  const head = end === -1 ? lines : lines.slice(0, end);
  return { fields: fieldsOf(head), body: end === -1 ? "" : lines.slice(end + 1).join("\n") };
}

function fieldsOf(lines: readonly string[]): HeaderField[] | undefined {
  const fields: { name: string; value: string }[] = [];
  for (const line of lines) {
    const last = fields.at(-1);
    if (FOLD.test(line)) {
      if (last === undefined) return undefined;
      last.value += line;
      continue;
    }
    const [, name, value] = FIELD.exec(line) ?? [];
    if (name === undefined || value === undefined) return undefined;
    fields.push({ name: name.toLowerCase(), value });
  }
  return fields.map(({ name, value }) => ({ name, value: value.trim() }));
}

/** Every value of the field, its name in lower case, in order. */
export const valuesOf = (fields: readonly HeaderField[], name: string): string[] =>
  fields.filter((field) => field.name === name).map((field) => field.value);

/** The Message-IDs in a field's value, `<a@b> <c@d>`, without their angle brackets, read in its first FIELD_READ_MAX_CHARS characters: a cut makes none, as one ends in its bracket. */
export const messageIdsIn = (value: string | undefined): string[] =>
  [...(value ?? "").slice(0, FIELD_READ_MAX_CHARS).matchAll(/<([^<>\s]+)>/g)].map(
    (found) => found[1] as string,
  );

/** A field's first Message-ID; null when none reads, or it is over MESSAGE_ID_MAX_CHARS. */
export function messageIdOf(value: string | undefined): string | null {
  const [id] = messageIdsIn(value);
  return id !== undefined && id.length <= MESSAGE_ID_MAX_CHARS ? id : null;
}

/**
 * A From or To field's address in lower case: inside its last angle brackets, or the value; null when
 * none reads, and for a value over FIELD_READ_MAX_CHARS, which is never cut: a cut could leave an
 * earlier bracket last.
 */
export function addressIn(value: string | undefined): string | null {
  if (value === undefined || value.length > FIELD_READ_MAX_CHARS) return null;
  const inside = [...value.matchAll(/<([^<>]*)>/g)].at(-1)?.[1] ?? value;
  const address = inside.trim().toLowerCase();
  return address.length <= ADDRESS_MAX_CHARS && ANY_ADDRESS.test(address) ? address : null;
}

/** The Content-Type's type and parameters (RFC 2045 §5), read in its first FIELD_READ_MAX_CHARS characters. */
export function contentTypeOf(fields: readonly HeaderField[]): ContentType {
  const value = valuesOf(fields, FIELD_NAMES.contentType)[0] ?? MIME.plainText;
  const [type = "", ...params] = splitParams(value.slice(0, FIELD_READ_MAX_CHARS));
  const entries = params.flatMap((param) => {
    const at = param.indexOf("=");
    const name = param.slice(0, at).trim().toLowerCase();
    return at > 0 ? [[name, unquoted(param.slice(at + 1).trim())] as const] : [];
  });
  return { type: type.toLowerCase(), params: new Map(entries) };
}

/** A value's `;`-separated pieces, a quoted string kept whole. */
function splitParams(value: string): string[] {
  const pieces = [""];
  let quoted = false;
  for (let at = 0; at < value.length; at++) {
    let char = value[at] as string;
    if (quoted && char === "\\") char += value[++at] ?? "";
    else if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) pieces.push("");
    else pieces[pieces.length - 1] += char;
  }
  return pieces.map((piece) => piece.trim());
}

const unquoted = (value: string) =>
  value.length > 1 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;

/** A multipart body's parts, as text (RFC 2046 §5.1.1): between its boundary's delimiter lines, to the closing one. */
export function partsOf(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    const bare = line.trimEnd();
    if (bare === `${delimiter}--`) break;
    if (bare === delimiter) parts.push([]);
    else parts.at(-1)?.push(line);
  }
  return parts.map((lines) => lines.join("\n"));
}

/** A field's value with its encoded words (RFC 2047) decoded in their charsets, the white space between two dropped; read in its first FIELD_READ_MAX_CHARS characters. */
export function decodedWords(value: string): string {
  return value
    .slice(0, FIELD_READ_MAX_CHARS)
    .replace(BETWEEN_ENCODED_WORDS, "$1")
    .replace(ENCODED_WORD, (_word, charset: string, kind: string, text: string) => {
      const bytes =
        kind.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : quotedPrintable(text.replaceAll("_", " "));
      // RFC 2231 lets a charset carry a language after a star: `utf-8*en`.
      return decoderOf(charset.split("*")[0]).decode(bytes);
    });
}

/** A part's text: its body decoded by its Content-Transfer-Encoding, base64 or quoted-printable, in its charset; any other as it is. */
export function textOf(fields: readonly HeaderField[], body: string): string {
  const encoding = valuesOf(fields, FIELD_NAMES.transferEncoding)[0]?.toLowerCase();
  if (encoding !== MIME.base64 && encoding !== MIME.quotedPrintable) return body;
  // Node's base64 decoder passes over white space and line ends.
  const bytes = encoding === MIME.base64 ? Buffer.from(body, "base64") : quotedPrintable(body);
  return decoderOf(contentTypeOf(fields).params.get(MIME.charset)).decode(bytes);
}

/**
 * A message's plain text, read in its first READ_MAX_CHARS characters: its first text/plain part that
 * is no attachment, the parts of a multipart searched in order down to MIME_DEPTH_MAX levels, decoded,
 * with LF line ends. Undefined when it has none, so that no HTML and no attachment is ever read; a part
 * whose header does not read gives none.
 */
export function plainTextOf(raw: string): string | undefined {
  return plainTextIn(raw.slice(0, READ_MAX_CHARS), 0);
}

function plainTextIn(text: string, depth: number): string | undefined {
  const { fields, body } = readText(text);
  if (fields === undefined) return undefined;
  const { type, params } = contentTypeOf(fields);
  if (type === MIME.plainText) {
    const disposition = valuesOf(fields, FIELD_NAMES.disposition)[0]?.toLowerCase() ?? "";
    if (disposition.startsWith(MIME.attachment)) return undefined;
    return textOf(fields, body).replace(CR_LINE_END, "\n");
  }
  const boundary = params.get(MIME.boundary);
  if (!type.startsWith(MIME.multipartPrefix) || !boundary || depth >= MIME_DEPTH_MAX)
    return undefined;
  for (const part of partsOf(body, boundary)) {
    const found = plainTextIn(part, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The value's first `max` characters, a character being a code point, no half of one left. */
export function cutChars(value: string, max: number): string {
  // A code point is at most two UTF-16 units: the first 2 × max units hold the first max of them.
  return Array.from(value.slice(0, max * 2).toWellFormed())
    .slice(0, max)
    .join("");
}

/**
 * Quoted-printable (RFC 2045 §6.7) as bytes, in one pass: `=` and two hex digits one byte, `=` at a
 * line's end a soft line break, anything else itself, in UTF-8.
 */
function quotedPrintable(text: string): Uint8Array {
  const given = Buffer.from(text, "utf8");
  const bytes = new Uint8Array(given.length);
  let length = 0;
  for (let at = 0; at < given.length; at++) {
    const byte = given[at] as number;
    if (byte === EQUALS) {
      const high = HEX_VALUE.get(given[at + 1] as number);
      const low = HEX_VALUE.get(given[at + 2] as number);
      if (high !== undefined && low !== undefined) {
        bytes[length++] = high * HEX_RADIX + low;
        at += 2;
        continue;
      }
      const soft = given[at + 1] === LF ? 1 : given[at + 1] === CR && given[at + 2] === LF ? 2 : 0;
      at += soft;
      if (soft > 0) continue;
    }
    bytes[length++] = byte;
  }
  return bytes.subarray(0, length);
}

/** A decoder for the charset: UTF-8 for none, or one the runtime's TextDecoder lacks. Never fatal: a byte that does not read is U+FFFD. */
function decoderOf(charset: string | undefined): TextDecoder {
  try {
    return new TextDecoder(charset ?? MIME.fallbackCharset);
  } catch {
    return new TextDecoder(MIME.fallbackCharset);
  }
}
