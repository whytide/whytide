// The people-reading agent's input and output (agents/research-read-people/README.md; gamma-wr-060).
// The input, a field per data block: the company (its name and its own domain) and the pages its
// people may be on, each numbered with its address, title, text, links and `mailto:` addresses. The
// text is NOT scrubbed: the agent reads the names, the roles, the profile links and the addresses the
// pages print, which is its whole job; it is extraction, and the pick that judges the people never sees
// any of it (research-pick-people). The output: each person a page names with a role at the company,
// with the page's number and, only as printed with them, a link to their LinkedIn profile, an email
// address, a phone number (a direct line, a mobile, a WhatsApp number; gamma-wr-100) and a place. The gates that keep only what the pages hold are in code
// (domain/research/people-checks.ts).
import { z } from "zod";
import {
  PAGE_LINK_CHARS,
  PAGE_TEXT_INPUT_CHARS,
  PAGE_TITLE_INPUT_CHARS,
  PEOPLE_LINKS_MAX,
  PEOPLE_PAGES_MAX,
  PEOPLE_READ_MAX,
  PERSON_EMAIL_CHARS,
  PERSON_LINK_CHARS,
  PERSON_NAME_CHARS,
  PERSON_PHONE_CHARS,
  PERSON_PLACE_CHARS,
  PERSON_ROLE_CHARS,
} from "../domain/research/constants.ts";

export const RESEARCH_READ_PEOPLE = "signals.research-read-people";

export const researchReadPeopleInput = z.strictObject({
  company: z.strictObject({
    name: z.string().max(300),
    /** The company's own site's host, which an address printed with a person must be at. */
    domain: z.string().max(253),
  }),
  pages: z
    .array(
      z.strictObject({
        n: z.int().min(1).max(PEOPLE_PAGES_MAX),
        address: z.string().max(PAGE_LINK_CHARS * 3),
        title: z.string().max(PAGE_TITLE_INPUT_CHARS),
        text: z.string().max(PAGE_TEXT_INPUT_CHARS),
        links: z.array(z.string().max(PERSON_LINK_CHARS)).max(PEOPLE_LINKS_MAX),
        mailto: z.array(z.string().max(PERSON_EMAIL_CHARS)).max(PEOPLE_LINKS_MAX),
      }),
    )
    .min(1)
    .max(PEOPLE_PAGES_MAX),
});
export type ResearchReadPeopleInput = z.output<typeof researchReadPeopleInput>;

export const researchReadPeopleOutput = z.strictObject({
  people: z
    .array(
      z.strictObject({
        page: z.int().min(1).max(PEOPLE_PAGES_MAX),
        name: z.string().min(1).max(PERSON_NAME_CHARS),
        role: z.string().min(1).max(PERSON_ROLE_CHARS),
        profile: z.string().max(PERSON_LINK_CHARS).nullable(),
        email: z.string().max(PERSON_EMAIL_CHARS).nullable(),
        /** A direct line, a mobile or a WhatsApp number, as the page prints it with the person (gamma-wr-100). */
        phone: z.string().max(PERSON_PHONE_CHARS).nullable(),
        place: z.string().max(PERSON_PLACE_CHARS).nullable(),
      }),
    )
    .max(PEOPLE_READ_MAX),
});
export type ResearchReadPeopleOutput = z.output<typeof researchReadPeopleOutput>;
