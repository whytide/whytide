// The reply golden set's constants (README.md "The reply golden set"; beta-p7-030), beside their
// readers: the line's bound and masks, the file's name and type, and the ISO week's calendar.

/** The most messages before a reply a line carries: the latest of them (not in the sources). */
export const EXPORT_EARLIER_MAX = 10;
/** The labels whose lines one tenant run builds, so that no run grows with the set. */
export const EXPORT_PAGE = 100;
/** JSON Lines: a JSON object a line, UTF-8, as qualification's golden set. */
export const JSONL = "application/jsonl; charset=utf-8";
/** The file's folder under the workspace's, which the files port keeps 7 days at most. */
export const EXPORT_FOLDER = "exports/";
/** `reply-labels-<UTC date>.jsonl`, or `reply-labels-<ISO week>.jsonl` for one week's labels. */
export const EXPORT_FILE_PREFIX = "reply-labels-";
export const EXPORT_FILE_SUFFIX = ".jsonl";
/** The length of an ISO timestamp's date, `YYYY-MM-DD`: the day's file name. */
export const UTC_DATE_LENGTH = 10;

/** What the person's names become in every text of a line (not in the sources). */
export const NAME_MASKS = { firstName: "[first_name]", lastName: "[last_name]" } as const;
/**
 * A character that continues a word, so that a name beside it is part of a longer one: a letter, its
 * combining marks, a digit or an underscore, in any script.
 */
export const WORD_CHARACTER = "[\\p{L}\\p{M}\\p{N}_]";
/** The characters a name's words escape before they join a pattern. */
export const PATTERN_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** An ISO week, `2026-W44`: its year and its number. */
export const ISO_WEEK = /^(\d{4})-W(\d{2})$/;
export const DAY_MS = 86_400_000;
export const DAYS_PER_WEEK = 7;
/** Week 1 of a year holds its January 4th. */
export const WEEK_ONE_DAY = 4;
/** A week is its Thursday's year's: three days after its Monday. */
export const THURSDAY_OFFSET_DAYS = 3;
