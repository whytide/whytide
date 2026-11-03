# tools/

Developer tooling. It ships with no dependencies of its own; `lint/` and `ci/` are workspace packages, the rest are scripts.

- `module-new.mjs`: `pnpm module:new <name>` copies `core/modules/_template` to `core/modules/<name>` and replaces every `__module__` with the name. Then `pnpm install` registers the new package.
- [`lint/`](lint/README.md): the structural lint rules behind `pnpm lint`, with their fixtures and the vendor SDK registry.
- [`ci/`](ci/README.md): the pipeline runner behind `pnpm ci:local`, the branch checks `docs:check` and `changeset:check`, the supply-chain steps `secrets:scan` and `deps:check` with the pre-commit hook, and the shell of the GitLab job that `.gitlab-ci.yml` at the root defines.
