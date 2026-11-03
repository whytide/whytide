// The registry (docs/architecture.md §9 rule 3): registry.generated.ts, written by
// _pattern/generate.ts, maps every "<port>/<adapter>" to a loader of that folder's index.ts;
// getAdapter() resolves the selector the port's PROVIDER_<PORT> variable carries, imports that one
// adapter, binds it and keeps it for the process. Nothing else knows which adapter runs, and no host
// loads a vendor SDK it does not run on.
import { resolveAdapter } from "./_pattern/adapter.ts";
import type { AnyPort, PortInstance } from "./_pattern/port.ts";
import { adapterLoaders } from "./registry.generated.ts";

/** The port's adapter named by `selector` (`config.PROVIDER_<PORT>`), loaded and bound on first use; a host awaits it at start. */
export function getAdapter<P extends AnyPort>(
  port: P,
  selector: string | undefined,
): Promise<PortInstance<P>> {
  return resolveAdapter(port, selector, adapterLoaders);
}
