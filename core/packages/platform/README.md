# @whytide/platform

What every module and host uses, from one place: prefixed ids, typed configuration, machine-readable errors, JSON logs that carry no personal data, OpenTelemetry that exports only to the collector you name, and the shared test factories. The principal and permissions, the credits client, events, the egress client and the i18n runtime arrive with their own tasks ([coding §1](../../../docs/rules/coding.md#1-where-code-goes)). Every change is its own merge request with two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

Node runs the sources directly; `tsc -b` writes `dist/`, which the package exports as `@whytide/platform` and, for a host's preload module, `@whytide/platform/telemetry`. Relative imports inside the package end in `.ts`.

| Command | Does |
|---|---|
| `pnpm -F platform test` | the tests under `tests/`: `core.test.ts` end to end, the unit tests next to it |
| `pnpm -F platform lint`, `typecheck`, `build` | the structural lint; `tsc -b` |
| `pnpm env:check` | `deploy/.env.example` against every `defineConfig` block ([Config](#config)) |

## Ids

`<prefix>_<ULID>`: 48 bits of milliseconds and 80 random bits in Crockford base32, so ids sort by creation time, parse back to their instant and reveal no counts. Inside one millisecond the random part is incremented: one process never repeats or reorders an id. A module declares its prefixes in its `ids.ts` and exports it from its `index.ts`:

```ts
export const ids = defineIds({ per: "person", lead: "lead" }); // ids.person === "per"
```

`newId(ids.person)` gives `per_01JAB3K5ZQ7W9R2M4T6V8X0Y1C`; `parseId(value, "per")` returns `{ prefix, ulid, time }` or throws `invalid_id` (HTTP 400) on another prefix or a malformed ULID. A prefix is two to eight lowercase letters or digits, declared once; `invalid_prefix`, `duplicate_prefix` and `unknown_prefix` (an undeclared prefix at `newId`) fail at start, where the typo is. The platform's own prefixes are `obx_` (outbox entry), `cost_` (cost event), `idem_` (idempotency record) and `dec_` (decision record); `registeredPrefixes()` lists every one. External ids never become ours ([coding §5](../../../docs/rules/coding.md#5-data)).

## Config

A block of variables is declared once, with Zod, and read from `process.env` at start:

```ts
export const config = defineConfig("modules/signals", {
  SIGNALS_LOOKBACK_DAYS: z.coerce.number().int().positive().default(14),
  SIGNALS_PROVIDER_KEY: secret(z.string().min(1)),
});
```

The first argument names the block of `deploy/.env.example` (`# ---- modules/signals ----`). An empty value counts as unset, so defaults apply and `OTEL_EXPORTER_OTLP_ENDPOINT=` means none. A missing or invalid variable throws `config_invalid` with the block and the variables' names in `details`, never a value, and the host dies before it serves anything. The object is frozen; a variable wrapped in `secret()` (the outermost call) is readable but not enumerable, so spreading or logging the object leaks nothing, and its line in `.env.example` ends in `# secret`, which `env:create` writes empty. A test passes its own environment as the third argument.

`pnpm env:check` parses every `defineConfig(block, { … })` under `core/` and `ee/`, outside `tests/`, and compares it with `.env.example`: a declared variable missing from its block, a documented variable nobody declares, a missing block header or a `# secret` marker that disagrees with `secret()` fails, naming the variable. The `deploy` block belongs to Compose and `env:create` (`DEV_*`, the slice) and is not compared, but a variable code declares may not stay there: the finding says to move it to the package's block.

The platform's block is `platformConfig`: `APP_ENV` (`development`, `test`, `production`), `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `DEFAULT_LOCALE` ([Messages](#messages-and-the-i18n-runtime)). `APP_ENV` is required, with no default: unset or empty, the import fails with `config_invalid` naming it, so a server that lost it stops rather than run as `development`. A shared or staging server runs `development` or `production`; `test` is for test processes only, on a laptop or in the pipeline, never a server others reach. The packages' test scripts set `APP_ENV=test` themselves, and the db CLI loads `.env.local` before it imports the platform.

Time: an instant is a `Date`, in UTC; `instant` is the Zod schema that takes a `Date` or an ISO 8601 string with an offset. A local schedule is `{ timeZone, start, end, days }`: an IANA zone, `HH:mm` clock times with `start` before `end`, distinct ISO weekdays 1 (Monday) to 7 (Sunday); `localSchedule` validates it, `LocalSchedule` is its type.

## Errors

`new AppError(code, { status?, details?, cause? })`: the code is the message, in `snake_case`, never a sentence; the UI translates it. A module declares its codes in its `errors.ts`:

```ts
export const errors = defineErrors({ icp_not_found: {}, draft_rejected: { status: 422 } });
throw new AppError(errors.icp_not_found, { details: { icp_id } });
```

A code with a space, a capital letter or anything but `[a-z0-9_]`, or one declared twice, is rejected at registration (`invalid_error_code`, `duplicate_error_code`). `httpStatus(code)`, what the api host answers with, takes the registered status first, then the defaults: `unauthenticated` 401, `insufficient_credits` 402, `forbidden` 403, `not_found` 404, `conflict` 409, `rate_limited` 429; by suffix `invalid_*` and `*_invalid` 400, `*_required` and `*_forbidden` 403, `*_not_found` 404, `*_conflict` and `*_exists` 409; anything else 500. A module whose `*_required` code means a missing input sets `status: 400` itself. `isAppError(value)` recognizes an error from any copy of the package; `registeredErrors()` lists the codes. `details` holds ids and counts only: it ends up in logs and responses.

## Logging: the log rule

`createLogger({ level?, destination?, redact? })` returns a pino logger writing JSON lines. Every line carries `trace_id` and `span_id` while a span is active (read from `@opentelemetry/api`, so without the instrumentation hook too) and `workspace_id` and `actor` while `withLogContext({ workspace_id, actor }, fn)` runs. The level defaults to `LOG_LEVEL`.

The rule ([coding §9](../../../docs/rules/coding.md#9-logs-traces-and-errors)): a line carries ids, counts and durations, never a name, an email, a person's URL, a message body, a token or a key. Two layers hold it:

- The floor: the keys of the PII registry (`pii.ts`, `piiKeys`) are redacted at any depth up to three levels, arrays included, in snake_case and camelCase: `first_name`, `email`, `linkedin_url`, `body`, `token`, `authorization`, `cookie` and the rest become `[redacted]`. A host adds keys with `redact`.
- The proof: `checkLogLines(lines)` reports a key the schema does not allow, at any depth, and a value shaped like an email, a LinkedIn profile URL or a token. The allowed keys are `logSchema` (`schema.ts`): pino's own, `trace_id`, `span_id`, `trace_flags`, `workspace_id`, `actor`, the error fields (`err`, `type`, `message`, `stack`, `cause`, `errors`, `code`, `status`, `details`), a few categorical words (`module`, `event`, `feature`, `task`, `vendor`, `model`, `units`, `provider`, `kind`, `state`, `outcome`, `attempt`, `service`, `version`, `exporting`), and any key ending in `_id`, `_ids`, `_count`, `_ms`, `_bytes`, `_at` or `_version`. `log-schema.json` mirrors it for the pipeline's secret-shapes check; the test keeps them equal. A host's log-schema test runs `checkLogLines` over a sample of its lines, with a wider schema and a `log-schema.json` of its own when it needs more keys.

A `person` object in a line is redacted by the floor and still fails the proof: log `person_id`.

An error is written as its type, its `code` and its `status` (a string or a number), nothing else of it: the platform's serializer replaces pino's, which appends every cause's message and stack and copies every field. Under `err`, an `AppError` adds its `message` (its code), `stack` and `details`; any other error only its stack's frames, and its type and code become the line's `msg` when the call gives none, since its message can quote anything the call was given (Prisma's quotes the arguments, an email address among them). A `cause` is the cause's type and code, three causes deep, and so is each of an `AggregateError`'s `errors`, ten at most. An error elsewhere in a line (`{ failure: error }`, `{ a: { b: { c: { d: error } } } }`) is reduced too, whatever its `toJSON` returns: below the floor's depth a line is walked for errors only, down to eight levels, a deeper object written as `[too deep]` and a cycle as `[circular]`. A getter that throws leaves `{ type }`. An error passed as a format argument (`log.error("failed %o", error)`) reaches `msg` as pino formats it, past all of this: never pass one.

## Telemetry

`startTelemetry({ serviceName })` starts the OpenTelemetry Node SDK with the auto-instrumentations for HTTP, NestJS, pg, redis, ioredis and pino; the other thirty-five the package bundles are disabled by name. OTLP is the only output. While `OTEL_EXPORTER_OTLP_ENDPOINT` is set, traces, metrics and logs go there (`OTEL_EXPORTER_OTLP_PROTOCOL` picks `http/protobuf`, the default, `http/json` or `grpc`), pino's lines through the Logs SDK with the span's ids. While it is unset there is no exporter, no metric reader and no log processor, and the one span processor only keeps the ids flowing into the logs: nothing connects anywhere, which `tests/core.test.ts` proves against a local receiver. The resource carries `service.name` and `deployment.environment.name` (`APP_ENV`) only; `OTEL_SERVICE_NAME` is the host's own, passed here, not a variable of `.env.example`. No usage telemetry exists.

No span carries a URL's query, inbound or outbound: the sampler `startTelemetry` gives the SDK takes `url.query` off every span as it starts and cuts `url.full`, `url.original`, `http.url` and `http.target` before any `?` or `#`, the HTTP client's spans and NestJS's request span (`<Controller>.<handler>`) included, which `tests/core.test.ts` proves against the local receiver. It sees the attributes a span starts with, where those instrumentations set them. It is parent-based and always on, for a caller whose `traceparent` says "not sampled" too, so no caller switches its requests' spans off; `OTEL_TRACES_SAMPLER` is not read. A sampler, because the HTTP instrumentation's own options redact the values of named parameters only, NestJS's have none, and a span processor would replace the exporters the SDK builds from the environment.

The instrumentations patch ESM imports through a loader hook (`import-in-the-middle`, registered in the thread with `module.registerHooks`, resolved from the SDK's own dependency tree because pnpm installs only direct dependencies next to a package), so a host starts telemetry from a module it preloads, before the instrumented modules load, importing the `telemetry` entry rather than the package root so pino and the rest come after the hook:

```ts
// core/apps/api/telemetry.ts, started as: node --import ./dist/telemetry.js dist/main.js
import { startTelemetry } from "@whytide/platform/telemetry";
startTelemetry({ serviceName: "api" });
```

`shutdown()` on the returned object flushes and stops the SDK; `exporting` says whether an endpoint was set. `withSpan(name, attrs, fn)` runs `fn` in a span whose attributes keep only the keys the log schema allows (`allowedAttributes`); on a throw the span's status carries the error code, never the message.

## Testing

`synthetic(seed)` is a generator seeded per test: `firstName()`, `lastName()`, `company()`, `email()`, `url()`, `linkedinUrl()`, `person()`, plus `int()` and `pick()`. The same seed gives the same sequence, addresses end in `example.com` or `.invalid`, and no name is a real person's. `collectLogs()` is the buffer destination for `createLogger`, with the parsed `lines()`; `throwsCode(fn, code)` asserts the `AppError` a call throws.

## Messages and the i18n runtime

Every string a person sees is a key in a message file, in ICU MessageFormat, English only in alpha ([architecture §17](../../../docs/architecture.md#17-languages), [coding §4](../../../docs/rules/coding.md#4-inside-a-module)). `i18n/` holds the runtime and the check; `messages/en.json` holds the runtime's own strings (`platform.error.generic`).

- **Where a string lives:** the module's `messages/en.json`, `core/packages/ui/messages/en.json` for the shared words (Save, Cancel), `core/apps/web/messages/en.json` for the web host's shell, this package's for the runtime's own. One flat object, keys sorted in code-unit order, humans edit `en.json` only. Another language sits next to it as `<locale>.json`, a complete file written by the translation bot: the build takes a module's file for the nearest tag (`zh-Hant-TW`, then `zh-Hant`, then `zh`) and the default locale's when there is none.
- **The key:** `module.screen.purpose`, where `module` is the folder name (`platform`, `ui` and `web` for the two packages and the web host): `contacts.list.empty`, `contacts.errors.icp_not_found`. One more segment names the part of a mail: `identity.signin.link.subject` and `.body`. Segments are lower-case letters, digits and underscores, and a key is never also a namespace (`a.b.c` next to `a.b.c.d` fails).
- **Adding a key:** write it in the module's `en.json` in sorted position; use it in the screen as `t('contacts.list.empty')`, or `useTranslations('contacts.list')` and `t('empty')`; run `pnpm -F platform messages:check`. Keys are string literals, so the check can read them; a key built at run time fails the check.
- **Error codes:** every code a module registers in its `errors.ts` (`defineErrors({ … })`) has the key `<module>.errors.<code>`; the API keeps the code, the UI shows the text through `translateError(t, module, code)`, which falls back to `platform.error.generic`. The platform's own codes are developer-facing and have no keys.
- **The bundle:** `loadMessages(locale)` returns every message file merged into one nested object, `{ contacts: { list: { empty: "…" } } }`, the shape next-intl consumes, and fails on a key defined in two files, naming both, or on a key off the convention; `{ extraRoots }` adds message folders that are no module's (the web host's test modules). It writes nothing; `buildMessages(locale, outFile)` writes the bundle where the web host's build asks, under a `*.generated.*` name, which git ignores.
- **The check:** `pnpm -F platform messages:check`, the pipeline step `messages:check`: every key used in `ui/` (and in the web host but its tests) (`t('…')`, `useTranslations('ns')` or `getTranslations({ namespace: 'ns' })` plus `t('rest')`, the key-shaped literals of `nav.ts`) and by `renderMail('…')`, in the providers package too, exists; every key is used somewhere; every value parses as ICU, a stray brace included; keys follow the convention with the folder's name first; the file is sorted; every registered error code has its key. It prints `path:line:column kind message`, as the lint does, then what it read. What it does not follow: a `t` passed as a prop or aliased (`const l = t`, `props.t(…)`) is no translator to it, so the keys it takes count as unused; any key-shaped literal in a `nav.ts` counts as a use; a key or namespace built at run time and a computed or spread member of `defineErrors` are reported as `dynamic-key`, never guessed.
- **The runtime:** `createTranslator(messages, locale)` gives server code a `t(key, values)`; `renderMail(key, params, locale)` builds `{ subject, body }` from `<key>.subject` and `<key>.body`; `formatDate`, `formatNumber` and `formatRelative` go through `Intl` for the locale ("2 days ago" from the locale's own rules, never a concatenation); `resolveLocale(userSetting, acceptLanguage)` takes the user's setting, then the browser, then `DEFAULT_LOCALE` (`en`), and returns `language[-script][-region]` of the first tag one of whose prefixes has messages, so `en-GB` keeps British dates and no Unicode extension reaches `Intl`. Screens get `t()` from next-intl in the web host, over the same bundle.

## Principal and permissions

Every request and every background job runs for one principal, and one function decides every action from one policy table ([architecture §5](../../../docs/architecture.md#5-a-request-end-to-end)), so no handler decides access on its own. Alpha is the trivial case, one workspace in which every member is Owner, but the shape is the one gamma's roles and Core 1.1's agents fill in, so nothing is retrofitted.

**The principal** (`principal/`): `{ userId, actorType, authMethod, membershipId?, workspaceId?, role?, scopes }`. `actorType` is `human` or `service` and `authMethod` is `session` or `internal`; agents, API keys and OAuth tokens widen the two unions in Core 1.1. The api host's guard builds a human principal from the session and, once identity resolves the membership in the URL's workspace (alpha-p3-030, upcoming), fills `membershipId`, `workspaceId` and `role` (`Owner`, `Admin` or `Member`); a signed-in user without a membership keeps the three empty. `scopes` is carried for the API keys and agents of Core 1.1 and not evaluated in alpha. `servicePrincipal(name)` is the worker's and the seeder's: `{ userId: "service:<name>", actorType: "service", authMethod: "internal", scopes: [] }`, frozen, built in process and never from a request; the name is lowercase letters, digits and underscores (`invalid_service_name` otherwise, with the name under `details.service`). The tenant transaction, `withTenant` of `core/packages/db` ("The tenant context" below), takes `{ workspaceId, principal }` and writes `principal.userId` to `app.user_id`.

**The policy table** (`permissions/`) is a registry, never a central list ([coding §3](../../../docs/rules/coding.md#3-registries-not-switchboards)): a module declares its actions in its `permissions.ts`, exported from its `index.ts`, and the host collects them by importing every module at start, as it does for error codes and id prefixes.

```ts
export const permissions = definePermissions(
  [
    { action: "leads.read", roles: ["Owner", "Admin", "Member"] },
    { action: "leads.write", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
); // permissions["leads.read"] === "leads.read"
```

An action is `<module>.<verb>`: lowercase letters, digits and underscores in two or more segments joined by dots (`company_knowledge.read`, `identity.invite`); anything else is `invalid_permission_action`, at start. The shape is checked at run time too, as `defineIds` and `defineErrors` check theirs: `roles` is an array whose every entry is one of the three roles, the empty list allowed (an action only a service performs), and the second argument, the file registering the actions, its `import.meta.url`, is a non-empty string; otherwise `invalid_permission_definition`, with `details.field` naming `roles` or `source`. An action two modules declare fails at start with `duplicate_permission_action` and both files in `details.sources`, whichever module loads second, and the first registration stands. `registeredPermissions()` is the table, action to a frozen `{ roles, source }`.

**`can(principal, action, resource?)`** returns `allow` or the code the host answers with; it never throws for a principal (a missing one is a host bug and surfaces as a `TypeError`) and never logs; the api host's permission decorator (alpha-p2-010, upcoming) will turn a code into an `AppError`. A host passes the URL's workspace as `resource`, so the check is the membership in that workspace, not merely some membership. In this order: an action no module registered is `unknown_action` (500: a bug in the caller, not a policy decision), whoever asks; a principal with a `workspaceId` asking about a resource of another workspace is `forbidden` (403), service or human; a service principal, `actorType: "service"` and `authMethod: "internal"` both, may then do any registered action, because it is internal code and the workflow input that scoped its work was written by a request that passed this function; a human lacking any of `membershipId`, `workspaceId` and `role` is `forbidden`; otherwise `allow`. Roles are declared and kept but not evaluated: every member is Owner in alpha, and the role check is gamma's; scopes, the deny list and the owner ceiling of agents are Core 1.1's. `permissionErrors` holds the five codes.

## Egress: what is refused

Every server-side fetch goes through the one client in `http/` ([security §5](../../../docs/rules/security.md#5-requests-uploads-and-egress)); the lint rule `no-raw-fetch` keeps `fetch`, Node's network modules and the HTTP client packages out of everywhere else but the adapters and test code ([tools/lint/README.md](../../../tools/lint/README.md)). This section is the rules: one module with no network, so they are tested exhaustively and run again on every redirect hop. The client itself, `fetchSafe`, which resolves the name, pins the address and bounds size and time: [Egress: fetchSafe](#egress-fetchsafe).

`isBlockedAddress(ip)` is true for an address in the ranges below, in any notation: Node's `BlockList` compares bits, so `::ffff:10.0.0.1`, `::ffff:a00:1` and `0:0:0:0:0:ffff:10.0.0.1` are one blocked address, and an IPv6 zone (`fe80::1%eth0`) or brackets hide nothing. Anything that is not an IP address counts as blocked: a caller that passes a name, or `0x7f.0.0.1`, fails closed. The client asks it for every address a host resolves to.

| Range | What it is |
|---|---|
| `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` | private and unique-local |
| `127/8`, `::1` | loopback |
| `169.254/16`, `fe80::/10` | link-local; the cloud metadata service, `169.254.169.254`, lives there |
| `0/8`, `::/96` | this network and the unspecified address: a connect to `0.0.0.0` or `::` reaches loopback; `::/96` also holds the deprecated IPv4-compatible `::a.b.c.d` |
| `100.64/10` | carrier-grade NAT |
| `192.0.0/24` | IETF protocol assignments (RFC 6890), Oracle Cloud Classic's metadata service `192.0.0.192` among them; blocked whole, so the global anycast `192.0.0.9` and `192.0.0.10` are refused too: it fails closed |
| `168.63.129.16` | Azure's wireserver, reachable from every Azure VM |
| `198.18/15`, `2001:2::/48` | benchmarking (RFC 2544, RFC 5180) |
| `240/4` | reserved (RFC 1112), with the limited broadcast address `255.255.255.255` |
| `fec0::/10` | site-local, deprecated |
| `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `2001::/32` | IPv6 that embeds an IPv4 address, NAT64, 6to4 and Teredo, through which `64:ff9b::127.0.0.1` or `2002:7f00:1::` would reach a blocked IPv4 address |
| `::ffff:0:0:0/96` | IPv4-translated (RFC 2765), `::ffff:0:a.b.c.d`, which a translator turns into the IPv4 address |

Multicast (`224/4`, `ff00::/8`) stays unblocked: TCP cannot connect to it. A proxy in fake-IP mode (Clash, Surge, sing-box) answers every name with an address from `198.18/15`, so on a machine that runs one every fetch is `egress_blocked_address`.

`checkUrl(url, { allowHosts?, denyHosts? })` returns the parsed `URL` or throws an `AppError` with the rule's code, each HTTP 400, in this order:

| Code | Refuses |
|---|---|
| `egress_invalid_url` | what the URL parser rejects (a relative path, a space, a port over 65535, a zone in a literal) and a host name with an empty label (`localhost..`, `.example.com`), which the parser keeps and no list would match |
| `egress_bad_scheme` | anything but `http:` and `https:` |
| `egress_credentials_in_url` | a user name or a password in the URL |
| `egress_denied_host` | a host on the deny-list |
| `egress_blocked_address` | `localhost` and every name under it, or a literal address `isBlockedAddress` refuses in every form the parser canonicalizes first: `0x7f.0.0.1`, `2130706433`, `127.1`, `127.0.0.%31`, `127。0。0。1`, `[::ffff:7f00:1]`, `[::0]` |
| `egress_port_not_allowed` | an explicit port other than the scheme's own: `:8443`, and `http://…:443` |

An allow-list entry opens exactly what `checkUrl` would refuse for that host and nothing else: a port other than the scheme's own, and, when the host itself is loopback by name or a blocked literal (`localhost`, `127.0.0.1:3000`, `[::1]:3000`), that address: this is how a test reaches a local server. It never passes the first three rules, and it never vouches for what a name resolves to. The client (alpha-p1-065) therefore still checks every address an allow-listed name such as `example.com:8443` resolves to, and skips that check only while `allowsBlockedAddress(url, lists?)` is true: the host is allow-listed and is itself loopback by name or a literal `isBlockedAddress` refuses. So a test server on the Compose network is allow-listed by its literal address, never by its service name: `allowsBlockedAddress` is false for `postgres:5432`, whose resolved address the client would still refuse. `isAllowListed(url, lists?)` says whether the host, with its port, is on the allow-list at all; both read `EGRESS_ALLOW_HOSTS` when no lists are given. A host on both lists is denied. A name that only *resolves* to a blocked address (`127.0.0.1.nip.io`) passes `checkUrl`; catching it is the client's resolution step.

The lists are `EGRESS_ALLOW_HOSTS` and `EGRESS_DENY_HOSTS` (`egressConfig`, declared in `http/config.ts`): comma-separated `host` or `host:port` entries, an IPv6 literal bare or in brackets (`localhost:3000, [::1]:3000, example.com`). An entry names one exact host, never its subdomains and never a wildcard (`*` is refused); one with a port matches that port only, one without matches the host on any port; hosts compare as the URL parser writes them (lowercase, punycode, canonical IPv4, no trailing dot). Both default to empty and the parsed lists are frozen; a malformed entry fails at start as `config_invalid`, naming the variable. `parseHostList(text)` reads the same syntax for code that builds a list itself (`egress_invalid_host_entry` on a malformed entry), and the functions take the lists as a parameter, so the tests need no environment.

## Cost events

Every provider and model call writes a cost event, the single record of what the call cost: workspace, feature, task, vendor, model, units and the price list's version ([coding §9](../../../docs/rules/coding.md#9-logs-traces-and-errors), [architecture §16](../../../docs/architecture.md#16-observability)). The table is `cost_events` (`core/packages/db/prisma/schema/platform.prisma`); the runtime is here and takes the transaction through `CostStore`, an interface this package declares and `core/packages/db` implements (`costStore(tx)`), so the platform never imports the client. The model-call wrapper of `packages/ai` and the adapters' callers write rows through it:

```ts
const event = await recordCost(costStore(tx), {
  workspace_id, feature: "qualification", task: "qualify_lead",
  vendor: "anthropic", model: "claude-…", units: { input_tokens: 1200, output_tokens: 300 },
  credits: 2, subject_ref: person_id,
});
```

A row needs `workspace_id`, `feature`, `vendor` and `units` (one or more unit kinds, each a count of zero or more), or it is `invalid_cost_event` (400) and nothing is written; `task`, `model`, `credits` (what the workspace was charged, when the caller knows it) and `subject_ref` (a person id, for the cost counter per lead) are optional. `recordCost` fills `unit_cost` and `price_list_version` from the price table and returns the row with its `cost_` id. The row is written inside the caller's transaction, so it rolls back with it.

The price table is `COST_PRICES_JSON` (`costConfig`): one JSON object with the list's `version` and `prices` per vendor and model, each a price per unit kind in the list's currency: `{"version":"2026-10-21","prices":{"anthropic":{"claude-…":{"input_tokens":0.000003,"output_tokens":0.000015}},"unipile":{"*":{"api_call":0.002}}}}`. The model key `*` holds a vendor's prices that depend on no model and prices a row without `model`. `unit_cost` is the sum over the row's unit kinds of count times price, to 15 significant digits, as a decimal string, so `numeric` keeps it exactly. A vendor, model or unit kind the table does not price is `cost_price_missing`, never a guess; while the variable is empty every call is `cost_prices_not_configured`. The table is parsed at start (`config_invalid` names the fault) and optional, so a host without provider calls needs none. `priceFor(table, { vendor, model, units })` is the pure lookup; `recordCost(tx, row, { prices })` takes another table, for a test or a host that loads prices elsewhere.

## Idempotency

A write that spends credits or calls a provider takes an idempotency key ([security §5](../../../docs/rules/security.md#5-requests-uploads-and-egress)); `withIdempotency` answers such a request once per key and workspace, inside the caller's tenant transaction, through `IdempotencyStore`, declared here and implemented by `core/packages/db` (`idempotencyStore(tx)`). The HTTP header and the decorator that call it are alpha-p2-030's:

```ts
const { status, body, replayed } = await withIdempotency(
  idempotencyStore(tx),
  { workspaceId, key: idempotencyKeyHeader, requestHash: sha256(method, path, body) },
  () => handle(tx), // resolves to { status, body: IdempotencyBody }
);
```

The first request with a key runs `fn`, stores its status and JSON body in `idempotency_records` and returns them; a repeat with the same `requestHash` returns the stored response with `replayed: true` and never runs `fn`; the same key with another hash is `idempotency_key_reused` (422). `fn` returns only what should be replayed and throws otherwise: a returned error status is stored and replayed like any other, while a throw stores nothing, so the next request with the key runs. A record lives `IDEMPOTENCY_TTL_MS`, 24 hours: before it looks, the call sweeps the workspace's records created more than that ago, a range on the `(workspace_id, created_at)` index (`expires_at`, always `created_at` plus the TTL, guards the replay), so a key is forgotten after that without a job; the rows of a workspace that makes no further request stay until its next one. `response_body` is whatever the endpoint answered and may carry person data for that time: the column is marked `/// pii` in the schema and the deletion script ([security §1](../../../docs/rules/security.md#1-red-lines)) covers it. Two requests with one key at the same time: the first to store wins; the other is `idempotency_key_conflict` (409) and its transaction rolls back with everything `fn` did, so its retry gets the stored response. A missing `workspaceId`, `key` or `requestHash`, or either over 255 characters, is `invalid_idempotency_key` (400). The key is never written into an error's `details` or a log line; `workspace_id` is.

## Events and the outbox

A module tells the others what happened by publishing an event in the same transaction as its change; the worker delivers it later ([architecture §4.3](../../../docs/architecture.md#43-how-modules-talk) rule 4, [§7.6](../../../docs/architecture.md#76-physical-rules)). A publisher never calls a subscriber, and nobody reads another module's tables.

**Declaring.** A module declares its events in its `events.ts` and exports them from its `index.ts`:

```ts
export const events = defineEvents({
  "discovery.people_imported": z.object({ import_id: z.string(), person_ids: z.array(z.string()) }),
});
```

A name is `module.event_name`, dotted snake_case, declared once (`invalid_event_name`, `duplicate_event`, whose `details` name the fields of both schemas). The payload schema is a closed Zod object of JSON values, ids and counts: a value JSON cannot carry (`z.date()`, `z.bigint()`, `z.map()`, a custom type) or a `.transform()`, which would run at publish and again at delivery, fails with `invalid_event_schema` (`problem: unrepresentable`); a record, a `.catchall()` or a loose object admits keys nobody declared (`open_fields`); `z.any()` and `z.unknown()` admit anything (`anything`); an instant is `z.iso.datetime()`. A field named in the PII registry (`piiKeys`: `name`, `email`, `linkedin_url`, `body`, `token`, …, in snake_case or camelCase) at any depth fails with `pii_in_event_schema` and the fields in `details`. The check reads the JSON Schema Zod exports for the schema's output, never Zod's internals. `registeredEvents()` lists the names and their schemas.

**Publishing.** `publish(tx, events["discovery.people_imported"], payload)` validates the payload (`invalid_event_payload`, the failing paths in `details`, never a value; `event_payload_too_large` above 256 KB, `EVENT_PAYLOAD_MAX_BYTES`), writes the row inside `tx` and returns the event id (`obx_…`). The payload is typed from the schema. `tx` is the caller's tenant transaction as the platform sees it, an `OutboxWriter`: its `workspaceId` and `insertOutbox(row)`. `@whytide/db` wraps a Prisma transaction client as one: `outboxWriter(tx, workspaceId)` with the `tx` of `withTenant` and `currentTenant().workspaceId`. A transaction that rolls back takes the row with it. The row's `next_attempt_at` is stamped with the publishing host's clock and compared with the worker's at the claim: a skew between the two delays delivery by the skew.

**Subscribing.** Another module's `events.ts` imports the publisher's `events` and calls `subscribe(events["discovery.people_imported"], handler)`; an undeclared event fails at start (`unknown_event`). The handler gets `(payload, context)`: the parsed payload and `{ id, name, workspaceId, createdAt, attempt, tx }`, where `tx` is a tenant transaction for the event's workspace, opened by the host's runner (`EventContext<Tx>`; the type parameter is the host's transaction type). Delivery is at least once: a crash between a handler's commit and the row's mark redelivers the row, so a handler dedupes by `id` when it must not repeat. Every handler of an event runs in its own transaction, in registration order; the first to throw fails the delivery. A handler finishes well inside the claim's timeout, which covers a whole pass (60 seconds by default): it writes a few rows or starts a workflow (`startWorkflow`, "Workflows"), and never does the long work itself.

**Delivering.** `deliverPending({ store, runInTenant, limit?, maxAttempts?, now?, backoff?, log?, budgetMs? })` is what the worker host (alpha-p2-050) calls in a loop, sleeping `OUTBOX_POLL_MS` when a pass claimed nothing; the host imports every module's `events.ts` before the first pass, so every subscriber is in place. One pass: the store opens a transaction and locks up to `limit` (100) due rows with `FOR UPDATE SKIP LOCKED`, oldest first, so a second deliverer takes other rows and never the same one; every subscriber of each row runs inside a span `outbox.deliver`, under the row's workspace in the log context; the row is marked `delivered_at` with its `attempts`; the transaction commits. The pass starts no row once `budgetMs` has elapsed, half the store's claim timeout: the rest of the batch stays pending for the next pass and is reported as `deferred`, with a `warn` line, so the claim never outlives its transaction. A throw marks the row failed instead: `attempts + 1`, `last_error` (the `AppError` code or the error's class name, never a message) and `next_attempt_at` from `backoffMs(attempt)`: one second doubling to a cap of fifteen minutes, with equal jitter (half fixed, half random), so the waits grow with every attempt. A deterministic failure, `unknown_event` (this worker has no such event, a deploy in progress) or `invalid_event_payload`, waits on the same curve from a base sixty times longer, half a minute doubling to the cap, so a worker lagging the api by up to half an hour dead-letters nothing. The attempt that reaches `OUTBOX_MAX_ATTEMPTS` (8) sets `dead_at` instead, logs an `error` line (`event`, `event_id`, `workspace_id`, `attempt`, `err`) and adds one to the counter `outbox.dead_letters` (by `event`), and the row is never claimed again. `replayDeadLetter(store, { workspaceId, id })` clears `dead_at`, resets `attempts` and makes the row due now, or throws `outbox_entry_not_found`; nothing else brings a dead row back. A row whose event has no subscriber is marked delivered with a `debug` line and the counter `outbox.unhandled`. The pass returns `{ claimed, delivered, retried, dead, deferred }`; it rejects when the claim's transaction is lost (Prisma's `P2028` past the timeout) or the database is away, and the host's loop logs that and goes on after `OUTBOX_POLL_MS`. The row lock holds while the handlers run, which is what makes two deliverers deliver each row exactly once.

**The pieces.** The platform never imports `@whytide/db`: `outbox/store.ts` declares what the runtime needs (`OutboxWriter`, `OutboxStore` with `claimTimeoutMs`, `claim` and `replay`, the `OutboxMarks` inside a claim, `RunInTenant<Tx>`), `core/packages/db` implements the store with the Prisma client on the `outbox` table of `prisma/schema/platform.prisma` (`createOutboxStore(prisma)`, [db README](../db/README.md#the-outbox-store)), and the host wires both in with its tenant runner: `runInTenant(workspaceId, fn)` opens a transaction, runs `SET LOCAL app.workspace_id` and hands the client to `fn`, what alpha-p1-045's `withTenant` does. The variables are `outboxConfig`: `OUTBOX_MAX_ATTEMPTS` and `OUTBOX_POLL_MS`. Tests: `tests/events.test.ts`, `tests/backoff.test.ts` and `tests/outbox.test.ts` (the runtime on an in-memory store) here, without a database; `core/packages/db/tests/outbox.test.ts` end to end, one deliverer holding a row while another takes the rest.

## Secrets at rest

A provider account reference or a provider key is stored only as a ciphertext under the app master key, bound to the organization it belongs to, and read back only in the worker ([security §4](../../../docs/rules/security.md#4-secrets-and-keys), [architecture §15](../../../docs/architecture.md#15-security)). `secrets/` is the key-management port of [architecture §9](../../../docs/architecture.md#9-ports-and-adapters) with its first adapter, the master key of `APP_MASTER_KEY`; the port is these two functions, so a cloud key service later replaces the wrapping step (`secrets/keys.ts`: a `KeyWrapper` with `keyVersion` and `wrap`, and the unwrap it registers for the worker entry) and nothing else.

```ts
import { encryptSecret } from "@whytide/platform"; // the api, or anyone: encrypt only
const blob = encryptSecret(accountRef, { organizationId, purpose: "linkedin_account" }); // a Buffer, for a bytea column

import { decryptSecret } from "@whytide/platform/secrets/worker"; // the worker host and a module's workflows/ only
const value = decryptSecret(blob, { organizationId, purpose: "linkedin_account" }).toString("utf8");
```

- **Envelope encryption.** Every value gets its own random 256-bit data key: AES-256-GCM encrypts the value under it, and the master key wraps the data key with AES-256-GCM. Both layers authenticate the context `{ organizationId, purpose }`: the value's associated data is the format version and the context, the wrap's the full header (key version included) and the context, so a blob opens only under the organization and the purpose it was sealed with, and a rotation re-wraps the data key under the new master key while the value, its nonce and its tag stay as they are; another one fails with `secret_context_mismatch` (a tampered wrapped key reads the same way, since the context is what the wrap authenticates), an empty field with `secret_context_invalid`. Two encryptions of one value never give the same blob. The plaintext is a string or bytes; the result is bytes: `.toString("utf8")`, then `.fill(0)` once used.
- **The blob**, 98 bytes plus the ciphertext: `v1`, the `key_version` (8 bytes), the wrapped data key (nonce, key, tag), the value's nonce and tag, then the ciphertext. `parseSecretBlob(blob)` reads the header and refuses anything else with `secret_blob_invalid`; a value that no longer authenticates under its own key and context (a corrupt row) fails with the same code at decryption.
- **The keys.** `APP_MASTER_KEY` is 32 bytes in base64: `pnpm secrets:keygen` prints a new one, for `.env.local` and never for the repository (the pre-commit hook knows its shape). The `key_version` names the key in a blob: eight bytes of an HMAC the key computes over a fixed label, which says which key without saying anything about it. `APP_MASTER_KEY_PREVIOUS`, set during a rotation, only decrypts: a blob sealed under it keeps opening while it is set and fails with `secret_key_unavailable`, naming the blob's `key_version`, once it is unset; new blobs always use the current key. Re-wrapping each row's data key under the new key is zeta's rotation tooling (`tests/secrets.test.ts` shows the step). Both variables are declared `secret()` and optional (`secrets/config.ts`), so importing the package never throws: `loadMasterKeys()` validates them, `secret_key_unavailable` when the first is unset, `secret_master_key_invalid` with the variable's name and the reason in `details` when one is malformed or both are the same key. A host calls it at start, to fail there rather than at its first secret; `encryptSecret` and `decryptSecret` load the same keys once, at the first call. Neither the value nor the parsed key reaches an error, a log line or a spread object: the config object keeps it non-enumerable, and the loaded keys hold it in a closure behind `wrap`. The unwrap is not on the key ring at all: `secrets/worker.ts` reaches it through a map private to `secrets/keys.ts`, so holding the keys gives the api no way to decrypt. A key version is sixteen hex characters; `headerOf` refuses anything else with `secret_master_key_invalid`. A test passes `loadMasterKeys({ APP_MASTER_KEY: newMasterKey() })` as the third argument of both functions.
- **The worker only.** `decryptSecret` is exported from the second package entry, `@whytide/platform/secrets/worker`, never from the root, and the lint rule `decrypt-in-worker-only` allows the import under `core/apps/worker/` and a module's `workflows/` only ([tools/lint](../../../tools/lint/README.md)). The api holds blobs it cannot open.
- **Redaction.** The floor of the [log rule](#logging-the-log-rule) also replaces, at the same depths, any value under a key ending in `_ref`, `_token` or `_secret` (`Ref`, `Token`, `Secret`; `piiKeySuffixes`) and any binary value, a `Buffer` or a typed array, whatever its key, so neither a blob nor a decrypted value reaches a line in clear; `log.info(buffer)` itself becomes `binary: "[redacted]"`. The walk covers a child logger's bindings (the ones `setBindings` adds too), an `AppError`'s `details`, under `err` and nested alike ([the log rule](#logging-the-log-rule) says what else of an error stays), and a class instance's own fields; a value with its own `toJSON` (a `Date`) keeps its shape. The proof's email shape requires a domain that ends in letters with no longer name after them (a sentence's period may follow), so a pnpm path in a stack (`api@1.9.1/node_modules`) is not reported as one. The error details of this module are short codes (`variable`, `reason`, `purpose`, `field` are schema keys): `not_set`, `expected_32_bytes_base64`, `same_as_current`, `invalid_key_version`, `shorter_than_header`, `not_v1`, `value_not_authenticated`.

## The tenant context

Every request and every background job runs for one workspace, set per transaction from the URL or a workflow's input, never from a cache ([security §3](../../../docs/rules/security.md#3-tenants)). `tenant/` is the half that needs no database; the transaction that sets the context and the client that refuses to run without it are `withTenant` of `core/packages/db` ([db README](../db/README.md#the-tenant-transaction-and-the-scoped-client)), since the platform never imports it.

- `TenantContext` is `{ workspaceId, principal }`. `currentTenant()` returns it anywhere under a `withTenant`, across awaits (`AsyncLocalStorage`, so two runs at once each see their own), until the run's function settles: a timer or a promise it leaves behind finds none. Elsewhere it throws `no_tenant_context`.
- `withTenantContext(context, fn)` is the context half that `withTenant` calls; alone it opens no transaction, so the tenant client still refuses to run. It checks no membership: `can()` does, after the request guard (alpha-p3-030) resolves it. An empty workspace or user is `no_tenant_context`; a principal whose `workspaceId` is another workspace is `tenant_mismatch`, without details, since the requested one comes from a URL.
- `withoutTenant(reason, fn, { log? })` runs `fn` outside any workspace, for the global tables only (users, organizations, workspaces), and logs the reason at `info`: there `currentTenant()` throws and the db's clients refuse every tenant table and raw SQL. The reason names a module or a purpose, `tenancy` or `tenancy.sign_in`, never data; anything else is `invalid_tenant_reason`.
- `currentTenantScope()` says which of the two runs on this path, for the db's guard, and `insideTenantRun()` whether a tenant run is still open around it, also through a `withoutTenant`, for the db's `nested_run`. The codes are `tenantErrors`, each HTTP 500, a bug in the calling code: `no_tenant_context`, `tenant_mismatch`, `tenant_query_refused` (the db's guard, with `details.reason`) and `invalid_tenant_reason`. Unit test: `tests/tenant.test.ts`.

## Egress: fetchSafe

`fetchSafe(url, options)` is the one way server code fetches a URL ([security §5](../../../docs/rules/security.md#5-requests-uploads-and-egress)); a vendor adapter reaches its vendor through its SDK instead. It runs the rules of [Egress: what is refused](#egress-what-is-refused) on every hop and resolves to `{ status, headers, body, truncated, finalUrl, hops }`: whatever the status, `body` a `Buffer` as received, `truncated` whether `truncate: true` cut it, `finalUrl` the URL that answered, `hops` the redirects followed. A refusal or a failure rejects with an `AppError` that carries no part of the URL.

```ts
const page = await fetchSafe(url, { maxRedirects: 3, maxBytes: 1_048_576, timeoutMs: 10_000, accept: "text/html" });
```

- **Each hop**: `checkUrl`, then the host's addresses: a literal is its own, a name is resolved once through DNS (c-ares, `dns.promises.Resolver`: A and AAAA, off libuv's thread pool, each asked again once when a quarter to a half of the call passes without an answer; once one family has answered, the other gets 50 ms more, as RFC 8305 has it; all cancelled at the deadline; `localhost` and every name under it answer loopback without asking). `/etc/hosts` is not read: a host blocked there is not blocked here, so deny it with `EGRESS_DENY_HOSTS`. Any blocked address refuses the hop with `egress_blocked_address`, unless `allowsBlockedAddress` is true (an allow-listed `localhost` or blocked literal: a local test server). A name that does not resolve is `egress_dns_failed`.
- **The pin**: the request goes out through `node:http` or `node:https` on a connection of its own (`agent: false`), with a `lookup` that answers the checked addresses whatever it is asked, so no second resolution can rebind the name. The host name stays the URL's: Node sends it as the Host header and the TLS server name and checks the certificate against it, with `rejectUnauthorized` forced on; the parser stays strict (`insecureHTTPParser: false`) and the headers within 16 KiB whatever the process's flags say. A proxy from the environment (`HTTP_PROXY`, `HTTPS_PROXY` with `NODE_USE_ENV_PROXY`) is ignored on purpose: it would connect to the name, not to the checked address.
- **Redirects**: GET only. A 301, 302, 303, 307 or 308 with a `Location` is followed, resolved against the URL that answered, once every check above has run again; one more than `maxRedirects` (required; 0 refuses the first) is `egress_too_many_redirects`, and a step from `https` down to `http` is `egress_insecure_redirect`. With `returnRedirect: true` that one more comes back instead, as a final response would (its body under the bounds below, `finalUrl` the URL that answered, `hops` the redirects followed), its `location` as sent, unfollowed and unchecked, a step down to `http` included: the caller checks it and, to fetch it, calls `fetchSafe` again.
- **Bounds**: `maxBytes` counts the body's bytes as received, copied into one buffer that grows to it as bytes arrive (a `Content-Length` sizes the first 64 KiB at most). A `Content-Length` above it is refused before reading and a longer body at the chunk that crosses it, both `egress_too_large`, where `truncate: true` returns the first `maxBytes` bytes with `truncated: true` and closes the connection instead; a response past 2 × `maxBytes` + 64 KiB read off the socket, every byte counted from the first (blank lines before the status line, endless `103 Early Hints`, a body in one-byte chunks), is `egress_too_large` either way. The request asks for `accept-encoding: identity` and nothing is decoded: a server that ignores it sends its compressed bytes, counted as they are, and a caller never inflates them without a bound of its own. `timeoutMs` bounds the whole call, every hop with its resolution and the body: `egress_timeout`. The defaults are `EGRESS_DEFAULT_MAX_BYTES` (1 MiB) and `EGRESS_DEFAULT_TIMEOUT_MS` (10 s), `fetchSafeConfig` in `http/config.ts`. A bound that is not a whole number of zero or more is `egress_invalid_options`, and so is one past its ceiling: 256 MiB, and 2,147,483,647 ms, past which a timer fires at once (`config_invalid` for the two variables).
- **Codes**: a rule's refusal keeps its code (400). The client's own answer as a gateway would: `egress_dns_failed`, `egress_too_many_redirects`, `egress_insecure_redirect`, `egress_too_large` and `egress_request_failed` (a refused connection or one reset before the body's end, a failed TLS check, a malformed response, a connection closed with no response, as Node closes one after a `101 Switching Protocols`; `details.reason` is Node's short code when there is one, `ECONNREFUSED`, `ECONNRESET`) are 502, `egress_timeout` 504; `egress_invalid_options` is the caller's bug, 500. A body with neither `Content-Length` nor chunking ends at the close: a reset fails it and the deadline makes it `egress_timeout`, while a FIN ends it as complete; over `https` Node cannot tell a FIN without `close_notify` from a clean close, so such a body can arrive cut short (RFC 9112 §9.8).
- **The span**: `egress.fetch`, one per call, with `host`, `status`, `response_bytes`, `redirect_count` and `duration_ms`, and `code` on a rejection; never the path or the query. The client sets `host` itself, outside the log schema, so no log line carries a host; it writes no log line. Each request goes out with tracing suppressed, so a host's HTTP instrumentation exports no span of its own, which would carry the full URL, and sends the far end no `traceparent`; its `http.client.request.duration` metric still records the method, the host, the port and the status.
- **Lists**: `options.lists` only narrows the operator's: its `denyHosts` adds to `EGRESS_DENY_HOSTS`, and its `allowHosts`, for a test's local server, replaces `EGRESS_ALLOW_HOSTS` outside production and is `egress_invalid_options` with `APP_ENV=production`.
- **Tests**: `options.resolve` replaces the resolver and supplies addresses only: every check runs on what it returns. `tests/egress.test.ts` runs a local server, reached through the allow-list, with a stub DNS, and a production child host with telemetry against a local collector; `tests/egress-dns.test.ts` runs the default resolver against a UDP DNS stub, each new `Resolver` pointed at it by a patch of its prototype, for the 50 ms grace and the retry.

## Workflows

What a module declares for the worker host (alpha-p2-050; [core/apps/worker/docs/workflows.md](../../apps/worker/docs/workflows.md)), in `workflows/index.ts`: `workflows = defineWorkflows({ <module>_<name>: { input, taskQueue: DEFAULT_TASK_QUEUE } })`, `activities = { <module>_<name>: defineActivity({ kind, input, run }) }` and `schedules = defineSchedules([{ id, workflow, spec, input }])`. Every input extends `workflowInput`, `{ workspaceId }`, and carries ids only (the lint rule `workflow-input-ids-only`). `kind` (`provider`, `ai`, `db`) sets the attempts. `run(input, context)` gets `ActivityContext<Tx>`: the workspace, `workflowId`, the id of the workflow execution that runs it (a schedule's run has one Temporal made, `<schedule id>-<time>`), the attempt and `tenant(fn)`, one tenant run per database step, `Tx` being db's `TenantClient`. `ActivityFunctions<typeof activities>` types a workflow's `proxyActivities`. Nothing here imports Temporal.

**Global.** Work that spans the workspaces (a period's grant per organization, a purge) declares `scope: "global"` on its workflow and on each of its activities, with an input that extends `globalWorkflowInput`, `{}`, ids only too; the worker refuses a global one whose input has `workspaceId` and a workspace one without it. A global activity's context is `{ attempt }` alone, with no tenant run: it reads the global tables in `withoutTenant("<module>.<reason>")` with db's `globalClient`, or starts one workflow per workspace. A schedule may name a global workflow (credits' `credits_period`); its input is parsed against that workflow's schema.

**Starting one on demand.** The api holds no Temporal client: a route writes its state and an event through the outbox in its transaction, and the module's subscriber, in the worker, calls `startWorkflow({ workflow, input, workflowId })`. The worker host binds the starter at its start (`bindWorkflowStarter`); the api binds none, so a call there, or before the worker's start, fails with `workflows_not_bound` (500). The input is parsed against the workflow's registration, and only what it declares is sent. `workflowId` is required and built from ids, `<module>.<purpose>:<workspaceId>:<id>`: a start of an id that is running or has run starts nothing and answers `{ started: false }`, so an event delivered twice starts one run, within the Temporal namespace's retention. `oneAtATime: true` makes it one run at a time instead (`ALLOW_DUPLICATE` with `FAIL`): a start while a run of the id is open answers `{ started: false }`, one after it closed starts a new run, for work that comes back, such as qualification's batch, `qualification.batch:<workspaceId>:current`.

**Cancelling one.** A subscriber cancels an open workflow by its id, a schedule's run by the `workflowId` its activity recorded: `cancelWorkflow({ workflowId })` answers `{ cancelled: true }`, and the workflow then ends as its cancellation handler decides, or `{ cancelled: false }` when no open workflow has that id (none ever, or it closed). Any other failure throws. The worker host binds it at its start beside the starter (`bindWorkflowCanceller`); elsewhere it fails with `workflows_not_bound`.

**A row's own schedule.** The same way, a subscriber gives a row a schedule of its own (signals' `signals-<sourceId>`): `createSchedule({ scheduleId, workflow, input, at, startNow?, paused? })` runs the workflow at each instant of `at`, to the second in UTC, and once now as well with `startNow`; it answers `{ created: false }` when the id exists, so a second delivery adds nothing. `pauseSchedule(scheduleId, paused)` and `deleteSchedule(scheduleId)` answer `{ found: false }` for one that is gone. The worker host binds them at its start (`bindWorkflowScheduler`); elsewhere they fail with `workflows_not_bound`.

## Metrics

A host or package declares its metrics in a `metrics.ts` of its own and emits through what `defineMetrics` returns, never through `@opentelemetry/api` directly (alpha-p10-060; [deploy/docs/observability.md](../../../deploy/docs/observability.md)):

```ts
export const apiMetrics = defineMetrics(
  { "api.requests": { kind: "counter", labels: ["method", "route", "status", "code"], unit: "{request}" } },
  import.meta.url,
);
apiMetrics["api.requests"].add(1, { method: "GET", route: "/health", status: 200, code: "none" });
```

- `kind` is `counter` (`add`), `histogram` or `gauge` (`record`); a name is dotted lower case (`invalid_metric`) and declared once per process (`duplicate_metric`, naming both files); `unit` is `s`, `By` or a `{word}`. A histogram in seconds gets the buckets 5 ms to 30 s.
- Labels come from the allow-list `metricLabels` (route templates, codes, names, kinds, outcomes): a label off it, in the PII registry or ending in an id or URL suffix is `metric_label_refused`, `email` and `person_id` among them. The recorder passes on the declared labels only.
- Under `APP_ENV=test` every emission is also kept: `recordedMetrics()` reads them in a test, and each test process writes them to `.tmp/metrics/<script>.json` at its exit. `registeredMetrics()` reads the registry.
- `pnpm observability:check` (`telemetry/observability-check.ts`) reads every `defineMetrics` call of `core/` and `ee/`, the dashboards and alert rules of `deploy/observability/` and `.tmp/metrics/`: it fails on a query naming no declared metric, on a declared metric no test emitted, and on a recorded label value shaped like an email, a URL or an id. Run the packages' tests first. Unit tests: `tests/metrics.test.ts`, `tests/observability-check.test.ts`.
- `recordOutboxStats(store)` sets the outbox's gauges (`outbox.dead_rows`, `outbox.lag`); the worker calls it on a timer.

## Credits

What a module calls for a priced action ([architecture §10](../../../docs/architecture.md#10-credits), [coding §7](../../../docs/rules/coding.md#7-credits)), from `credits/`; the credits module implements it ([core/modules/credits/README.md](../../modules/credits/README.md)) and binds it at the api's and the worker's start with `bindCreditsClient(implementation)`, so this package depends on no module. Before that, every call rejects with `credits_not_bound`.

```ts
const { usageId } = await credits.reserve({ workspaceId, action: "qualification.assessment", quantity: 1, idempotencyKey, subjectRef: leadId, lease: "async" });
// … the work …
await credits.commit(usageId); // or credits.release(usageId) when it failed
```

- `credits.reserve`, `commit(usageId, actualQuantity?)`, `release(usageId)`, `balance(workspaceId)` and `priceOf(action)` run inside the caller's tenant run (a request's, or `context.tenant` in an activity); amounts are decimal strings. `creditsCodes` names what a caller handles: `insufficient_credits` (402), `usage_not_open` (409).
- **Prices**: a module declares its priced actions in its `prices.ts`, `export const prices = definePrices([{ action: "qualification.assessment", credits: 1, unit: "lead" }], import.meta.url)`, and exports `prices` from its `index.ts`. An action is `<module>.<name>`; one priced twice fails at start with `duplicate_price_action` naming both files, a malformed one with `invalid_price_definition`. `registeredPrices()` lists them.
- Tests: `tests/credits.test.ts`.
