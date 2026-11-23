# enrichment: runbook

Settings: `ENRICHMENT_COMPANY_SOURCES` (default `company-data`), `ENRICHMENT_PERSON_SOURCES` (default none), `ENRICHMENT_TICK_MINUTES` (5), `ENRICHMENT_BATCH_SIZE` (20), `ENRICHMENT_COMPANY_RETRY_DAYS` (30), `ENRICHMENT_FACT_DAYS` (180; 0, a fact is never asked again), and the ports' `PROVIDER_COMPANY_DATA`. A list's names are separated by commas, spaces around them ignored. A change takes effect at the worker's next start. A run's sources are `sourcesTried(runId)`, or `sources_tried` on its row.

## A name left out at start

The worker's log at start: `enrichment: names left out of the list; the worker runs the others`, with the list (`variable`) and each name, its reason and the variable it lacks. `config_invalid`: set the adapter's key in the environment, or take the name out of the list. `provider_unknown`: a misspelt adapter. `source_unknown`: a name no source of the list's kind defines. Restart the worker after the fix; deploy:check refuses these names before a deploy.

## A source failing every time

`sources_tried` shows `failed` with the same code run after run, and the log a warning per run, `enrichment: a source failed; the next one is asked`, with the source and the code. `*_unauthorized`: the key was refused or has expired; renew it. `*_rate_limited`: lower the batch size or raise the tick's minutes. `activity_timeout`: the vendor answered past 15 seconds (45 for `web-search`); its late answer writes nothing. `enrichment_source_invalid`: the source answered off its rules (an outcome or a provider off their form), a bug in that source. The runs still end `done` and ask the next source.

## An allowance spent early

`allowance_spent` in `sources_tried`, and the period's row in `source_usage` at its allowance or `spent`. The counter is the instance's, shared by every workspace, and a failed call counts. It opens again with the next UTC day or month; nothing to reset.

## A run left running

A run stays `running` when its workflow stopped (Temporal's namespace reset, a terminated run). After 60 minutes it no longer holds its company, and the next run asks for it. Its lead's hold ends by contacts' own limit. The row stays as it is; a request for the lead makes a new run.

## Holds and old leads

A lead is enriched only while held: setting `CONTACTS_ENRICHMENT_HOLD_MINUTES` to 0 holds no new lead, but the holds already stored stay until their batch or their limit. Leads made before this module were never held and get no `new_lead` run; "Enrich now" (gamma-en-055) asks for one.

## A person erased during a run

Privacy's eraser deletes the person's runs; the run under way finds no row, writes nothing more and ends without a failure.

## web-search finds nothing

`sources_tried` shows the source `web-search` with `not_found`, `ambiguous` or `not_a_company`. These are its rules, not failures: it keeps a result only when its title or host matches the company's name, and writes nothing for two different matches. `no_adapter`: `PROVIDER_WEB_SEARCH` loads no adapter; set it, with the adapter's key, or take `web-search` out of `ENRICHMENT_COMPANY_SOURCES`. A failing adapter warns `enrichment: a web search failed; the next is asked` with `web-search/<adapter>` and the code; its searches are counted in `source_usage` under `web-search/<adapter>`.

## The website source

`ENRICHMENT_SITE_MAX_PAGES` (5, 1 to 10) bounds the pages read a company, about 20,000 input tokens a company at 5; fewer pages cost less. `AI_MODEL_ENRICHMENT_READ_COMPANY_SITE` picks the model (empty: the adapter's default). In `sources_tried`: `blocked`, the site's robots.txt allows no reading; `fetch_failed` or `egress_*`, the site could not be read; `failed` with `enrichment_site_ai_failed`, the model's answer failed the gates twice (its decision record has the issues); `enrichment_site_agent_not_loaded`, the worker did not register the agent task at start: restart it from a fresh build. Pages that need JavaScript are rendered only while `PROVIDER_BROWSER` names an adapter and the browser service runs.

## Email lookups

Settings: `ENRICHMENT_EMAIL_SOURCES` (default `email-finder`), `ENRICHMENT_CREDITS_PER_EMAIL` (1), `ENRICHMENT_EMAIL_MAX_CANDIDATES` (3), `ENRICHMENT_PERSONAL_EMAIL_EU_UK` (false), `ENRICHMENT_EMAIL_VALID_DAYS` (120), `ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS` (30; README "Settings"), and the ports' `PROVIDER_EMAIL_FINDER` and `PROVIDER_EMAIL_VERIFIER`. A request's steps are its `providers_tried`.
- **`waiting_allowance` (`no_verifier_left`):** every verifier's free checks are spent for the period, or none is listed. Add a verifier with its key to `PROVIDER_EMAIL_VERIFIER`, or wait for the period; the same request key asked again runs as its next attempt.
- **`failed` (`provider_error`):** every finder, or every verifier, failed; `error_code` names the last code (`*_unauthorized`: renew the key). Nothing was charged and no negative entry kept.
- **`waiting_budget`:** the workspace's credits ran short; ask again once they are granted.
- **`not_found` with `personal_needs_consent`:** the lead's only address was a personal one and their country needs consent; the owner's switch decides.
- A bounce, once the email tasks report one, calls `markBounced`; the next lookup for that person ends `cached_negative` for `ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS` (30 unset).
- **`skipped_suppressed` (`suppressed`) after a verdict** (gamma-rf-040): the verified address is on the never-contact list, on every channel or on email; nothing is kept or charged. Lift the block on the never-contact screen if it was a mistake (an opt-out is never lifted), then ask again.

### Recording the kept addresses (`emails:record`, gamma-rf-040)

Run once, right after the migration `20261114165214_contacts_suppression_email`, before members use the never-contact form: until then a block on an address finds no person whose address was kept before the deploy. In development, `pnpm -F enrichment emails:record [--workspace <id>]`; on a deployment, deploy/README.md's line. It records every contact point's address for its person in contacts, every status, `RECORD_BATCH` (500) ids per read, one run per contact point, and changes no contact point. It prints `blocked: <id>` for a contact point whose address a block holds (the person's lead is then `suppressed`, as a block does), `other_person: <id>` for one whose address another person holds or an erased person left, `refused: <id> (<code>)` for a value that is no address, then `emails_recorded: N recorded, B of them blocked, O held by another person, R refused, G gone, of T read in W workspaces`. Safe to run again: an address recorded already answers its person again. Exit 0 when done, 1 when the run is refused (its code printed), 2 for a usage error.
