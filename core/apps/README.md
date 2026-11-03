# core/apps/

The hosts (docs/architecture.md §4.1): `web`, the Next.js host for tenants; `api`, the NestJS host that mounts the modules' API; `worker`, the Temporal host that registers the modules' workflows and runs the agents. A host holds no feature code. Its module list is generated at build from `core/modules/` into a `*.generated.ts` file that git ignores (docs/rules/coding.md §1); the generators come with the hosts' own tasks. The operator hosts, `admin` and `admin-api`, come with the admin app after alpha.
