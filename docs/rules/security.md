# Security and data rules

| | |
|---|---|
| **Purpose** | The lines no task crosses, and how personal data, secrets, tenants and AI are handled in every task. Condensed from the architecture ([§6](../architecture.md#6-tenancy-and-isolation), [§15](../architecture.md#15-security)) and, in the private planning repository, docs/17, the alpha roadmap's "Rules we keep even here" and briefs 20, 24 and 25, which hold the full wording. |
| **Read with** | [coding](coding.md) · [delivery](delivery.md) |

## 1. Red lines

Never, in any version, whatever a task says:

- Only the user's own LinkedIn account, connected through the provider's hosted authentication, read within the daily cap and inside working hours. No cookies, no passwords, no second-factor secrets, no shared, rented or fake accounts, no scraping of anything.
- Business profile fields only. Never a profile's "Contact info" section, never special-category data (health, religion, politics, sexual orientation, ethnicity, union membership), never private messages, never a detail a person has hidden with visibility settings.
  - **Exception (the owner's decision of 2026-11-13, for now):** the email addresses a lead shows their 1st-degree connections in "Contact info", allowed behind `LINKEDIN_CONTACT_INFO_ENABLED`, off by default (gamma-en-087). Only the email, only for a lead the workspace's own account is connected to, only during an email lookup, and only used once a verifier calls it valid; never the section's phone numbers, addresses, birthday, messengers or websites. Switching it off stops new reads; addresses found earlier stay in use, and nothing is deleted. It will be turned off later. The LinkedIn port's README, "What the port will never have", holds the rule's text, and its never-list safety case allows this one method only.
- The AI sees anonymized, delimited input and returns structured output. It never sees a name, a photo or pronouns during qualification. When it fails, the lead waits for a human.
- Every claim in a draft traces to data we hold.
- AI vendors on no-training, minimal-retention terms.
- Nothing is sent to anyone in alpha. The tester copies a message and sends it by hand.
- Every tenant row carries `workspace_id`, and a person exists once per workspace. No cross-workspace person data, ever.
- A person's data is deleted on request within a day.

## 2. Personal data

- Store a value only if a task needs it and it is a business profile field. Record its provenance (source class, provider, fetched time) and its PII class (none, business contact, personal), which drives log masking and exports.
- A rejected candidate is never stored as a person: only a salted hash of the provider ID and aggregate drop reasons, kept 90 days.
- Evidence text (a post excerpt, a comment) is kept for the signal's lookback window, then reduced to a one-line summary and the URL. No retention clock resets on a refresh or a re-import.
- Exports contain the workspace's own data only. A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is neutralized in every CSV we write.
- Deletion removes the person's rows across every module (persons, leads, events, evidence, messages, decision records) and leaves only the salted hash, so the person is not re-added. In alpha an engineer runs the script.

## 3. Tenants

- Every read, write and background job runs for one workspace. The tenant context is set per transaction (`SET LOCAL`), from the workspace in the URL or the workflow's input, never from a cache.
- No query without `workspace_id`, even though the policies that would catch it arrive in zeta. Write every query as if row-level security were on.
- Two-workspace isolation tests cover every tenant table a task adds: the same request in workspace B never sees workspace A's rows.
- Two database roles from the first migration: `app` for the api and the worker, which cannot write plans, subscriptions or grants; `billing_writer` for the seeder. A role test in the full pipeline proves it.

## 4. Secrets and keys

- Never a credential, a real customer record or production data in code, tests, fixtures, docs or commit messages. `.env.local` is never committed; secret scanning blocks a commit that carries a secret.
- Provider keys and the LinkedIn account reference are encrypted at rest with envelope encryption under the app master key, with a per-tenant context, and decrypted only in the worker that needs them.
- API keys we issue are shown once and stored hashed. Password hashes and second factors belong to the auth library.
- Secrets never appear in logs, spans, exports, error reports or the OpenAPI document. A pipeline check flags a schema field or a log line that looks like a password, a cookie or a second-factor secret.

## 5. Requests, uploads and egress

- Every server-side fetch (the website fetch, in alpha) goes through the one HTTP client in `platform`, which resolves the address itself, blocks private, link-local and metadata ranges, and re-checks after every redirect. No `fetch` outside it, except inside a vendor adapter.
- A page rendered in the headless browser stays behind three fences: the browser service sits on an internal network with the worker only, away from the data services and with no route out; the adapter's route filter fetches every request the browser routes in the worker through that client; and what Chromium would send by itself goes to a proxy where nothing answers, with WebRTC and WebTransport taken from the page (core/packages/providers/browser/playwright/README.md).
- Uploads have a size and a type limit and are parsed in a sandboxed way: streaming, no formula evaluation, no macros.
- The API has rate limits per workspace, CSRF and origin checks, strict security headers, and idempotency keys on writes that spend credits or call providers. TLS ends at the Caddy edge in production.
- Model output never causes a side effect directly. Code chooses actions from enumerated outputs, and those pass the permission and credit checks like any other call.

## 6. AI

- **Anonymize** before the model sees anything in qualification: no name, photo URL, pronoun, gender or age field, no protected characteristic. A test asserts it on the fake LLM adapter's recorded calls.
- **Delimit** untrusted content (profiles, posts, comments, fetched pages, CSV cells, the user's criteria text) in labeled data blocks. The system prompt says it is data, never instructions. Criteria text cannot change the schema, the rules or the gates.
- **Structured output** against a versioned Zod schema. Verdicts are only `met`, `partially_met`, `not_met` or `unknown`; disqualifiers come from the closed list; evidence quotes or paraphrases the input, or the criterion becomes `unknown`.
- **Fail safe:** a validation failure is retried once with the error appended; on the second failure the item is `ai_failed`, shown with a reason, never admitted, never drafted. A provider failure queues; it never falls back to unreviewed output.
- **Scores in code.** The model gives verdicts; deterministic, versioned, unit-tested rules compute the score and the tier.
- **Grounded drafts:** every name, number, company, tool, event or date in a draft matches a dossier fact or a Company Knowledge proof point, checked in code. A failing draft is regenerated at most twice, then flagged for the human with the reasons. Never a false familiarity, a fake thread or false urgency.
- **A decision record** per call: task, model ID, prompt version, input hash, output, gates, latency, cost, time. Lead decisions stay with the lead; raw prompts and outputs are kept 30 days.
- **No tools** for scoring and classification calls. Memory off. Inputs minimized per task; no task infers special-category data.
- Prompts are versioned files in the module's `agents/` folder; a changed prompt runs its evals, locally (`pnpm -F ai eval`) and in the full pipeline.

## 7. Supply chain, in alpha

A frozen lockfile; pnpm's minimum release age for new versions; no install scripts from dependencies; pipeline images and includes pinned by digest; secret scanning (gitleaks) as a pre-commit hook in every worktree and in the full pipeline; dependency and license checks in the full pipeline, and every new dependency in its own pull request with a reason; images built in stages, running as a non-root user; a `SECURITY.md` with the private reporting channel. CodeQL, Semgrep, the SBOM and signed images come in zeta (docs/17 §10).

## 8. Conduct

- Never weaken a check to make it pass: not a lint rule, not a test, not a role grant, not a scanner's configuration. A pull request that does so is a defect, whoever or whatever wrote it.
- A new dependency, a new network call, a new permission, a new table with personal data or a new way for data to leave the system is called out in the pull-request description.
- Read the module's `docs/security.md` before touching it; update it when the threat model changes.
- Report a vulnerability privately, as `SECURITY.md` says, never in an issue or a pull request.
- Changes to `modules/identity`, `modules/tenancy`, `modules/credits`, `modules/privacy`, `packages/platform`, the auth adapter, `packages/db`, the egress client, `deploy/` and the pipeline definition need two reviews.
