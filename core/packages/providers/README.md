# @whytide/providers

The ports and their adapters (docs/architecture.md §9, docs/rules/coding.md §6): a port in our words at `<port>/port.ts`, one adapter per folder at `<port>/<vendor>/`, a fake for every port, a registry that loads the adapter a name selects, one contract suite per port run against every adapter, and `provider_refs` for vendor ids. Alpha's ports, authentication, LLM, LinkedIn, files and app mail, arrive with their own tasks on this pattern. Node runs the sources; `tsc -b` writes `dist/`, which the package exports as `@whytide/providers` and, for tests, `@whytide/providers/testing` and `@whytide/providers/<port>/testing`.

| Path | Holds |
|---|---|
| `_pattern/` | `definePort`, `bindPort`, `defineAdapter`, `createFake`, `providerSelector`, `setProviderRef`, `resolveAdapter`, the pattern's codes, the generator |
| `registry.ts` | `getAdapter(port, selector)`, over the generated loaders |
| `registry.generated.ts` | `adapterLoaders`, `"<port>/<adapter>"` to `() => import("./<port>/<adapter>/index.ts")`, written by `_pattern/generate.ts`; ignored by git, never committed |
| `testing/` | `contractSuite` |
| `<port>/` | `port.ts`, `config.ts`, `contract.ts`, `README.md`; one folder per adapter, `fake/` and `<vendor>/`, each with `index.ts` and `tests/contract.test.ts` (a vendor's with `README.md`); `tests/` for port-level tests only; optionally `testing/` for the port's test helpers, `@whytide/providers/<port>/testing` |
| `tests/` | this package's tests; `tests/fixtures/pattern/fixture/` is a complete port laid out as the real ones are; `tests/safety/` the send path's safety cases |

| Command | Does |
|---|---|
| `pnpm -F providers test` | the generator, `tsc -b` (the platform first), then `tests/*.test.ts`: `pattern.test.ts` end to end, `registry.test.ts`, `exports.test.ts`; one folder deep, so never `tests/safety/` |
| `pnpm -F providers test:safety` | the same preparation, then `tests/safety/*.test.ts`: the send path's safety cases ("Tests") |
| `pnpm -F providers test:contract` | the pipeline's step: every `*.test.ts` of a `<port>/tests/` or `<port>/<adapter>/tests/` folder |
| `pnpm -F providers lint`, `typecheck`, `build`, `generate` | the structural lint; the generator then `tsc -b`; the generator alone |

Inside the package, import from `_pattern/index.ts` and from the port's own files by relative path, never from the package `index.ts` or `registry.ts`: a port's files do not depend on the registry, and `registry.generated.ts` exists only once the generator ran.

## A port

`<port>/port.ts` declares the methods as Zod input and output schemas and the codes, `<port>_<reason>`:

```ts
export const llmPort = definePort({
  name: "llm",
  methods: {
    getModel: { input: z.object({ modelRef: z.string() }), output: z.strictObject({ … }) },
    listModels: { input: z.void(), output: z.array(z.strictObject({ … })) },
  },
  errors: { llm_rate_limited: { status: 429 }, llm_timeout: {}, llm_invalid_key: {}, llm_provider_error: {} },
});
```

The name is `snake_case` and names the folder (`app_mail` lives in `app-mail/`); `errorPrefix` sets the codes' prefix when it differs from the name; `alwaysCheckOutputs: true` has the outputs checked in production too ("The boundary"). A code off the prefix, a method that is not a camelCase name or is named like a fake's control (`recordedCalls`, `failNext`, `answerNext`, `reset`, `state`, `record`), or a second port of the same name fails at import (`port_invalid`, `duplicate_port`). Every method is async and takes one argument, `z.void()` for none. Output schemas describe, they do not transform: an output is checked, not rewritten (below); `z.strictObject` is the shape for an output object, since it refuses a vendor's object outright, naming the key. The codes are registered through the platform's `defineErrors`, so `port.errors.llm_timeout` is typed and `httpStatus` knows them; three more are registered for the port: `<prefix>_input_invalid` (400), `<prefix>_output_invalid` and `<prefix>_error_unmapped` (500).

`<port>/config.ts` declares the selector, written out so that `pnpm env:check` reads it, and `deploy/.env.example` gets the line at the end of the `packages/providers` block, `PROVIDER_LLM=fake`:

```ts
export const llmConfig = defineConfig("packages/providers", { PROVIDER_LLM: providerSelector() });
```

`providerSelector()` is an optional adapter folder name, so that importing the package never throws. Every `<port>/port.ts` re-exports its config, `export { llmConfig } from "./config.ts";`, so that a host imports the port, its config and `getAdapter` from the package root; `await getAdapter(llmPort, llmConfig.PROVIDER_LLM)` fails at start with `provider_not_configured` when it is empty and `provider_unknown`, listing the names the registry knows, when nothing is registered or loadable under it. The list of adapters lives in the registry, never in the schema. Organization-level selection comes later, at the same call.

`<port>/README.md` documents the port: its methods, its codes, what it will never have, how a method is added (with its contract case). The package `index.ts` gets one line, `export * from "./<port>/port.ts";`, in alphabetical order; the fakes and adapters are not exported, the registry reaches them. A port's test helpers, `<port>/testing/index.ts`, reach other packages' tests as `@whytide/providers/<port>/testing` (`signInAs` from `auth/testing`, `readMailpit` from `app-mail/testing`) through the one `./*/testing` pattern of `package.json`, so a port adds no export of its own.

## An adapter

`<port>/<vendor>/index.ts` is the whole adapter as far as the rest of the product knows:

```ts
export const anthropicAdapter = defineAdapter(llmPort, {
  name: "anthropic",
  requires: ["LLM_ANTHROPIC_API_KEY"],
  create: () => ({ getModel: async ({ modelRef }) => …, listModels: async () => … }),
});
```

The name is the folder name (`fake`, `anthropic`, `better-auth`) and the value `PROVIDER_<PORT>` takes; a second adapter of that name fails at import (`duplicate_adapter`). `create()` returns the implementation: exactly the port's methods, given the parsed input, throwing the port's codes (an `AppError`), reading its own variables through its own `defineConfig` in the folder, each one optional and checked in `create()`, so that a missing key fails when the adapter starts, never at import. `requires` names the variables it cannot run without: the contract suite skips while one is empty. The vendor SDK is imported in this folder only: the adapter task adds `"core/packages/providers/<port>/<vendor>": ["<sdk package>"]` to `tools/lint/vendor-sdks.json` in the same merge request, and `pnpm lint` fails on an import anywhere else; `fetch` is allowed in the folder too (`no-raw-fetch`). The adapter writes a vendor's id for one of our rows with `setProviderRef` (below), never into a domain column. `<port>/<vendor>/tests/contract.test.ts` is the adapter's one `contractSuite` call (below): the folder holds everything of the adapter.

`<port>/<vendor>/README.md` is the docs page of docs/architecture.md §9 rule 6, with these sections: **Covers** (which methods, with what limits); **Vendor and terms** (the account, the data-processing and no-training or retention terms the key is used under, where the contract is kept); **Variables** (each one of `deploy/.env.example`, which are secrets, which `requires` names, how to get a sandbox key); **Provider refs** (what the adapter stores under its name in `provider_refs`, or its own table); **Known differences** from the port's words, if any. Adding an adapter is this folder, its registry entry (generated) and this page; nothing shared changes.

## The fake

`<port>/fake/index.ts` is written with the port, before the vendor adapter, and runs the whole suite from `<port>/fake/tests/contract.test.ts`: that is the proof nothing outside the adapter depends on the vendor. `createFake(port, { state, methods, helpers })` gives it in-memory state, `recordedCalls` and failure injection; the module tests and the Compose smoke test run on it:

```ts
export const llmFake = createFake(llmPort, {
  state: () => ({ scripted: [] as Output[] }),
  methods: (fake) => ({ getModel: async ({ modelRef }) => …fake.state…, listModels: async () => … }),
  helpers: (fake) => ({ script: (output: Output) => fake.state.scripted.push(output) }),
});
export const llmFakeAdapter = defineAdapter(llmPort, { name: "fake", create: () => llmFake });
```

`fake.state` is read on every call, never kept: `reset()` replaces it. `recordedCalls` holds every port call since the last reset, in order, `{ method, input }` with the parsed input, and what `fake.record(name, input)` adds in between: a call the port does not see (what a model object received), under the name of the thing called. `failNext(code, details?)` makes the next call, whatever the method, throw that port code; several queue up; a code the port does not declare is refused (`adapter_invalid`), as is a method the port does not declare. `answerNext(method, answer)` makes the next call of that method answer `answer` as given, or throw it when it is an `Error`, instead of the fake's own method: what a vendor might send, off the port's words, so that a test reaches `<prefix>_output_invalid` and `<prefix>_error_unmapped`, which `failNext`, taking declared codes only, cannot; answers queue up per method, a pending `failNext` goes first, a method the port does not declare is refused (`adapter_invalid`) and `reset()` clears them. `helpers` are the port's own hooks (seeding, reading what was sent). The fake validates nothing: the boundary does. `create` returns the one module-level fake, so a test reaches the same instance the module got from the registry; the contract suite resets a fake before each case.

## The registry

`_pattern/generate.ts` writes `registry.generated.ts`: `adapterLoaders`, one `"<port>/<adapter>": () => import("./<port>/<adapter>/index.ts")` per adapter folder (a folder with an `index.ts` inside a folder with a `port.ts`; `tests/`, `testing/` and `_*` folders are not adapters). `build`, `typecheck`, `test` and `test:contract` run it first; a consumer's `tsc -b` needs it to have run once (`pnpm build`), as `db` needs its generated client. Each adapter registers itself at import, in a module-level map (`registeredAdapters(port)`), the way `defineErrors` and `defineIds` register codes and prefixes; no file lists them by hand.

`getAdapter(port, selector)` is async and loads lazily: it resolves the selector, imports that one adapter's folder (the import registers it), calls `create()`, binds the implementation and checks its shape, once per adapter and process, so a module and its test hold the same instance; a host awaits its adapters at start, and no vendor SDK is loaded but the one that runs. An adapter already registered in the process, the fake a test imported, is used without an import. When the import, `create()` or the shape check fails, nothing is kept and the next call starts over; a folder whose `index.ts` registers no adapter of that name fails with `adapter_invalid`. `getAdapter(llmPort, "fake")` in a test returns the fake, whose controls stay reachable on it. The returned object has exactly the port's methods: an implementation missing one or exposing one the port does not declare fails with `port_shape_mismatch` (a fake's controls aside). Nothing outside the registry knows which adapter runs. `resolveAdapter(port, selector, loaders)` is the same over any loader map; the registry's tests use it.

## The boundary

`bindPort(port, implementation, { adapter, checkOutputs?, keepCause? })` is what the registry and the suite put around an implementation. Every call parses its input against the method's schema and hands the parsed value on; an input off the schema fails with `<prefix>_input_invalid`, the method and the issues in `details`. An error that is not an `AppError` with one of the port's codes becomes `<prefix>_error_unmapped` in every environment, `details` holding the method and the vendor error's own `code`, `name` or `status` when it is a number or one short word, never its message: no vendor payload reaches a log line (docs/rules/coding.md §9); `vendorCode(error)` is that rule for an error an adapter reports after the call, midway through a stream it returned. In development and tests, that is while `APP_ENV` is not `production`, the vendor error is kept as the `cause` for the person reading the failure (`keepCause` sets it by hand), and the output is checked too (`checkOutputs`): it has to parse, and parsing may change nothing. A key parsing dropped is a vendor's field (`<prefix>_output_invalid`, with the method, the path and the reason `a field the port does not declare`); a value it rewrote is a transform in the schema (`the schema transforms`); an object of any class, a vendor SDK's response instance, is walked by its own keys. Schemas that return what they are given opt out of the field check: `z.looseObject`, `z.record`, `z.unknown`, `z.any`, `z.custom`, and the contents of a `z.map` or `z.set`. Production keeps no cause, so that a vendor error stays out of its logs, and passes outputs through unchecked, trusting what the suite proved; but a port defined with `alwaysCheckOutputs: true` has its outputs checked in every environment, whatever a binding's `checkOutputs` says. The LinkedIn port is one, so that a vendor's contact field stops here even where an adapter forgets its parse ([linkedin/README.md](linkedin/README.md)); the other ports' outputs are checked outside production only, as in alpha, since their production answers were never checked.

## The contract suite

`<port>/contract.ts` holds the port's cases, what every adapter of it does, by title; `<port>/<adapter>/tests/contract.test.ts` is the adapter's one `contractSuite(port, adapter, cases)` call, the fake's included, so that an adapter's folder holds everything of it; `<port>/tests/` is for port-level tests only:

```ts
// llm/anthropic/tests/contract.test.ts
contractSuite(llmPort, anthropicAdapter, llmCases); // skipped while LLM_ANTHROPIC_API_KEY is empty
```

A suite is a `describe` named `<port> contract: <adapter>`: it creates and binds the adapter once, checks that every port method is there, then runs each case with the bound adapter and the test context, resetting a fake before each. A case that fails names itself and, through the boundary's error, the method. While a variable the adapter `requires` is empty in the environment (the fourth argument, `process.env` by default), the suite holds one skipped test, `skipped: no credentials (<variables>)`, so that the run counts it as skipped and exits 0: a missing secret never fails a test (docs/rules/coding.md §11). `pnpm -F providers test:contract` runs every test file of a `<port>/tests/` or `<port>/<adapter>/tests/` folder, `*/tests/*.test.ts` and `*/*/tests/*.test.ts` (one folder level each), so that a port's or an adapter's tests keep their own names; it is the pipeline's `test:contract` step; the real adapters of Mailpit and MinIO run against the shared stack, the vendor ones only where their key is present.

## provider_refs

A vendor's id for one of our rows (a Unipile account, a Stripe customer) sits in the row's jsonb column `providerRefs Json? @map("provider_refs")`, keyed by adapter name, or in the adapter's own table, never in a domain column (docs/architecture.md §9 rule 5). `setProviderRef(row, adapter, id)` returns a copy of the row with the ref set, the others kept; an empty id or a name that is not an adapter folder name fails with `provider_ref_invalid`. The schema lint of `core/packages/db` (`provider-refs`) rejects a domain column named with a vendor and ending in `_id`, `unipile_account_id` or `stripe_customer_id`, unless the table is the adapter's own, named `<vendor>_…`. Replacing an adapter is a migration of its refs.

## Tests

`tests/pattern.test.ts`, end to end: the fixture port of `tests/fixtures/pattern/fixture/` with its fake and two more adapters, `echo` and `lazy`, run the same contract suite through `node --test`, each from its `tests/contract.test.ts`; the `broken` adapter, whose `greet` returns a vendor field, fails the suite naming `greet`; the `needs-key` adapter's suite is skipped without `FIXTURE_API_KEY` and exits 0; `PROVIDER_FIXTURE=fake` through `defineConfig` returns the fake and `getAdapter(fixturePort, "nope")` fails with `provider_unknown` listing `echo` and `fake`; the boundary parses inputs and, in test mode, refuses a vendor field, a vendor object, a wrong type and a transform; an unmapped error is wrapped in every environment and carries its cause in test mode only; under `APP_ENV=production`, in a child process (`tests/fixtures/pattern/production.ts`), no output check and no cause by default, both on where a binding asks, and the LinkedIn port's outputs checked whatever the binding says; the fake records, fails on demand, answers on demand (`answerNext`), resets and refuses a stray method; the shape check; the definitions' checks; `setProviderRef`. `tests/registry.test.ts`: the generated loaders from a folder tree, the registered adapters, one bound instance per adapter, the `lazy` adapter loaded through a loader and nothing else, nothing kept when a loader, `create()` or the shape check fails. `tests/exports.test.ts`: the contract harness and the ports' test helpers imported through the package name, from `dist/`; a fake's folder not exported, and no `testing/` folder but the package's and a port's, beside its `port.ts` (a `_*` folder is no port), since `*` in `./*/testing` spans folders.

`tests/safety/`, run by `test:safety` and never by `test`: the send path's safety cases, each naming the rule it holds. `port-idempotency.test.ts`: the LinkedIn fake ignores the idempotency key and records every repeat, so a double send shows as two calls. `port-never-list.test.ts`: no LinkedIn method name holds a never-list word, in the types and at run time, and an adapter adding one fails the shape check.

## The LLM port

`llm/` (alpha-p1-100) hands out an AI SDK model object, opaque at the boundary through `z.custom`. The boundary does not see that model's calls, so they have one of their own, `bindModel` in `llm/boundary.ts`, which an adapter hands its model out through. Its fake's controls act on that model's calls rather than on the port's: `recordedCalls` holds what each model call received, `failNext` fails the next one, and `getModel` is neither recorded nor failed, nor answered: `answerNext` does not reach the lookups. [llm/README.md](llm/README.md) has the port, the fake and how a module's test scripts it.

## Metrics

`bindPort` counts every call of a bound method as `providers.calls` (port, adapter, method, outcome: `ok` or the port's code), declared in `_pattern/metrics.ts` (alpha-p10-060; [deploy/docs/observability.md](../../../deploy/docs/observability.md)). A rate limit is the `<prefix>_rate_limited` outcome.
