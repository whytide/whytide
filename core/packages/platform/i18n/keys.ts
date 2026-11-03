/** A folder name: lower-case letters, digits and dashes, as `pnpm module:new` allows. */
const MODULE = /^[a-z][a-z0-9-]*$/;
/** A screen, purpose or part: lower-case letters, digits and underscores (error codes are snake_case). */
const SEGMENT = /^[a-z][a-z0-9_]*$/;

export type ParsedKey = {
  readonly module: string;
  readonly screen: string;
  readonly purpose: string;
  /** The part of a purpose that has several texts: a mail's `subject` and `body`. */
  readonly part?: string;
};

export type KeyResult = { ok: true; key: ParsedKey } | { ok: false; reason: string };

/**
 * The convention `module.screen.purpose` (`contacts.list.empty`), `module` being the folder name
 * (`platform` and `ui` for the two packages), plus one part for a mail (`identity.signin.link.subject`).
 */
export function parseKey(key: string): KeyResult {
  const segments = key.split(".");
  if (segments.length < 3 || segments.length > 4) {
    const count = `${segments.length} segment${segments.length === 1 ? "" : "s"}`;
    return {
      ok: false,
      reason: `${count} instead of module.screen.purpose, plus one part at most`,
    };
  }
  const [module, screen, purpose, part] = segments as [string, string, string, string?];
  if (!MODULE.test(module)) {
    const reason = `the module segment "${module}" is not a folder name (lower-case letters, digits, dashes)`;
    return { ok: false, reason };
  }
  for (const segment of [screen, purpose, part]) {
    if (segment !== undefined && !SEGMENT.test(segment)) {
      const reason = `the segment "${segment}" is not lower-case letters, digits and underscores, starting with a letter`;
      return { ok: false, reason };
    }
  }
  return { ok: true, key: { module, screen, purpose, ...(part === undefined ? {} : { part }) } };
}

/** Whether a string literal is shaped like a message key: a `nav.ts` label is, an href or an icon name is not. */
export function isMessageKey(text: string): boolean {
  return parseKey(text).ok;
}
