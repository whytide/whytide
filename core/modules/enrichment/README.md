# enrichment

A new lead's company, filled from the instance's sources (gamma-en-050). Within minutes of a lead's creation, a run asks the sources in the configured order for the company's empty fields (website, LinkedIn page, industry, size, country, description), writes what they bring through contacts with the source's class and name as provenance, and releases the lead's hold, so qualification judges it with those fields. Free allowances are counted for the whole instance. Later tasks add sources (`linkedin`, `website`, `web-search`, `country-ai`), the lead page's panel and its "Enrich now" button (gamma-en-055).

- **Owns:** `enrichment_runs` and `source_usage` in `core/packages/db/prisma/schema/enrichment.prisma` ([docs/data.md](docs/data.md)), the workflows under `workflows/`.
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`, `providers` (the company data port), `ai` (the country namer, gamma-en-075), contacts (the person, the company, the hold) and tenancy (the workspaces). Contacts and qualification never import enrichment; privacy imports it for the eraser.
- **Reviewers:** the owners of this module.

## Public interface

| | |
|---|---|
| `requestEnrichment({ personId, requestKey })` | a run on request, `{ runId, created }`: the run with the key `request:<requestKey>`, and `enrichment.run_requested { runId }` published in the same run; a key given again answers its run and publishes nothing. `enrichment_input_invalid` (400, `details.fields`), `enrichment_person_not_found` (404) |
| `lastRunOf(personId)` | `{ runId, trigger, status, filled, finishedAt }` of the person's latest run, or null |
| `sourcesTried(runId)` | the sources the run asked, in order: `{ source, outcome, code, filled, ms }`, never a value |
| `erasePerson(personId)` | deletes the person's runs, `{ enrichment_runs }`, and their email rows, `{ contact_points, enrichment_requests, enrichment_cache_entries }` (gamma-en-080): privacy's eraser |
| `searchWeb(request)` | the counted web search (gamma-wr-010, "Allowances"): the port's input, with its optional `country`, `language` and `page`, to the first adapter of `PROVIDER_WEB_SEARCH` with room; `{ status: "answered", results, adapter }`, `{ status: "spent" }` (every adapter spent), `{ status: "failed", code, error }` (the last failure) or `{ status: "no_adapter" }`. Never throws for a vendor's failure |
| `pickWebsite(name, results)`, `domainOf(url)`, `isNotAHomepage(host)` | the test the `web-search` source applies to a company's website (gamma-wr-046; `Picked` is its answer): a result off `NOT_A_HOMEPAGE` whose host's first label is the name without its spaces or starts with it, or whose title starts with the name, as `{ found: domain }`, else `{ found: null, outcome }` (`ambiguous` for two different, `not_found` for none); `domainOf` is a result's host without `www.` (https only, no port, user or password), `isNotAHomepage` tells a social network's, a directory's, a news or a job site's host. Pure: signals' research run applies it to a company named without a link |
| `readCompanySite(domain, beat, preferred?, { maxPages?, refuseHost? })`, `SiteReadOptions` | a company's own site, read as the `website` source reads it (gamma-wr-050): platform's reader on `https://<domain>/`, robots.txt first, at most `maxPages` pages (`ENRICHMENT_SITE_MAX_PAGES` when absent: the caller's limit is its own), the short pages asked of the `browser` port when one is set; `refuseHost`, a host never requested, a redirect hop's too, and a rendered page that ends on one keeps its plain page; `{ ok: true, pages }` or `{ ok: false, code }` (`site_disallowed`, `fetch_failed`, an `egress_*` code) |
| `keepPhone(personId, { number, page }, at?)`, `PhoneOutcome` | a number a public page printed with the person, kept as a contact point of kind `phone` with the page's address (gamma-wr-100, "A person's phone"): `{ outcome, contactPointId }`, `outcome` one of `kept`, `known`, `other_person`, `suppressed`, `gone`, `invalid`. Never throws for a number that is no number |
| `cleanPhone(printed)`, `samePhone(a, b)` | the form of a number (its digits, a leading `+` when printed, 7 to 15 digits; null for anything else) and whether two printed numbers are one. Pure: signals' people step gates a phone with them |
| `workAddressOfName({ firstName, lastName, domain, key }, { workspaceId, tenant, make })` | the work address of a name that is not a person yet (gamma-wr-080; "The work address of a name"): `{ status: "found", personId, contactPointId }`, or `{ status: "none", reason }` with nothing left. `make(address)` is the caller's function that makes the person with the address as its key |
| `defineSource(definition)` and its types | a source of a later task ("Sources") |
| `errors`, `events`, `ids`, `permissions`, `settings` | the registries the hosts load |

Every reader and command runs in the caller's tenant run. `enrichment.read` and `enrichment.run` (Owner, Admin, Member) guard the lead page's routes and its panel ("The lead page").

## How it works

The order is the config's, at two levels: `ENRICHMENT_COMPANY_SOURCES` and `ENRICHMENT_PERSON_SOURCES` order the sources, and `company-data` expands into one source per adapter of `PROVIDER_COMPANY_DATA`, in that list's order. A run ([docs/flows.md](docs/flows.md)):
1. **Prepare:** the fields it wants are the company's empty ones, its old facts, and the person's country while a person source fills it. A fact is old once its stamp is older than `ENRICHMENT_FACT_DAYS` (180 by default, 0 for never) when the run starts: the industry, the size, the country and the description, whatever source stamped them (gamma-rf-020). The keys, the domain and the LinkedIn page, are wanted only while empty. A field a member set or cleared is never wanted, whatever its age. The company part is skipped, with its reason, for no company and no company name, for a company tried within `ENRICHMENT_COMPANY_RETRY_DAYS` (a new lead's run only), or while another run works on it.
2. **The pass:** the sources in order, each asked at most once, when it has one of its inputs and fills a field still open. A source that adds a domain or a LinkedIn page restarts the pass from the top. A source gets the minimum input: the company's page, domain, name and country, nothing of the person.
3. **Finish:** the run `done`, whatever its sources answered, `failed` only when its own steps failed, and the lead's hold released.

An earlier source wins: a source is asked only for the fields still open, and its other facts are dropped. A source that brings an old fact replaces its value and stamp, and the run's `filled` names it; one that brings nothing leaves the old value in use, never emptied. A person with only a company name gets a company once a source brings a page or a domain: made by that key with the person's company name and linked first. Without either, nothing is written (`no_company_key`).

## Sources

A source is a definition (`defineSource`, `domain/sources/define.ts`) and a name in a list: its kind (`company` or `person`), the fields it fills, the inputs it needs (any one of `linkedinUrl`, `domain`, `name`, `locationText`), its activity kind (`provider`, `ai`, `db`), its allowance and its provenance. Its file is imported by `domain/sources/index.ts`. `company-data/<adapter>` runs the port's `lookupCompany`; its facts' class is `open_data` for an adapter that declares open data, else `data_vendor`, and their provider is the adapter's name.

`run(input, context)` is called outside any transaction:
- **`input`:** the minimum input, the fields still wanted that the source fills, and the run's `workspaceId` and the person's `companyId` (null while none). The ids are for a run of the workspace or an agent's call (`callAgent`'s `workspaceId` and `subjectRef`), never for a vendor: company-data's lookup takes the company's keys only.
- **`context.tenant(fn)`:** a run of that workspace as the worker, one transaction per call, for the source's own reads and writes (an account to read with, a quota to reserve). Never around a vendor's call.
- **The answer:** `{ found: true, facts }`, with `provider` when another provider than the definition's answered (`brave`), which then stamps the facts; or `{ found: false }`, `not_found`, with `outcome` for the source's own word for a skip (`no_account`, `ambiguous`). Such an outcome counts as the company tried only when `ANSWERED` lists it. A failure is thrown, and recorded with its code.
- **Off the rules:** an outcome that is no code (`CODE`), or is `found` or `failed`, and a provider off providers' `ADAPTER_NAME`, are recorded `failed` as `enrichment_source_invalid`, with one warning, nothing written.

## A name that cannot run

A name in a list that cannot run is left out, never an error (the owner's rule, 2026-11-13): a name no source of the list's kind defines (`source_unknown`), an adapter the registry does not know (`provider_unknown`), or one without its key or contact (`config_invalid`, with the variable). Each adapter loads on its own, since one that cannot load fails a whole list's call. At start, the worker logs one warning per list, naming each name, its reason and its variable, never a value, and starts with the rest. deploy:check refuses those names before a deploy (gamma-en-051): its table, `SOURCE_NAMES` in `deploy/scripts/constants.ts`, holds each list's names, and `tests/deploy-table.test.ts` fails until a new source's name is there.

## Allowances

`source_usage` counts each source's calls per UTC day or month for the whole instance, shared by every workspace: free plans are the instance's accounts. A call is counted before it goes, whatever it answers. A source past its allowance is skipped with `allowance_spent` and makes no call. A vendor's `*_allowance_spent` marks the period spent. A source with no allowance is counted by the day with no limit, and a vendor's word still stops it until the day ends.

**The web search is counted once for the whole server** (gamma-wr-010). Every module that searches calls `searchWeb(request)` (`domain/web-search.ts`), never an adapter: the adapters of `PROVIDER_WEB_SEARCH` in order, each inside its allowance under `web-search/<adapter>`; a spent or failing adapter passes the search on, and a vendor's `web_search_allowance_spent` marks its counter spent. The reservation is one conditional update, so two callers at once never pass an allowance together. The source `web-search` is its first caller.

## What starts a run

- **The tick:** the schedule `enrichment.tick`, every `ENRICHMENT_TICK_MINUTES`, skipping a tick while one runs, starts `enrichment_batch` for each workspace with a held lead, one batch per workspace at a time (`enrichment.batch:<workspaceId>`).
- **The batch:** up to `ENRICHMENT_BATCH_SIZE` held leads, oldest first, each with its `new_lead:<personId>` run as a child workflow, one after another. A lead whose key has a run already gets no second one: its hold is released.
- **A request:** `requestEnrichment`, then its event's subscriber starts the run as `enrichment.run:<workspaceId>:<runId>`, so a redelivery starts none. A request is asked whatever the retry days say.

## Testing

`testing/index.ts`: `useEnrichmentClient`, `createRun`, `useClock` and `useSourceLists`. The module's tests are unit and database tests (`pnpm -F enrichment test`, `test:tenancy`); the end-to-end runs on the fake port are the worker's `tests/enrichment-run.test.ts`, the histories `workflows/__histories__/enrichment_run.json` and `enrichment_batch.json` (`pnpm -F worker test:replay`).

## Decided here

- **The order is the config's;** the workflow never decides one of its own.
- **An earlier source wins;** a field filled in a run is never overwritten, and a later run wants only empty fields and old facts (gamma-rf-020). Contacts keeps a member's value whatever happens.
- **Allowances are the instance's;** a failed call still counts, the safe side for a free plan.
- **The hold always ends:** done, failed, skipped or erased, and contacts' own limit releases it anyway.
- **Errors never stop a run:** whatever a source fails with is recorded with its code, never its message, with one warning, and the next source is asked. A `provider` or `ai` source's step runs once; `db` steps keep the host's retries.
- A field a member set or cleared is never wanted.
- A run `running` for more than 60 minutes no longer holds its company.
- A company key that another company of the workspace holds, or that contacts refuses, is written again without the page, then without the domain.
- `source_usage.period_start` is text, `YYYY-MM-DD`: the schema lint takes no `@db.Date`.
- `ENRICHMENT_COMPANY_SOURCES` empty is its default, `company-data` (an empty setting is unset); an empty `PROVIDER_COMPANY_DATA` turns the company part off.
- Error keys sit under `enrichment.errors.*`, the codebase's convention; the outcomes' keys come with the panel that shows them (gamma-en-055).
- A run whose person privacy erased under way finds no row: its steps write nothing more and fail none.
- A source's late answer, past its step's timeout, writes nothing once the workflow recorded the source or the run ended: the run's writers take its lock (`lockedRun`). A `db` step tried again after its write answers the source's record, so the workflow sees what the run kept.
- A list's names are trimmed and an empty one dropped (`linkedin, company-data`); a list of spaces or commas only is empty, so its default.
- **Old facts** (gamma-rf-020): the age is the stamp's, the one contacts answers, so after gamma-rf-010 the first run that meets an old shared fact renews it, on the layer its source's class goes to. No schedule: an old fact is asked again only by a run made for its company anyway, a new lead's or a member's request, and the retry days still keep a new lead from asking a company tried for every field wanted now. A value with no stamp is never old; one exactly `ENRICHMENT_FACT_DAYS` old is not older. A renewed fact is in `filled` when its stamp changed, even with the same value. The prepare step passes the run's time and the days to `plan.ts`, which stays pure; the workflows did not change, so their histories replay.

## The source `web-search` (gamma-en-070)

A company known only by its name, with no LinkedIn page and no website, gets both from a web search, so that the sources that need a page or a domain run on them (the pass restarts on a new key). `domain/sources/web-search/`: kind `company`, needs `name`, fills `linkedinUrl` and `domain`, activity kind `provider` with its own 45-second timeout, provenance class `web_search` with the adapter that answered as the provider (`brave`). Add `web-search` to `ENRICHMENT_COMPANY_SOURCES` once `PROVIDER_WEB_SEARCH` names an adapter with its key.

- **Not a company:** a name of fewer than 2 characters or more than 150, or one of `NOT_A_COMPANY_NAMES` (self-employed, freelance, stealth, retired, student, open to work, n/a and the like), compared folded and cleaned, makes no search: `not_a_company`.
- **The searches,** at most two per company in a run, each only for a field still wanted: `"<name>"` on the site `linkedin.com`, then `"<name>" official website`, 5 results each. A query holds the name and those fixed words only.
- **The adapters:** each search goes to the first adapter of `PROVIDER_WEB_SEARCH` with room in its allowance, counted under `web-search/<adapter>`; a spent one, or one whose search fails for any reason, passes it to the next, and a vendor's `web_search_allowance_spent` marks its counter spent. With none left, the source ends `allowance_spent` when every adapter was spent, else `failed` with the last error's code, and no second search follows. `PROVIDER_WEB_SEARCH` empty: `no_adapter`.
- **The pick,** in code (`pick.ts`): names compared cleaned (`names.ts`: lower case, accents folded, punctuation dropped, the legal forms at the end dropped). The page: a `linkedin.com/company/<slug>` result, on any subdomain, whose title without its `| LinkedIn` ending is the name, kept as `https://linkedin.com/company/<slug>`. The website: a host off `NOT_A_HOMEPAGE` (social networks, directories, news and job sites) whose first label is the name without spaces or starts with it, or whose title starts with the name; the domain is its host without `www.`, a host and its subdomains one site. Two different matches: `ambiguous`, nothing written; none: `not_found`. Only the chosen page and domain leave the activity.

Decided here (gamma-en-070):
- The port takes a host, never a path, so the page's search has the site `linkedin.com` and the pick keeps the `/company/<slug>` pages.
- The lists (`NOT_A_COMPANY_NAMES`, `LEGAL_FORMS`, `NOT_A_HOMEPAGE`) are in `web-search/constants.ts`, the owner's constants rule; `names.ts` reads them.
- A legal form is dropped only from a name's end, while a word is left before it.
- A provider source may set `timeoutSeconds`; web-search's is 45 seconds, room for two searches with one adapter passed on.
- `not_a_company` and `ambiguous` count as the company tried (`ANSWERED`): the same name answers the same until the retry days pass.
- A search that ends with no adapter left ends the source; the second search is not made. When both searches found something on different adapters, the first adapter stamps both.

## The source `website` (gamma-en-065)

A company with a domain has a few of its own pages read, and the AI picks out its industry, size, headquarters' country and a short description, each with a quote from a page. `domain/sources/website/`: kind `company`, needs `domain`, fills `linkedinUrl`, `industry`, `sizeRange` (with the headcount), `country` and `description`, activity kind `ai` with its own 180-second timeout and a heartbeat per page, provenance class `website`, provider `website`. Add `website` to `ENRICHMENT_COMPANY_SOURCES`; it costs no credit.

1. **The pages** (`site.ts`): the platform's reader (`readSite`, core/packages/platform/README.md "The site reader") on `https://<domain>/`, at most `ENRICHMENT_SITE_MAX_PAGES` (5) pages in 60 seconds: robots.txt, the home page, then about, company, team, contact, imprint (impressum), legal and careers (`SITE_PREFERRED`), then the navigation's links. robots.txt allowing no reading of the home page records `blocked`, with no page read and no AI call; a site that cannot be read records the reader's code (`egress_*`, `fetch_failed`) as its outcome.
2. **The browser:** a page whose text is under 200 characters is asked again of the `browser` port (`PROVIDER_BROWSER`), and its rendered text and links kept when it shows more. Every page the reader answers is one robots.txt allows. `browser_unavailable`, any other error, an error status or no browser set keeps the plain page.
3. **The LinkedIn page,** in code (`facts.ts`): the first link of the pages, footers' included, to `linkedin.com/company/<slug>` (any subdomain), kept as `https://www.linkedin.com/company/<slug>`; a person's `/in/` page never.
4. **The AI** (`agents/read-company-site/`), while a wanted field other than the page is still empty: `enrichment.read-company-site` through `callAgent`, the company's id as its subject, with the company's name, the fields wanted and the pages cut to 60,000 characters in all. Each value names its page and quotes it; the `grounded` gate refuses a quote that is not in its page, and an answer that fails twice throws `enrichment_site_ai_failed`: the source records `failed` and writes nothing, the LinkedIn page included. A country is kept only when contacts' `countryCode` knows it; a size range as contacts takes it (`51-200`, `500+`).

Tests: `tests/website-source.test.ts` (local pages on 127.0.0.1, the LLM fake and the browser fake), the worker's `tests/enrichment-run.test.ts` (a company with only a domain, filled), the evals `core/packages/ai/evals/enrichment.read-company-site/` on the fake.

### Decided here (gamma-en-065)

- A site that cannot be read (an egress code, `fetch_failed`) is the source's own outcome, not a failure: the site is down or not HTML, nothing of ours failed. It does not count as the company tried.
- The rendered page replaces the plain one only when it shows more text; its links join the plain page's.
- The AI's input is cut by characters and by UTF-8 bytes as the blocks write them (81,000), so a site in three-byte characters stays within the 30,000 input tokens rather than failing `ai_budget_exceeded`.
- The source step stays one attempt (gamma-en-050's rule for `provider` and `ai` sources); the model's retry is `callAgent`'s, one.
- An `ai` source gets the activity's heartbeat through `SourceContext.beat`, so that `domain/` imports nothing of Temporal.

## The lead page

gamma-en-055: the lead page's company facts and "Enrich now". `api` is mounted under `/v1/workspaces/{workspaceId}/enrichment`:
- `GET …/enrichment/leads/{personId}` (`enrichment.read`): `company`, `{ name, fields: [{ field, value, sourceClass, at }] }` for `domain`, `linkedinUrl`, `industry`, `sizeRange`, `employeeCount`, `country` and `description` in that order, read through contacts with their provenance, an empty field with all three null, or null for a person with no company; `person`, `{ country: { value, sourceClass, at } | null }`; `lastRun`, `lastRunOf(personId)` with `outcomes`, what its sources answered (`sourcesTried`), each outcome once in the order first answered, never a source's name. The class is contacts' (`open_data`, `data_vendor`, `member`…), never a provider's name (RB-7.3.2). 404 `enrichment_person_not_found` for a person the workspace does not hold.
- `POST …/enrichment/leads/{personId}` (`enrichment.run`, `Idempotency-Key` required): `requestEnrichment({ personId, requestKey })` with the key as the request key, 202 `{ runId, status }`; the same key answers the same run, a day later too. Free: no credits.

The panel (`ui/company-panel/`, `panels` in `ui/nav.ts`) sits in contacts' `company` slot, under the evidence. It reads that route as the member: each field's value and a line with its class's words (contacts' `contacts.provenance.source.*`) and date, "Not found yet" for an empty one, "Set by a member" for a member's; the lead's country the same way; "Last enriched {date} · {count} fields filled" or "Not enriched yet", and under it what the sources answered, in words (`enrichment.outcome.*`: en-050's outcomes, web-search's `not_a_company`, `ambiguous` and `no_adapter`, linkedin's `no_account` and `no_reads_left`, and country-ai's `no_place`, `not_sure`, `unknown_country` and `ai_failed`; an outcome without words reads "Skipped", and a source that adds one adds its words to `useOutcomeWord` and the messages). "Enrich now" shows for a role holding `enrichment.run` (`GET /v1/me`); while the person's run is `queued` or `running` it is disabled and reads "Enriching…", and the panel reads the route every `POLL_INTERVAL_MS` (3 s) for `POLL_LIMIT_MS` (60 s) at most, then stops and offers Refresh. The kit's loading, error-with-retry and empty states. The routes' test is the api's `tests/enrichment-route.test.ts`, the panel's `core/apps/web/tests/enrichment-company-panel.spec.ts`, on runs the e2e module ends as the fake port's would (the e2e api runs no worker).

Decided here (gamma-en-055):
- The routes sit under the module's mount, `…/enrichment/leads/{personId}`, not `…/leads/{personId}/enrichment`: the host mounts a module's `api` under its own name.
- An empty field answers its class and time null too, a cleared member's value included: the panel reads "Not found yet" for it.
- The message keys are `enrichment.company_panel.*`: a key's segment takes no hyphen (platform's i18n).

## The source `linkedin` (gamma-en-060)

A company with a LinkedIn page gets its website's host, industry, size, headquarters' country and description from the page itself, read through one of the workspace's LinkedIn accounts. `domain/sources/linkedin.ts`: kind `company`, needs `linkedinUrl`, fills `domain`, `industry`, `sizeRange`, `country` and `description`, activity kind `provider` (15 seconds), provenance class `linkedin` with the LinkedIn adapter that read the page as the provider (`unipile`, or `fake` in tests). Add `linkedin` to `ENRICHMENT_COMPANY_SOURCES` (`linkedin,company-data`) on an instance whose workspaces have LinkedIn accounts.

- **The read** is the linkedin module's `readCompany`: the account with the most company reads left now reads the page, inside its daily reads, its window and pauses, and its share `LINKEDIN_COMPANY_READS_PER_DAY` (linkedin README "Company pages"). The source has no allowance of its own.
- **Skips, never failures:** no connected account (`no_account`), none with reads left now (`no_reads_left`); the next source runs, and the company is tried again on a later run (neither is in `ANSWERED`). An unknown page is `not_found`.
- **The facts,** only those the run wants: the website's host, lower case, without `www.`, as the domain; the size band as company-data's range text, the headcount beside it; the headquarters' country code. The page's name and link are not written.

Decided here (gamma-en-060):
- The provider stamped is the adapter named by `PROVIDER_LINKEDIN`, the one that read the page.
- The worker test of a run keeps its stand-in source `test-by-page`; the `linkedin` source has its own two tests beside it.

## The source `country-ai` (gamma-en-075)

A lead's country, when contacts' place list could not read its location (contacts' README "The place list"): the AI names it from the location text alone. `domain/sources/country-ai.ts`: kind `person`, needs `locationText`, fills `person.country`, activity kind `ai` with a 60-second timeout, provenance class `ai_inferred`, provider `country-ai`. Add `country-ai` to `ENRICHMENT_PERSON_SOURCES` (the production example has it).

- **When:** for a person whose country is empty and not a member's, and whose location is not; a location the list reads has its country at creation, so it is never asked.
- **No call:** a text naming no place, only "Remote", "Worldwide", "Global", "Anywhere", "EMEA", "APAC", "LATAM", "Europe", "Asia" or "Africa" (contacts' `namesNoPlace`): outcome `no_place`.
- **The call:** the agent task `enrichment.name-country` ([its README](agents/name-country/README.md)) through `callAgent`, with `subjectRef` `location:<sha256 of the cleaned text>`: a location seen before in the workspace is the cached answer, no model call. A test sets its client and prices with testing's `useAgentCall`, shared with the website source (`domain/sources/agent-call.ts`).
- **What is written:** only a sure answer whose code contacts' `countryCode` knows, through `recordPersonCountry`, which keeps a member's country and one read later. The rest writes nothing, each its own outcome: `not_found` (null), `not_sure`, `unknown_country`, `ai_failed` (the answer failed its schema or gate twice).
- **Settings:** `AI_MODEL_ENRICHMENT_NAME_COUNTRY`, empty by default: the LLM port's first model.
- **Testing:** `tests/country-ai.test.ts` on the LLM fake; the worker's `tests/enrichment-run.test.ts` runs it end to end.
- **Decided here:** the model gets the cleaned text, not the raw one, so that "Greater Rhine-Neckar Area" and "Rhine-Neckar" share one cached answer; a missing task is `enrichment_agent_not_loaded`, recorded as the step's code like any failure.

## Email lookups (gamma-en-080)

A person's work email, found and verified just in time: a day before their first email step (`jit_step`, gamma-p4-010), or on a member's request. An address becomes a contact point only on a verifier's `valid`. Owns `contact_points`, `enrichment_requests`, `enrichment_cache_entries` and the global `email_domain_statuses` ([docs/data.md](docs/data.md)), and the workflow `enrichment_lookup`. The route and the lead page's Email panel are a follow-up (part 2).

| | |
|---|---|
| `requestLookup({ personId, requestKey, trigger?, address? })` | a lookup, `jit_step` by default, `request`, or `found` (a lead research found, gamma-wr-070; "The lookup at find"): `{ requestId, status }`. The request written `queued` and `enrichment.lookup_requested { requestId }` published in the same run. A key given again answers its request; one left `waiting_budget`, `waiting_allowance` or `failed` is queued again as its next attempt. A key is its person's: the same key for another person is `enrichment_input_invalid` (`requestKey`). `enrichment_input_invalid`, `enrichment_person_not_found` |
| `requestReverification({ personId, requestKey })` | the person's active address checked again now, whatever its age; free |
| `workEmailOf(personId)` | `{ contactPointId, verifiedAt }` of the active, valid address an email may go to, a work one first; null for none. Never the address |
| `addressOf(contactPointId)` | the address itself, for the email builder; null unless active and valid |
| `markBounced(contactPointId, { at })` | the address bounced: neither reader answers it, and its key's entry turns negative |
| `defineSource({ kind: "email", ... })` | an email source of a later task (`reply`, `linkedin-contact-info`): its candidates, with `anyDomain` for the lead's own addresses |
| `prices` | `enrichment.work_email`, `ENRICHMENT_CREDITS_PER_EMAIL` per verified address |

**The order is the config's:** `ENRICHMENT_EMAIL_SOURCES` (default `email-finder`) orders the sources, `email-finder` expands into one source per adapter of `PROVIDER_EMAIL_FINDER`, and `PROVIDER_EMAIL_VERIFIER` gives the verifiers' turns. Each candidate goes to the verifiers in turn until one gives a verdict; a verifier with no free calls left, or one that fails, passes it to the next. The lookup stops at the first `valid`, a `catch_all` on a work address, `ENRICHMENT_EMAIL_MAX_CANDIDATES` verified, or no source left ([docs/flows.md](docs/flows.md) "The lookup").

**Credits:** reserved before the first outside call (`enr:<requestId>:<attempt>`), committed only for a valid address no other person holds that Whytide found (the website, the pattern, a finder), released on any other end. An address the lead gave, from a source with `anyDomain` (`reply`, `linkedin-contact-info`), is free: its reservation is released (gamma-en-100). The free ends reserve nothing: suppressed, an address verified within `ENRICHMENT_EMAIL_VALID_DAYS` (120 unset; "Settings"), no name, a cached answer, no verifier with a call left this period. No domain, a catch-all domain or the credits short run the lead's own sources only, reserving nothing, and end as before when they keep nothing; a list of the lead's own sources only reserves nothing ("The owner's changes after the run", below).

**Personal addresses** come only from a source with `anyDomain` (what the lead gave). For a lead in the UK, the EU or the EEA, or with no known country, they are skipped while `ENRICHMENT_PERSONAL_EMAIL_EU_UK` is false (the owner's decision of 2026-11-13), and neither reader answers one held earlier, nor does a re-verification send one to a verifier (`personal_needs_consent`). Nothing is deleted: switching it on uses them again.

**A blocked address** (gamma-rf-040): `keepAddress` records a verified address for its person in contacts (`recordPersonEmail`, the address's keyed hash in `person_email_hashes`) before it stores a contact point. An address the never-contact list holds, on every channel or on `email`, keeps nothing, neither a contact point nor a cache entry: the lookup ends `skipped_suppressed` (`suppressed`), its credits released, and a live cache entry of it ends the lookup the same way at its prepare. One another person holds, or an erased person left, ends as an address held by another person does. `pnpm -F enrichment emails:record [--workspace <id>]` records each contact point kept before (every status, in batches of `RECORD_BATCH`, 500, ids, one run per contact point), once, right after the migration; it is safe to run again and changes no contact point ([docs/runbook.md](docs/runbook.md)).

**Testing:** `testing/index.ts` adds `createContactPoint`, `createCacheEntry`, `useEmailLists` and `usePersonalEmailEuUk`. `pnpm -F enrichment test:safety` runs the send path's cases (`tests/safety/`); the end-to-end runs are the worker's `tests/enrichment-lookup.test.ts`, the histories `workflows/__histories__/enrichment_lookup.json` and `enrichment_lookup_reverify.json`.

Decided here:
- **One rule for every source:** only a verifier's `valid` keeps an address. A finder's own `invalid` drops its candidate before any verifier; its `valid` is not trusted.
- **Never retried:** a source's or a verifier's error is recorded with its code and the next one asked (the owner's rule). A candidate no verifier could check ends the lookup: `waiting_allowance` when one had no calls left, else `failed` (`provider_error`) with the last code. Neither writes a cache entry, so an outage never leaves a negative answer.
- **A source name is unique within its kind,** so an email source may share a company source's name; `email-finder` is reserved.
- **Seen once:** a candidate seen earlier in the lookup is dropped (`seen`); the dropped ones are not stored, so the lead's own source may propose an address a finder's answer had off the domain.
- Every source failing or out of calls ends `failed` (`provider_error`, the last code), its credits released and no cache entry.
- `personal_needs_consent` writes no negative entry: the switch may come on.
- An address the person holds as bounced or opted out is never given back (`bounced`).
- A cache hit's contact point carries the class `email_finder` and the entry's provider.
- The no-verifier check comes before the reservation; a request queued again resets `providers_tried`.
- The EU and UK country list is a copy of privacy's (`CONSENT_COUNTRIES`): privacy imports enrichment, so enrichment cannot import privacy.
- A blocked address writes no negative cache entry (gamma-rf-040): the block may be lifted, and the next lookup asks the list again. `keepAddress` records the address only when no other person's contact point holds it, so another person's address never writes a hash for this one. The script lives here, since contacts never imports enrichment, and prints ids and counts only, never an address.

## The source `linkedin-contact-info` (gamma-en-087)

The email addresses a lead shows their 1st-degree connections in LinkedIn's "Contact info", offered to the lookup as candidates, a personal address included. The owner's exception of 2026-11-13 to the rule against reading that section, for now, to be turned off later (`docs/rules/security.md` §1). `domain/sources/linkedin-contact-info.ts`: kind `email`, activity kind `provider` (15 seconds), `anyDomain`, provenance class `linkedin_contact_info` with the LinkedIn adapter that read as the provider (`unipile`, or `fake` in tests).

- **The switch:** the linkedin module's `LINKEDIN_CONTACT_INFO_ENABLED`, `false` by default. Off, the source is skipped with the outcome `disabled`, even when `ENRICHMENT_EMAIL_SOURCES` lists it: no read is reserved and nothing is called. Two gates: this source checks `contactInfoEnabled()`, and the linkedin module's `readContactEmails` checks it again before any read.
- **The read** is the linkedin module's `readContactEmails` (its README "Contact info"): through the workspace's connected account whose invitation the lead accepted, one `read_profile` read inside its daily reads, window and pauses. No such account: `not_connected`; none with reads left now: `no_reads_left`; both a skip, never a failure. The source has no allowance of its own.
- **The candidates** are the lead's own addresses, so they may sit at any domain: an address at the company's domain first, then the others, such as a personal one, which follows the UK and EU switch (`ENRICHMENT_PERSONAL_EMAIL_EU_UK`). Each goes to the verifiers' turns and is kept only on `valid`, as `work_email` at the company's domain, else `personal_email`.
- **The order:** the production example lists it after the lead's reply and before the website, the pattern and the finders: `reply,linkedin-contact-info,website,pattern,email-finder` once gamma-en-085's sources are in; until then `linkedin-contact-info,email-finder`.
- **Off stops new reads only.** An address it found stays a contact point like any other: `workEmailOf` and `addressOf` answer it, it is verified again and erased as any other. Nothing is deleted when the switch goes off; any deletion needs the owner's explicit approval.
- **Its outcomes' words** on the panel: `disabled` and `not_connected` (`enrichment.outcome.*`), `no_reads_left` as the `linkedin` source's.
- **Testing:** the worker's `tests/enrichment-lookup.test.ts`: on, with a work and a personal address; a lead not connected; off; off after an address was found. The linkedin module's `tests/read-contact-emails.test.ts` covers the switch, the account's choice and the quota.

Decided here:
- **A catch-all company domain, or none, no longer ends the lookup first** (gamma-en-100, the owner's decision of 2026-11-14): this source and `reply` run first ("The owner's changes after the run", below). A lookup still needs the lead's name before any source runs, this one included.
- An address read but never verified `valid` is not stored, as every candidate's: it lives in the lookup's raw file for 72 hours at most.

## The Email panel (gamma-en-081)

The lead page's email and its request, on the lookup's `requestLookup`, `requestReverification` and the contact points ("Email lookups"):
- `GET …/enrichment/leads/{personId}/work-email` (`enrichment.read`, `api/work-email.controller.ts`): `email`, the address "Verify again" checks (the person's active one, a work one first, whatever its verification), `{ address, kind, verification, sourceClass, verifiedAt, acquiredAt, needsConsent }`, or null; `lastLookup`, the newest request, `{ requestId, trigger, status, reason, finishedAt }`, or null. `needsConsent` is true for a personal address of a lead whose country needs consent while `ENRICHMENT_PERSONAL_EMAIL_EU_UK` is off. Never a finder's or verifier's name, nor `providers_tried` or an error code (RB-7.3.2). 404 `enrichment_person_not_found` for a person the workspace does not hold.
- `POST …/enrichment/leads/{personId}/work-email` (`enrichment.run`, `Idempotency-Key` required), body `{ action: "find" | "verify" }`: `find` is `requestLookup` with the trigger `request` and the key `request:<key>`, priced at `enrichment.work_email` and charged only for a verified address; `verify` is `requestReverification` with the key `reverify:<key>`, free. 202 `{ requestId, status }`; the same key answers the same request, and the same key with the other action is 422 `idempotency_key_reused` (the host's). While the person has a request `queued` or `running`, whatever its trigger (another tab, another member, the email step's), a press answers that one and writes none, so no second reservation is made; the person's advisory lock (`LEAD_EMAIL_LOCK`) makes two presses at once one.

The panel (`ui/email-panel/`, the second `panels` entry in `ui/nav.ts`) sits in the `company` slot, under the company panel. It shows the address, its kind and its class in words (`enrichment.email_panel.source.*`: the finders' `email_finder`, gamma-en-087's `linkedin_contact_info`, gamma-en-085's `lead_reply`, `website` and `pattern`; a class without words reads "another source", and a source that adds a class adds its words to `useSourceWord` and the messages), then "Verified {date}" or "Checked {date}: {verdict}"; a personal address waiting for consent reads as not used, with why (`enrichment.email_panel.personal_needs_consent`). Without an address: the line that one is looked up 24 hours before the first email step, or "No usable email yet". A lookup that ended without an address adds "Last lookup {date}: {reason}", one message per reason of `MISSING_REASONS`. For a role holding `enrichment.run`: "Find email" with its price first in the kit's `PriceTag` (credits' `GET …/credits/prices`, unit `enrichment.email_panel.price_unit`), or "Verify again", free, when an address is held. While the lookup is `queued` or `running` the button reads "Looking up…" and waits, and the panel reads the route again as the company panel does (`POLL_INTERVAL_MS`, `POLL_LIMIT_MS`, then Refresh). The routes' test is the api's `tests/enrichment-email-route.test.ts`, the panel's `core/apps/web/tests/enrichment-email-panel.spec.ts`, on lookups the e2e module ends as the fakes would (the e2e api runs no worker).

Decided here (gamma-en-081):
- One POST with an `action`, not a second route: "Verify again" and "Find email" are the same request with a different price, and the host's idempotency check covers the body.
- The panel shows the address "Verify again" checks (`activePoint`), even when it is no longer valid, with its verdict; "Find email" shows only when the person holds no active address.
- The panel sits in the `company` slot under the company panel, as gamma-en-081 asks, not p3-010's `outreach`.
- The message keys are `enrichment.email_panel.*`: a key's segment takes no hyphen (platform's i18n).

## The sources reply, website and pattern (gamma-en-085)

Three free email sources, each a candidate's proposer only: a verifier's `valid` keeps an address, by gamma-en-080's rule, and its credit is the same, whichever source found it. The production order is `ENRICHMENT_EMAIL_SOURCES=reply,linkedin-contact-info,website,pattern,email-finder` (gamma-en-087's source second, off by default): the verifiers' free checks are many and the finders' free searches few, so guesses come before the finders. Their names are in deploy:check's table.

- **`reply`** (`domain/sources/reply.ts`, class `lead_reply`, `anyDomain`, activity `db`): the addresses the lead wrote in their own LinkedIn messages, through inbox's `addressesGivenBy(personId)` (inbox's README "Addresses a person gave"), set with `useAddressesGiven` below: their inbound messages only, the newest 5 that hold an address. Role addresses are ignored. A message holding one address gives it; one holding several gives only those whose local part holds the lead's first or family name, cleaned, the others being likely a colleague's. An address at the company's domain first, then the others; a personal one follows `ENRICHMENT_PERSONAL_EMAIL_EU_UK` (the find step's `personal_needs_consent`).
- **`website`** (`domain/sources/website/email.ts`, class `website`, activity `provider`, 150 seconds): the company's site, read as gamma-en-065's source reads it (`readCompanySite`, the browser for a short page), contact, team, about, imprint (impressum) and legal pages first, at most `ENRICHMENT_SITE_MAX_PAGES`. In code (`domain/email/site.ts`), the addresses at the company's domain in the pages' text and `mailto:` links (the platform's reader answers them, footers' included), role addresses ignored (`domain/email/roles.ts`):
  - an address whose local part is a pattern of the lead's names is a candidate;
  - the others give the domain's pattern: a local part of two names joined by `.`, `_` or `-` directly, any other only when a full name within 200 characters of it on the page fits it. The pattern most agree on (a tie, the earlier in `PATTERNS`) is recorded seen: its row of `email_domain_patterns` gets `site_seen_at`, its count unchanged (gamma-rf-030); outcome `pattern_found` when the lead's own was not there. The addresses and names themselves are dropped in the activity.
  - robots.txt allowing no page is `blocked`; a site that cannot be read, the reader's code.
- **`pattern`** (`domain/sources/pattern.ts`, class `pattern`, activity `db`): guesses at the company's domain. A domain recorded catch-all gets none (`catch_all_domain`, F06 §9), whatever patterns it has. With patterns verified or seen within `PATTERN_DAYS` (180), one guess per pattern, at most `KNOWN_PATTERN_GUESSES` (2), in this order: the higher count, then the later verification, then the later sighting on the site, then `PATTERNS`' order (gamma-rf-030); without one, the common patterns in this order: `{first}.{last}`, `{first}`, `{f}{last}`, `{first}{last}`, `{f}.{last}`, `{first}_{last}`, `{last}`. Never more than the lookup's bound still allows (`room`, below). No name left after cleaning, or no room: `no_guess`.
- **Names** (`domain/email/names.ts`, its table of cases): lower case, accents folded (ü to u, ß to ss, ø to o, ł to l), letters only; the first given name and the whole family name ("José María García-López" is `jose`, `garcialopez`).
- **The pattern verified:** a domain keeps every pattern seen there, one row of `email_domain_patterns` each (gamma-rf-030, [docs/data.md](docs/data.md)). The settle of a lookup that made a new contact point of a work address at the company's own domain, never a subdomain, adds 1 to the count of the pattern its local part fits and sets `last_verified_at`, whatever source found it, so the next lead there gets the most proven pattern first (`countedPattern`, `domain/email/patterns.ts`). An address renewed on the person who already holds it counts nothing (`keepAddress` answers `created`), nor does a re-verification. Each write is one statement and nothing replaces anything: a site's pattern and a verified one are two rows. A pattern past its days is only left unread. The pattern names are a fixed list, `PATTERNS` in `domain/email/constants.ts`, and the migrations' CHECKs hold the same.
- **`room`:** each email source's input carries how many candidates the lookup may still verify, `ENRICHMENT_EMAIL_MAX_CANDIDATES` less those kept so far (`EmailSourceInput.room`).
- **Outcome words:** `catch_all_domain`, `pattern_found` and `no_guess` have their words in the panel's `useOutcomeWord` and `enrichment.outcome.*`.
- **Inbox's reader, set by inbox:** enrichment never imports inbox (inbox imports campaigns, which imports enrichment). `useAddressesGiven(reader)`, exported from `index.ts`, takes inbox's `addressesGivenBy`, which inbox's `onWorkerStart` sets; without a reader `reply` finds nothing (`not_found`).
- **Testing:** `tests/email-sources.test.ts` (the names, the roles, the patterns, the site's inference, the reply's candidates, the guesses, the website source on local pages; gamma-rf-030: the order, the bound, the writes, the migration's copy), `tests/settle.test.ts` (what counts), `tests/safety/email-sources.test.ts` (`test:safety`; no guess at a catch-all domain with patterns known), the worker's `tests/enrichment-lookup.test.ts` (a lookup through `reply,website,pattern,email-finder` on the fakes and local pages; a lookup at a domain with two patterns).

Decided here (gamma-en-085):
- **Other people's addresses are never kept:** the site's other addresses become one pattern's name in the activity and are dropped; the reply source takes only the lead's own of a message holding several.
- **No guess at a catch-all domain:** the pattern source answers `catch_all_domain` with no candidate. At a recorded catch-all domain the prepare runs only the lead's own sources since gamma-en-100, and their addresses at that domain are dropped (`catch_all_domain`), so a personal address the lead wrote is still found.
- A two-name local part's order is read as given name first (`john.smith`, `{first}.{last}`); with a name beside it on the page, the name decides (`smith.john`, `{last}.{first}`).
- An address whose local part fits the lead's names is the lead's own, even a bare `{first}` one: the verifier decides whether it exists.
- The website source's `mailto:` addresses come from the platform's reader (`SitePage.mailto`), a change outside this module.
- A pattern row of a domain never found catch-all has `catch_all` false and its catch-all status expired at its writing; the prepare's catch-all check reads `catch_all` and `expires_at` as before. Since gamma-rf-030 no such row is written: `email_domain_statuses` keeps the catch-all status only, its three pattern columns unused until the owner approves their drop.

Decided here (gamma-rf-030):
- **Two guesses at most when patterns are known,** so a finder keeps room in the lookup's bound and verifier checks are not spent on unlikely formats; a domain with one known pattern still gets one guess.
- **A row is read whole:** a pattern seen on the site within 180 days is read with its whole count, however old its verifications.
- **The two times only move forward** (`GREATEST`): a late write never sets an earlier time.
- **The count is the instance's,** as the pattern was: the same address kept in two workspaces counts twice; no address and no person is stored to tell them apart.

## The owner's changes after the run (gamma-en-100)

The owner's four decisions of 2026-11-14; two are this module's, in the lookup's prepare and settle ([docs/flows.md](docs/flows.md) "The lookup"). The workflow's code is unchanged, so a lookup started before replays.

- **The lead's own sources first:** no company domain, a company domain recorded catch-all, or the credits short no longer end a lookup before any source. The prepare plans only the listed sources with `anyDomain` (`reply`, `linkedin-contact-info`), in the list's order, reserves nothing, and keeps the reason on the running request (`reason`: `no_domain`, `catch_all`, `insufficient_credits`). With none listed, or no verifier with a call left, it ends there as before. The settle keeps a verifier's `valid` on an address no other person holds; any other end is the plan's own, as before: `not_found` (`no_domain`, `catch_all`) or `waiting_budget` (`insufficient_credits`), with no cache entry. At a catch-all domain the find step drops their addresses at that domain (`catch_all_domain`): none could be `valid` there. A personal address follows `ENRICHMENT_PERSONAL_EMAIL_EU_UK`, as any.
- **Free when the lead gave it:** an address from a source with `anyDomain` commits no credit in any lookup; its reservation, made for the sources after it, is released. One from the website, the pattern or a finder commits `enrichment.work_email` as before. A list of the lead's own sources only reserves nothing.
- The Email panel's route answers no `reason` while a lookup is `queued` or `running`.
- **Testing:** `tests/safety/own-sources.test.ts` (`test:safety`: the prepare's plans and reservations, the outcome tables), `tests/settle.test.ts`, and the worker's `tests/enrichment-lookup.test.ts` (no domain, a catch-all domain, a workspace with no credits, a reply's address free).

Decided here (gamma-en-100):
- **The plan's reason lives on the request** (`reason`, while it runs): the workflow's input and the prepare's result stay as they were, so the histories replay, and the settle and the find step read it under the request's lock.
- **Anything kept nothing ends with the plan's reason,** a held, bounced or not verified address and a failure included: the end the prepare gave before.
- **A lookup of the lead's own sources releases** any reservation the request holds rather than leaving it, and a prepare tried again writes its reason (or none) each time.
- **Free is `anyDomain`:** the settle asks the source's definition whether it has `anyDomain`, so a later source of the lead's own is free too, with no list of classes.

## Settings

Two values of the email lookup that were constants until env-settings-b (the owner's request of 2026-11-15), in the `modules/enrichment` block of `deploy/.env.example`, each a whole number of days of 1 or more with no maximum, its default in `domain/lookup/constants.ts`. Unset or empty, the default applies; a value that is not a whole number of 1 or more stops the worker's and the api's start with `config_invalid` naming it. Each is read once, as the module loads: **a changed value needs an api and worker restart**. The entries and requests written before keep their dates; the new days apply to what is written or read after.

- `ENRICHMENT_EMAIL_VALID_DAYS` (120, `EMAIL_VALID_DAYS`): how long a verified address is trusted before it is checked again: a lookup ends `found` on the person's address verified within it (`validSince`, `domain/lookup/points.ts`), and an `email` cache entry lasts it. **Caution:** the value comes from the research rules (RB-7.3.3); lowering it costs more paid checks, raising it trusts older addresses.
- `ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS` (30, `NOT_FOUND_RETRY_DAYS`): after a lookup finds no usable address, how long its `negative` cache entry lasts, so that the person is not looked up again before (`cached_negative`).

`ENRICHMENT_LOOKUP_AT_FIND` (true, gamma-wr-070): whether signals asks one lookup for each lead a research source finds ("The lookup at find"); `true` or `false`, anything else stops the load with `config_invalid`. Off, none is asked and a printed address stays the person's key only; nothing is deleted. Read as the module loads: a change needs an api and worker restart. Its tests: `tests/settings.test.ts`, and the api host's `settings-openapi.test.ts` (the OpenAPI document is the same with it on and off).

The other settings are listed in [docs/runbook.md](docs/runbook.md). The tests: `tests/email-days.test.ts` sets 90 and 60 days, and tries 1000 and values that are not whole numbers of 1 or more in processes of their own; the worker's `tests/enrichment-lookup.test.ts` runs the defaults end to end. The api host's `settings-openapi.test.ts` builds the OpenAPI document with them unset, set small and set large: the same.

## The lookup at find (gamma-wr-070)

An email lookup for each lead a research source finds, asked by signals' people step in the run that makes the lead: `requestLookup({ personId, requestKey, trigger: "found", address? })`, one request for each person (key `research-found:<personId>`). It is the lookup of today: the sources and their order, the verifiers, the allowances, the price and the ends that cost nothing. `ENRICHMENT_LOOKUP_AT_FIND` off, signals asks none.

- **The printed address.** `address` is what a company's page printed with the person, at the company's domain (signals' gate). It is held on the request (`enrichment_requests.printed_address`, personal data) only while the lookup runs, and emptied at every end: the settle (also of a request settled before it ran, a cancel while queued or a prepare that failed) and the free ends of the prepare. The other triggers refuse an address (`enrichment_input_invalid`, `address`).
- **Verified first.** A request that holds one plans a step of its own before every source, `printed` (activity `db`, no source of the list, no outside call, no count). It proposes the address, lower case, as a candidate; the find step drops it as any candidate (`address_invalid`, `other_domain`: only the company's own domain is taken, `seen`, `personal_needs_consent` never applies to a work address) and a kept one goes to a verifier as any. A `valid` ends the walk before any source is asked, and the address is kept as the person's work address, class `page_printed` (the Email panel says "the company's page, printed with the person"), provider `page`, and charged as any address Whytide found. Any other verdict keeps nothing and the walk goes on to the sources. One on the never-contact list ends the lookup `skipped_suppressed`, one another person holds `not_found` (`held_by_other_person`), as for any candidate.
- **Free ends.** A person with a usable address, a cached address, no name, no company domain or no verifier left ends as before, the printed address unused and emptied. With the credits short only the lead's own sources are asked and the printed step is not planned.
- **The workflow is unchanged:** the plan's first entry is a name like any, so the histories replay; the new one, `enrichment_lookup_found.json`, is a `found` lookup with a printed address.
- **Tests:** `tests/safety/printed-address.test.ts` (`test:safety`: verified first, valid only, the company's domain, the never-contact list, another person's address, emptied at every end including a cancel or a failed prepare before the lookup ran, a cached negative entry not ending a lookup before its printed address, in no `providers_tried`, event or log line, the lookups of today planned as before), `tests/settings.test.ts`, and the worker's `tests/enrichment-lookup.test.ts`.

Decided here (gamma-wr-070):
- **A step of the lookup's own, not a source of `ENRICHMENT_EMAIL_SOURCES`:** the list is the owner's order of outside sources; the printed address is the request's own input, so it is always first and never listed. No definition is registered and no deploy table changes.
- **The class is `page_printed`,** one more `source_class` of a contact point, with its words on the Email panel.
- **A lookup asked again** (`waiting_budget`, `waiting_allowance`, `failed`) holds the address of the new ask only: the earlier end emptied it.
- **A cached negative entry of the name and the domain** does not end a lookup that holds a printed address (the coordinator's answer, 2026-11-19): the address is evidence the cache never saw, so the plan is the printed step alone, the sources are not asked. On `valid` it is kept; any other verdict ends the lookup `not_found`, as the negative entry would have. One with no printed address ends `cached_negative`, free, as before.
- **A malformed address** is left out by signals and the lookup asked without it.

## A person's phone (gamma-wr-100)

A number a public page prints with a found person is kept with them, with the page it came from, and shown on the lead page. Whytide calls and messages no number. It is the people's step of web research that finds one (signals README "Web research"); this module keeps it.

- **One table:** a phone is a `contact_points` row of kind `phone` ([docs/data.md](docs/data.md)), so the eraser, the 30-day rule and the lead page cover it with no path of their own. It has no `verification` and no `verified_at` (nullable; a CHECK keeps both required for the two email kinds, so an email row is as strict as before) and holds the page's address in `page_url`. Its class is `web_page`, its provider `research`, never shown.
- **A phone is never an address.** Every reader of an address names the email kinds (`EMAIL_KINDS`, `domain/lookup/constants.ts`): `workEmailOf`, `addressOf`, `usablePoint`, `activePoint` (so the Email panel's held address and a re-verification's contact point), the verify step's target, the settle's re-verification and `emails:record`. A phone is answered by none, whatever its columns or its date say; the safety cases are `tests/safety/phones.test.ts`.
- **`keepPhone`** cleans the number by form only (`domain/phone/form.ts`: its digits, a leading `+` when the page printed one, 7 to 15 digits; a letter, an extension or a second `+` and the number is dropped; no dictionary of countries, no dependency). One number on one person: a number another person of the workspace holds, in any way of printing it (`samePhone`: the same digits, or one without the other's country code or its trunk zero), is `other_person` and not kept again; the same person's number again is `known` and fills a missing page. A person on the never-contact list, whatever its channel, gets none (`suppressed`); an unknown person is `gone`. A person may hold more than one number. No number is in a log line, a span, an event or an error.
- **The route:** `GET …/enrichment/leads/{personId}/phones` (`enrichment.read`, the same controller): `{ phones: [{ number, page, acquiredAt }] }`, the person's active phones, the oldest first; `page` is the page's address (http or https, no query) or null. Never a provider's name or an address. 404 `enrichment_person_not_found` for a person the workspace does not hold. The route test is the api's `tests/enrichment-phones-route.test.ts`, its request `api-calls/gamma-wr-100-phones.http`.
- **The panel** (`ui/email-panel/`) reads the route beside the address and, under it, lists each number as text with "Printed on {host}", a link to the page that opens in a tab of its own with `rel="noopener noreferrer"` (a page that is not http or https is not linked); a number whose page was not kept reads "The page was not kept". The panel's buttons and words for an address are unchanged: a lead with only a phone has no email and still offers "Find email". The spec is `core/apps/web/tests/enrichment-email-panel.spec.ts`.

Decided here (gamma-wr-100):
- **A second route, not a field of the email route,** so that the email route's answer and its tests stay as they were.
- **Several numbers on one person are allowed;** the people's step keeps one a person (the page's), and a later source may add another.
- **`EMAIL_KINDS` is the one list of the address kinds;** `CONTACT_KINDS` stays as its alias for the files and the schema that used it.
- **The page may be `http`** as well as `https`: the lead's own page link is a link, nothing more, and `rel="noopener noreferrer"` goes with it either way. Its query and fragment are cut, as the people's evidence cuts them.
- **A number held by another person is compared by its last digits in SQL** (`value LIKE '%<last 7 digits>'`, then `samePhone` in code), a scan of the workspace's contact points that the unique key does not need to serve.

## The work address of a name (gamma-wr-080)

A picked person no page keyed and no search gave a profile is only a name in signals' people step. `workAddressOfName` looks for their work address from the names and the company's domain, inside the caller's step (`domain/lookup/name.ts`), and has no request, no workflow and no raw file: until an address is `valid` the name lives in the function's memory, in no table, event, `providers_tried`, log line or credit key.

1. **Gates, free:** no name or no domain, a domain recorded catch-all (no guess, nothing asked), no email source with `forName`, no verifier with a call left (`verifierOpen`). Then the credit is reserved (`enr:name:<key>:<attempt>`: the caller's key, the found company's id and the person's place in the pick, never a name, and a part of each call, because credits answers the old row for a key, even a released one; the credit's subject is the id); the credits short end it with nothing asked.
2. **The sources** that need no person, in the configured order: those with `forName` (the pattern's guesses and the finders, never `reply`, `linkedin-contact-info` or the website, which the run has read). Each is counted and asked as in a lookup, with the person's id empty; a failure is logged by its code and the next is asked. Candidates are dropped as a lookup drops them (`dropOf`: form, the company's domain, seen, a finder's own `invalid`); the lookup's bound `ENRICHMENT_EMAIL_MAX_CANDIDATES` holds across the sources.
3. **The verifiers** in their turns, the address only. `valid` ends the walk; `catch_all` records the domain (30 days, no name or address in the row) and ends it with nothing; any other verdict goes on to the next candidate.
4. **On `valid`, in one tenant run:** an address another person holds ends it (`findPersonByEmail`); then `make(address)` makes the person; then the contact point is kept for them (`keepAddress`, class and provider of the source that proposed it), the email cache entry written, the pattern counted as a lookup counts it, and the credit committed. An address the never-contact list holds, one another person holds, or a `make` that answers null throws inside the run, so that it rolls back: no person, lead, hash, contact point or event is left.
5. **Any other end** releases the credit and leaves nothing: no person, lead, contact point, request or cache entry. A failure of the caller's function or of the credits service is raised, its credit released, for the step's attempts.

Decided here (gamma-wr-080):
- **A source says it needs no person** (`forName`, `EmailSourceDefinition`), so a later source is never asked for a name until its task says so; the pattern and the finders carry it.
- **No request row and no event.** The lookup's request is keyed to a person; none exists. The Email panel reads the contact point, so it shows the address with its class. `enrichment.address_verified` is not published (it names a request); signals publishes `signals.person_found` for the lead.
- **The domain's catch-all row is the one thing a failed lookup may leave** (a global row of the domain, as a lookup leaves it): it holds no name or address and spares the next lookup there.
- **Rolled back, not checked first:** the never-contact list and another person's contact point are read inside the run that makes the person, as `keepAddress` reads them for any person, so one rule serves every lookup. The cost of the rare refusal is a person made and unmade inside one transaction.
- **No cache read:** people are taken once per company, so a name is not asked twice; a negative cache for a name stays out (the task's Out).
- **Free ends first:** the catch-all, verifier and credits checks run before any outside call; the credit is reserved after the first two, so a lookup that cannot ask costs a read only.
- **Tests:** `tests/safety/work-address-of-name.test.ts` (`test:safety`), signals' `tests/research-people-name.test.ts` and the worker's `tests/signals-research-run.test.ts`.
