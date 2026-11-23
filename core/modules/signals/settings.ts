// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8). A
// kind's own settings sit in its folder: sources/post_engagers/config.ts, the same block. No workflow
// code imports this file: the activities read it (README.md "Settings").
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import {
  CREDITS_PER_ENGAGER,
  CREDITS_PER_RESEARCHED_COMPANY,
  RATED_PER_RUN,
} from "./domain/constants.ts";
import {
  RESEARCH_COMPANIES_PER_RUN,
  RESEARCH_PAGES_PER_RUN,
  RESEARCH_PEOPLE_PER_COMPANY,
  RESEARCH_RECHECK_DAYS,
  RESEARCH_SEARCHES_PER_RUN,
  RESEARCH_SITE_MAX_PAGES,
} from "./domain/research/constants.ts";
import { READS_KEPT, RESEARCH_EVERY_DAYS } from "./domain/schedule/constants.ts";

const { default: perEngager, min, max } = CREDITS_PER_ENGAGER;

const { default: perCompany, min: companyMin, max: companyMax } = CREDITS_PER_RESEARCHED_COMPANY;

export const settings = defineConfig("modules/signals", {
  /** The enabled sources of one agent, and of the sources in no agent (README.md "Settings"). */
  SIGNALS_MAX_ENABLED_SOURCES: z.coerce.number().int().positive().default(10),
  /** The enabled competitor and creator sources of one sender account (README.md "Settings"). */
  SIGNALS_MAX_TRACKED_PER_ACCOUNT: z.coerce.number().int().positive().default(10),
  /** The pages a run started before beta-p1-090 reserves credits for (README.md "Runs"). */
  SIGNALS_ESTIMATED_PAGES: z.coerce.number().int().positive().default(4),
  /** The credits of one engager's profile read, signals.engager's (README.md "Settings"). */
  SIGNALS_CREDITS_PER_ENGAGER: z.coerce.number().int().min(min).max(max).default(perEngager),
  /** The credits of one company a research run judges, signals.researched_company's (README.md "Settings"). */
  SIGNALS_CREDITS_PER_RESEARCHED_COMPANY: z.coerce
    .number()
    .int()
    .min(companyMin)
    .max(companyMax)
    .default(perCompany),
  /** The reads of an account's day the sources leave for the sends' checks, 1 or more (README.md "Settings"). */
  SIGNALS_READS_KEPT_FOR_SENDS: z.coerce.number().int().positive().default(READS_KEPT.default),
  /** The events one run sends to the AI for rating at most, 1 or more (README.md "Settings"). */
  SIGNALS_RATE_MAX_EVENTS_PER_RUN: z.coerce
    .number()
    .int()
    .positive()
    .default(RATED_PER_RUN.default),
  /** The days between two runs of a research source, 1 or more, no maximum (README.md "Settings"). */
  SIGNALS_RESEARCH_EVERY_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(RESEARCH_EVERY_DAYS.default),
  /** The days a query a source asked is not asked again, 1 or more, no maximum (README.md "Settings"). */
  SIGNALS_RESEARCH_RECHECK_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(RESEARCH_RECHECK_DAYS.default),
  /** The searches one research run asks at most, 1 or more, no maximum (README.md "Settings"). */
  SIGNALS_RESEARCH_SEARCHES_PER_RUN: z.coerce
    .number()
    .int()
    .positive()
    .default(RESEARCH_SEARCHES_PER_RUN.default),
  /** The pages one research run reads at most, 1 or more, no maximum (README.md "Settings"). */
  SIGNALS_RESEARCH_PAGES_PER_RUN: z.coerce
    .number()
    .int()
    .positive()
    .default(RESEARCH_PAGES_PER_RUN.default),
  /** The companies one research run judges at most, 1 or more, no maximum (README.md "Settings"). */
  SIGNALS_RESEARCH_COMPANIES_PER_RUN: z.coerce
    .number()
    .int()
    .positive()
    .default(RESEARCH_COMPANIES_PER_RUN.default),
  /** The pages of one company's site the judge reads at most, 1 or more, no maximum (README.md "Settings"). */
  SIGNALS_RESEARCH_SITE_MAX_PAGES: z.coerce
    .number()
    .int()
    .positive()
    .default(RESEARCH_SITE_MAX_PAGES.default),
  /** The people taken from one found company at most, 1 to 10, a privacy cap (README.md "Settings"). */
  SIGNALS_RESEARCH_PEOPLE_PER_COMPANY: z.coerce
    .number()
    .int()
    .min(RESEARCH_PEOPLE_PER_COMPANY.min)
    .max(RESEARCH_PEOPLE_PER_COMPANY.max)
    .default(RESEARCH_PEOPLE_PER_COMPANY.default),
});
