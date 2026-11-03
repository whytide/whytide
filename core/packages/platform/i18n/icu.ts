import { IntlMessageFormat } from "intl-messageformat";
import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";

/** The arguments of a message; ICU formats the numbers and dates among them for the locale. */
export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

/** The parser's codes in plain words. */
const HINTS: Record<string, string> = {
  EXPECT_ARGUMENT_CLOSING_BRACE: "a { without its }",
  EXPECT_ARGUMENT_TYPE: "an argument with a comma but no type after it",
  MALFORMED_ARGUMENT: "a malformed argument",
  MISSING_OTHER_CLAUSE: "a plural or select without an other clause",
  INVALID_ARGUMENT_TYPE:
    "an unknown argument type (number, date, time, plural, selectordinal, select)",
  INVALID_TAG: "a malformed tag",
  EMPTY_ARGUMENT: "an empty {}",
};
/** The header of a plural or selectordinal argument, right after its opening brace. */
const PLURAL_HEADER = /^\s*[^,{}]+?\s*,\s*(?:plural|selectordinal)\s*,/;

/**
 * Why a value is not valid ICU MessageFormat, or undefined when it is. The parser accepts a stray
 * `}` as text; ICU does not, and neither does this.
 */
export function validateIcu(value: string, locale = "en"): string | undefined {
  try {
    new IntlMessageFormat(value, locale);
  } catch (error) {
    return describe(error);
  }
  return strayBrace(value);
}

/** The value formatted with its arguments for the locale. */
export function formatIcu(value: string, values: MessageValues, locale: string): string {
  try {
    const out = new IntlMessageFormat(value, locale).format<string>(values);
    return Array.isArray(out) ? out.join("") : out;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError(errors.message_format_failed, { details: { reason }, cause: error });
  }
}

function describe(error: unknown): string {
  const { message, location } = error as {
    message?: string;
    location?: { start?: { column?: number } };
  };
  const code = message ?? String(error);
  const column = location?.start?.column;
  return `invalid ICU: ${HINTS[code] ?? code}${column === undefined ? "" : ` at column ${column}`}`;
}

/**
 * A `}` that closes nothing, or a `{` left open, outside quoted text. As formatjs reads it, an
 * apostrophe quotes before `{`, `}`, `<` and `>`, and before `#` inside a plural; `''` is an apostrophe.
 */
function strayBrace(value: string): string | undefined {
  const plural: boolean[] = [];
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const next = value[i + 1];
    if (c === "'") {
      if (next === "'") i++;
      else if (quoted) quoted = false;
      else if (next === "{" || next === "}" || next === "<" || next === ">") quoted = true;
      else if (next === "#" && plural.at(-1) === true) quoted = true;
    } else if (!quoted && c === "{") {
      plural.push(PLURAL_HEADER.test(value.slice(i + 1)) || plural.at(-1) === true);
    } else if (!quoted && c === "}" && plural.pop() === undefined) {
      return `invalid ICU: a } without its { at column ${i + 1}`;
    }
  }
  return plural.length > 0 ? "invalid ICU: a { without its }" : undefined;
}
