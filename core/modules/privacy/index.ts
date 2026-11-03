// The public interface of privacy (README.md): the registries the hosts load. The deletion script is
// `pnpm erase`, cli/erase.ts, which nothing imports; no module imports this one, since it imports
// theirs. Nothing else in this module is importable from outside it (docs/rules/coding.md §2).
export { errors } from "./errors.ts";
export { ids } from "./ids.ts";
