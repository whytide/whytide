// The registry of source kinds (README.md "Adding a kind"): every sources/<kind>/index.ts, imported by
// the generated list, registers itself with defineSourceKind as it loads, so importing this file at
// start fills it, or fails on a duplicate. A write checks its kind and its config here.
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";
import { registeredSourceKinds, type SourceKind } from "./_contract.ts";

export { registeredSourceKinds };

// By a path the compiler does not follow, as the hosts import their generated lists: a host that
// builds every module (the worker's modules:build) compiles this one before the list exists; the
// start needs it, and fails naming the file without it.
const list = "./registry.generated.ts";
await import(list);

/** The registered kind with the name, or signal_kind_unknown naming the field `kind`. */
export function sourceKind(name: string): SourceKind {
  const kind = registeredSourceKinds().get(name);
  if (kind === undefined) {
    throw new AppError(errors.signal_kind_unknown, { details: { fields: ["kind"] } });
  }
  return kind;
}

/**
 * The config as the kind's schema reads it, or signal_config_invalid naming the paths, `config.…`.
 * Async: a schema may call out (post_engagers resolves a short link), and what it throws, an AppError
 * of the kind's, comes through as it is.
 */
export async function parseSourceConfig(kind: SourceKind, value: unknown): Promise<unknown> {
  const result = await kind.configSchema.safeParseAsync(value);
  if (result.success) return result.data;
  const paths = result.error.issues.map((issue) => ["config", ...issue.path.map(String)].join("."));
  throw new AppError(errors.signal_config_invalid, { details: { fields: [...new Set(paths)] } });
}
