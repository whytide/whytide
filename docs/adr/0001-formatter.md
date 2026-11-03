# ADR 0001: Biome formats the code; the first toolchain pins

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-10-21 |
| **Deciders** | the implementer of alpha-p0-010, a coding agent, as the task's open question allowed |

## Context

The coding rules say the formatter decides formatting and import order and nobody hand-formats (coding §10). The skeleton task left the choice between Biome, one tool for formatting, import ordering and linting, and Prettier with ESLint. The lint rules of the next task (module boundaries, no framework in `domain/`, no vendor SDK outside its adapter, no string literal in a screen, no raw `fetch`) depend on the choice, and so does the dependency count, which the security rules want small (security §7).

## Decision

Biome, pinned at 2.5.15, is the formatter and the import sorter: `pnpm format` runs `biome check --write`, `pnpm format:check` runs `biome check`. Beyond Biome's defaults: two-space indentation and a line width of 100. The linter is switched off in `biome.json` until the lint task turns it on with its rules. `core/modules/_template` is formatted like any other code, so a module created from it starts clean; it is excluded from builds (the workspace file) and from lint.

Prettier with ESLint lost on count and speed. Prettier, ESLint, typescript-eslint, an import-sorting plugin and the glue between them are five packages with hundreds of transitive dependencies from different maintainers, against one package and its platform binaries from one publisher. Biome checks the whole workspace in well under a second, which keeps `pnpm -F <module> lint` fast enough to run while working.

## Consequences

- The lint task writes its rules for Biome: `noRestrictedImports` and `noRestrictedGlobals` with path overrides cover the boundary, framework, vendor SDK, Mastra and raw-fetch rules; GritQL plugins cover what the built-in rules cannot, such as a literal in JSX. If one rule cannot be expressed, that task adds a small script for that rule alone; the formatter does not change.
  - Amended 2026-10-21 by alpha-p0-020: none of the seven rules is a Biome rule. Biome's restrictions cannot see the importing file's path, read the vendor registry or inspect comments, so the rules are one small linter on the TypeScript compiler API in `tools/lint/`, as that task's design asked. The formatter did not change and Biome's linter stays off ([tools/lint/README.md](../../tools/lint/README.md)).
- Markdown and YAML are not formatted by the tool; they follow the style of the existing docs.
- Biome reads `.gitignore`, so generated files (`*.generated.*`, `openapi.json`, the Prisma client) and build outputs are never checked.

## Also decided here: the toolchain pins

- **Node 26.12.0** (`.node-version`, `engines.node >= 26`): the current LTS line. Node 24 entered maintenance on 2026-10-20 and Node 26 becomes Active LTS on 2026-10-28, with support until April 2029. The patch version is bumped by the update bot.
- **pnpm 12.10.1** (`packageManager` in `package.json`): any pnpm 10 or later switches to it by itself, so nothing else is installed.
- **TypeScript 6.0.3**, not 7.0: TypeScript 7 ships the native compiler without the programmatic API (`lib/typescript.js`) that Next.js, the NestJS CLI and typescript-eslint call; 6.0 is the last release with it and the one the hosts' tasks can build on. Revisit when TypeScript 7.1 ships the API and the frameworks support it.
