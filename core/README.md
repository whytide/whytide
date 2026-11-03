# core/

Whytide Core: everything that is not on the enterprise list in `ee/`. Three kinds of folders (docs/architecture.md §4.1):

- `apps/`: the hosts. They mount what the modules export and hold no feature code.
- `modules/`: one folder per feature, all the same shape. `_template/` is the shape; `pnpm module:new <name>` copies it.
- `packages/`: what every module uses: `platform`, `db`, `providers`, `ai`, `ui`. A change here is its own merge request, before the modules that need it.
