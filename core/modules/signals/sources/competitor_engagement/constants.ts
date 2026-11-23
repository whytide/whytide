// The competitor_engagement kind's constants (README.md "Kinds"): the bounds of the company's name the
// tester gives, which the add form reads too.

/** The fewest characters of a company's name, its words one space apart. */
export const COMPANY_NAME_MIN_CHARS = 2;
/** The most characters of a company's name, its words one space apart. */
export const COMPANY_NAME_MAX_CHARS = 100;
/** The most characters of the name as given, its spaces included, before they are closed up. */
export const COMPANY_NAME_GIVEN_MAX_CHARS = COMPANY_NAME_MAX_CHARS * 2;
/** A control character, which a name may not hold once its spaces are closed up. */
export const CONTROL_CHARACTER = /\p{Cc}/u;
