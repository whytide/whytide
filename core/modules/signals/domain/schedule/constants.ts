// The daily runs' constants (README.md "Runs", "Settings"; gamma-p5-040): the default of the reads
// kept, which settings.ts reads; the rest no setting, so a change is a change of the code. No import
// of settings.ts: the workflow's sandbox imports share.ts, which imports this file.
import { AUTHOR } from "../../sources/constants.ts";

/**
 * SIGNALS_READS_KEPT_FOR_SENDS's default (settings.ts, README.md "Settings"): the reads of an
 * account's quota day no signals run takes, since the send path's checks need them. Every read of a
 * budgeted run is reserved with the setting as its `keep`, which linkedin checks under the day's lock.
 */
export const READS_KEPT = { default: 20 } as const;

/**
 * SIGNALS_RESEARCH_EVERY_DAYS's default (settings.ts, README.md "Settings"; gamma-wr-030): the days
 * between two runs of a research source an active agent holds.
 */
export const RESEARCH_EVERY_DAYS = { default: 7 } as const;

/** The day, in milliseconds, which a research source's days are counted in. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The share of a run's budget its page reads, posts' and engagers' together, may take: the rest is
 * its profiles', so that a source whose pages pass it still reads profiles each day.
 */
export const PAGE_READS_SHARE = 0.5;

/** The page reads a budgeted run may make however small its budget. */
export const PAGE_READS_MIN = 1;

/** How often the global tick `signals.daily_runs` looks for the sources due, in minutes. */
export const DAILY_RUNS_TICK_MINUTES = 60;

/** The runs that are not over: one of a source makes it not due. A `scheduled` one is about to start. */
export const UNENDED = ["scheduled", "running", "waiting"] as const;

/** The runs that read now, from the same reads as the run that starts: `running` and `waiting`. */
export const READING = ["running", "waiting"] as const;

/** The candidates whose profiles are read first (the read order): authors and commenters. */
export const READ_FIRST: readonly string[] = [AUTHOR, "comment"];

/** The tick's own runs of each workspace, as a service. */
export const DAILY_RUNS_SERVICE = "signals";
