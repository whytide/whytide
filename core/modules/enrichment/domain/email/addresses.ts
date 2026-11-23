// The addresses in a text (README "The sources reply, website and pattern"; gamma-en-085), each with
// where it starts, for the site's names around it: each `@` read outwards within an address's bounds,
// so the scan is linear in the text. A run longer than an address's part is no address, never a piece
// of one. Pure.
import {
  ADDRESS,
  DOMAIN_CHAR,
  DOMAIN_MAX,
  LOCAL_CHAR,
  LOCAL_MAX,
  SITE_ADDRESSES_MAX,
} from "./constants.ts";

export type Found = { readonly address: string; readonly at: number };

/** The addresses of the text, lower case, in their order, at most SITE_ADDRESSES_MAX. */
export function addressesIn(text: string): Found[] {
  const found: Found[] = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && at - start < LOCAL_MAX && LOCAL_CHAR.test(text[start - 1] ?? "")) start--;
    let end = at + 1;
    while (end < text.length && end - at <= DOMAIN_MAX && DOMAIN_CHAR.test(text[end] ?? "")) end++;
    if (LOCAL_CHAR.test(text[start - 1] ?? "") || DOMAIN_CHAR.test(text[end] ?? "")) continue;
    const raw = text.slice(start, end);
    const lead = raw.length - raw.replace(/^[._%+-]+/, "").length;
    // A sentence's full stop or a stray dot ends neither part.
    const address = raw
      .slice(lead)
      .replace(/[.-]+$/, "")
      .toLowerCase();
    if (ADDRESS.test(address)) found.push({ address, at: start + lead });
    if (found.length >= SITE_ADDRESSES_MAX) break;
  }
  return found;
}

/** The local part of an address. */
export const localOf = (address: string): string => address.slice(0, address.lastIndexOf("@"));
