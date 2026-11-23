// The read (README.md "The read"): the page's visible text and its links, taken in the page by a
// reader the adapter installs before any script of the page runs, and turned into the port's words
// in the worker. A page's scripts run in the same world as the reader and may replace any builtin
// they find; the reader takes the DOM's getters and the few builtins it uses while they are still
// the browser's own, and freezes `eval`, through which Playwright evaluates, so that whatever a page
// does, the answer is the reader's: one string of length-prefixed fields, as long as its bounds allow.
import { LINK_SCHEMES, LINK_TEXT_MAX, LINKS_MAX, TEXT_MAX, URL_MAX } from "../constants.ts";
import type { PageLink } from "../port.ts";

/** The reader's name in the page and its bounds, in UTF-16 code units. */
export type ReaderLimits = {
  readonly name: string;
  readonly textMax: number;
  readonly linksMax: number;
  readonly hrefMax: number;
  readonly linkTextMax: number;
  /** The anchors looked at, at most, whether their links are kept or not. */
  readonly anchorsMax: number;
  readonly schemes: readonly string[];
};

/**
 * The init script: runs in every document before its own scripts, and defines `limits.name`, a
 * reader no script can replace. Self-contained, since Playwright sends its source: the answer is the
 * body's innerText, then each kept link's href and text, every field written `<length>:<text>`.
 */
export function installReader(limits: ReaderLimits): void {
  type Method = (...args: never[]) => unknown;
  type Kind = { readonly prototype: object };
  const scope = globalThis as unknown as Record<string, unknown>;
  const { apply, defineProperty, getOwnPropertyDescriptor } = Reflect;
  const getter = (kind: string, key: string) =>
    getOwnPropertyDescriptor((scope[kind] as Kind).prototype, key)?.get as Method;
  const method = (kind: string, key: string) =>
    getOwnPropertyDescriptor((scope[kind] as Kind).prototype, key)?.value as Method;
  const body = getter("Document", "body");
  const innerText = getter("HTMLElement", "innerText");
  const textContent = getter("Node", "textContent");
  const select = method("Document", "querySelectorAll");
  const count = getter("NodeList", "length");
  const item = method("NodeList", "item");
  const href = getter("HTMLAnchorElement", "href");
  const slice = String.prototype.slice;
  const startsWith = String.prototype.startsWith;
  const Seen = Set;
  const has = Set.prototype.has;
  const add = Set.prototype.add;
  const { textMax, linksMax, hrefMax, linkTextMax, anchorsMax } = limits;
  const schemes: string[] = [];
  for (let at = 0; at < limits.schemes.length; at += 1) schemes[at] = `${limits.schemes[at]}`;

  const cut = (value: unknown, max: number): string =>
    typeof value === "string" ? (apply(slice, value, [0, max]) as string) : "";
  const field = (text: string): string => `${text.length}:${text}`;
  const kept = (link: string): boolean => {
    for (let at = 0; at < schemes.length; at += 1) {
      if (apply(startsWith, link, [schemes[at]])) return true;
    }
    return false;
  };
  const read = (): string => {
    const page = scope.document;
    const root = apply(body, page, []);
    let answer = field(root ? cut(apply(innerText, root, []), textMax) : "");
    const anchors = apply(select, page, ["a[href]"]);
    const total = apply(count, anchors, []) as number;
    const seen = new Seen();
    let links = 0;
    for (let at = 0; at < total && at < anchorsMax && links < linksMax; at += 1) {
      const anchor = apply(item, anchors, [at]);
      let link: unknown;
      try {
        link = apply(href, anchor, []);
      } catch {
        continue; // an SVG <a>, whose href is no string
      }
      if (typeof link !== "string" || link.length > hrefMax || !kept(link)) continue;
      if (apply(has, seen, [link])) continue;
      apply(add, seen, [link]);
      links += 1;
      answer = answer + field(link) + field(cut(apply(textContent, anchor, []), linkTextMax));
    }
    return answer;
  };
  defineProperty(scope, "eval", { value: scope.eval, writable: false, configurable: false });
  defineProperty(scope, limits.name, { value: read, writable: false, configurable: false });
}

/** The page's text and links in the port's words, from the reader's answer; undefined when the answer is not one the reader writes. */
export function pageContent(
  answer: unknown,
  max: number,
): { readonly text: string; readonly links: PageLink[] } | undefined {
  if (typeof answer !== "string" || answer.length > max) return undefined;
  const fields = decode(answer);
  if (fields === undefined || fields.length % 2 !== 1) return undefined;
  const [text = "", ...pairs] = fields;
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (let at = 0; at + 1 < pairs.length && links.length < LINKS_MAX; at += 2) {
    const href = linkHref(pairs[at] ?? "");
    if (href === undefined || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: cutAt(collapse(pairs[at + 1] ?? ""), LINK_TEXT_MAX) });
  }
  return { text: cutAt(text.trim(), TEXT_MAX), links };
}

/** `<length>:<text>` fields, one after another, to the end; undefined at the first that is not one. */
function decode(answer: string): string[] | undefined {
  const fields: string[] = [];
  for (let at = 0; at < answer.length; ) {
    const colon = answer.indexOf(":", at);
    const size = colon === -1 ? Number.NaN : Number(answer.slice(at, colon));
    if (!Number.isSafeInteger(size) || size < 0 || colon - at > 9) return undefined;
    const end = colon + 1 + size;
    if (end > answer.length) return undefined;
    fields.push(answer.slice(colon + 1, end));
    at = end;
  }
  return fields;
}

/** The link as the URL parser writes it, when it is http, https or mailto and fits. */
function linkHref(link: string): string | undefined {
  const url = URL.parse(link);
  if (url === null || !LINK_SCHEMES.includes(url.protocol)) return undefined;
  return url.href.length <= URL_MAX ? url.href : undefined;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The text cut at `max`, never between the two halves of a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
  return text.slice(0, end);
}
