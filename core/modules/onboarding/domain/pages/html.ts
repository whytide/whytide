// A page's text and links (README "The website fetch"): one pass over the HTML, linear in its length,
// without a parser dependency. It keeps the title, the headings (as `#` lines) and the text of every
// block on a line of its own; it drops scripts, styles, navigation, footers, the head, templates,
// SVG and comments; it lists every `<a href>` with whether it sits in the page's navigation (`nav` or
// `header`). Entities: the numeric ones and the common named ones; others stay as written.

export type PageLink = { readonly href: string; readonly nav: boolean };
export type ParsedPage = {
  readonly title: string;
  readonly text: string;
  readonly links: readonly PageLink[];
};

/** Their content runs to their end tag and is never HTML: kept for a title, dropped otherwise. */
const RAW = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);
/** Dropped with everything inside them. */
const DROPPED = new Set(["nav", "footer", "head", "template", "svg", "math", "select", "object"]);
const NAVIGATION = new Set(["nav", "header"]);
const FOREIGN = new Set(["svg", "math"]);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** A start tag of these ends an open one of the same name, as the HTML parser does. */
const SELF_ENDING = new Set(["p", "li", "dt", "dd", "tr", "td", "th", "option"]);
/** What may sit in the head; anything else ends a head left open. */
const HEAD = new Set(["title", "meta", "link", "style", "script", "base", "noscript", "template"]);
const BLOCKS = new Set([
  ..."address article aside blockquote body br caption dd details dialog div dl dt fieldset".split(
    " ",
  ),
  ..."figcaption figure form h1 h2 h3 h4 h5 h6 header hgroup hr html li main menu ol p pre".split(
    " ",
  ),
  ..."section summary table tbody td tfoot th thead tr ul".split(" "),
]);
/** The deepest the open elements go; past it a start tag shapes nothing, so a page costs O(n). */
const MAX_DEPTH = 256;
const HEADING = /^h[1-6]$/;
const MAX_LINKS = 500;
const MAX_TITLE = 500;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  deg: "°",
  times: "×",
};
const ENTITY = /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,7});)/g;

/** `text` with its character references decoded; a code point out of range becomes U+FFFD. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (match, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name] ?? match;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : "�";
  });
}

const isLetter = (code: number) => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
const isSpace = (char: string | undefined) =>
  char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";

/** A tag at `start` (its `<`): its lower-case name, attributes, end and whether it closes itself. */
function readTag(html: string, start: number, closing: boolean) {
  let at = start + (closing ? 2 : 1);
  const nameStart = at;
  while (at < html.length && !isSpace(html[at]) && html[at] !== "/" && html[at] !== ">") at++;
  const name = html.slice(nameStart, at).toLowerCase();
  const attributes = new Map<string, string>();
  let selfClosing = false;
  while (at < html.length && html[at] !== ">") {
    if (isSpace(html[at]) || html[at] === "/") {
      selfClosing = html[at] === "/";
      at++;
      continue;
    }
    selfClosing = false;
    const keyStart = at;
    at++;
    while (at < html.length && !isSpace(html[at]) && !"/>=".includes(html[at] ?? "")) at++;
    const key = html.slice(keyStart, at).toLowerCase();
    while (isSpace(html[at])) at++;
    let value = "";
    if (html[at] === "=") {
      at++;
      while (isSpace(html[at])) at++;
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, at + 1);
        if (end < 0) return undefined;
        value = html.slice(at + 1, end);
        at = end + 1;
      } else {
        const valueStart = at;
        while (at < html.length && !isSpace(html[at]) && html[at] !== ">") at++;
        value = html.slice(valueStart, at);
      }
    }
    if (!attributes.has(key)) attributes.set(key, value);
  }
  if (at >= html.length) return undefined;
  return { name, attributes, end: at + 1, selfClosing };
}

/** Where the end tag of raw element `name` starts, from `from`; the page's end when there is none. */
function rawEnd(html: string, from: number, name: string): number {
  for (let at = html.indexOf("</", from); at >= 0; at = html.indexOf("</", at + 2)) {
    const after = html[at + 2 + name.length];
    const named = html.slice(at + 2, at + 2 + name.length).toLowerCase() === name;
    if (named && (after === undefined || after === ">" || after === "/" || isSpace(after))) {
      return at;
    }
  }
  return html.length;
}

/** The title, the text and the links of `html` (README "The website fetch"). */
export function parseHtml(html: string): ParsedPage {
  const lines: string[] = [];
  const links: PageLink[] = [];
  const open: string[] = [];
  const inside = { dropped: 0, navigation: 0, foreign: 0 };
  let title: string | undefined;
  let line = "";

  /** Ends the line; inside a heading, as `#` lines, the innermost heading's level. */
  const flush = () => {
    const text = line.replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
    const heading = Number(open.findLast((name) => HEADING.test(name))?.[1] ?? 0);
    if (text !== "") lines.push(heading > 0 ? `${"#".repeat(heading)} ${text}` : text);
    line = "";
  };
  const count = (name: string, by: number) => {
    if (DROPPED.has(name)) inside.dropped += by;
    if (NAVIGATION.has(name)) inside.navigation += by;
    if (FOREIGN.has(name)) inside.foreign += by;
  };
  const popTo = (index: number) => {
    while (open.length > index) count(open.pop() ?? "", -1);
  };
  const start = (name: string, attributes: Map<string, string>, selfClosing: boolean) => {
    if (open.at(-1) === "head" && !HEAD.has(name)) popTo(open.length - 1);
    if (SELF_ENDING.has(name) && open.at(-1) === name) popTo(open.length - 1);
    if (BLOCKS.has(name)) flush();
    const href = attributes.get("href");
    if (name === "a" && href !== undefined && links.length < MAX_LINKS) {
      links.push({ href: decodeEntities(href).trim(), nav: inside.navigation > 0 });
    }
    if (VOID.has(name) || selfClosing || open.length >= MAX_DEPTH) return;
    open.push(name);
    count(name, 1);
  };
  const end = (name: string) => {
    if (BLOCKS.has(name)) flush();
    const index = open.lastIndexOf(name);
    if (index >= 0) popTo(index);
  };

  let at = 0;
  while (at < html.length) {
    const next = html.indexOf("<", at);
    const textEnd = next < 0 ? html.length : next;
    if (textEnd > at && inside.dropped === 0) line += decodeEntities(html.slice(at, textEnd));
    if (next < 0) break;
    at = next;
    const after = html.charCodeAt(at + 1);
    if (html.startsWith("<!--", at)) {
      const close = html.indexOf("-->", at + 2);
      at = close < 0 ? html.length : close + 3;
    } else if (html[at + 1] === "!" || html[at + 1] === "?") {
      const close = html.indexOf(">", at);
      at = close < 0 ? html.length : close + 1;
    } else if (html[at + 1] === "/" || isLetter(after)) {
      const closing = html[at + 1] === "/";
      if (closing && !isLetter(html.charCodeAt(at + 2))) {
        const close = html.indexOf(">", at);
        at = close < 0 ? html.length : close + 1;
        continue;
      }
      const tag = readTag(html, at, closing);
      if (tag === undefined) break;
      at = tag.end;
      if (closing) {
        end(tag.name);
      } else if (RAW.has(tag.name)) {
        const close = rawEnd(html, at, tag.name);
        const content = html.slice(at, close);
        if (tag.name === "title" && title === undefined && inside.foreign === 0) {
          title = decodeEntities(content).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
        }
        const closeEnd = html.indexOf(">", close);
        at = closeEnd < 0 ? html.length : closeEnd + 1;
      } else {
        start(tag.name, tag.attributes, tag.selfClosing);
      }
    } else {
      if (inside.dropped === 0) line += "<";
      at++;
    }
  }
  flush();
  return { title: (title ?? "").replaceAll("\u0000", ""), text: lines.join("\n"), links };
}
