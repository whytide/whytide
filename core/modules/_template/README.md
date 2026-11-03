# __module__

What this module owns, in one paragraph.

- **Owns:** the tables in `packages/db/prisma/schema/__module__.prisma`, the screens under `ui/`, the workflows under `workflows/`.
- **Public interface:** `index.ts`, the only importable file: its types, queries, commands and events. Another module reads this one's data through the queries and changes it only through the commands or by an event (docs/rules/coding.md §2).
- **Depends on:** `platform`, `providers`, `ai` and `db` as needed: add each to `package.json` and to `references` in `tsconfig.json`.
- **Reviewers:** the owners of this module.
