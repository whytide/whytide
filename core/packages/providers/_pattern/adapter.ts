// defineAdapter (docs/rules/coding.md §6 rules 2, 3 and 6): one folder per adapter, registered at
// import into a module-level map, as defineErrors and defineIds register codes and prefixes. No file
// lists the adapters by hand: registry.generated.ts (generate.ts writes it) maps "<port>/<adapter>"
// to a loader of that folder's index.ts, and resolveAdapter() imports the one adapter a selector
// names, so that a host loads no vendor SDK but the one it runs on.
import { AppError } from "@whytide/platform";
import { ADAPTER_NAME } from "./config.ts";
import { patternErrors } from "./errors.ts";
import { type AnyPort, bindPort, type PortImplementation, type PortInstance } from "./port.ts";

export type AdapterDefinition<P extends AnyPort = AnyPort> = {
  readonly port: P;
  /** The folder name, `fake`, `anthropic`, `better-auth`: the value PROVIDER_<PORT> takes. */
  readonly name: string;
  /** The variables the adapter cannot run without; the contract suite skips while one is empty. */
  readonly requires: readonly string[];
  /** A new implementation; the registry calls it once per process and wraps it with bindPort(). */
  readonly create: () => PortImplementation<P>;
};
/** `"<port folder>/<adapter>"` to the import of that folder's `index.ts`: the generated registry. */
export type AdapterLoaders = Readonly<Record<string, () => Promise<unknown>>>;

const adapters = new Map<string, Map<string, AdapterDefinition>>();
const instances = new WeakMap<AdapterDefinition, PortInstance<AnyPort>>();

export function defineAdapter<P extends AnyPort>(
  port: P,
  definition: { name: string; requires?: readonly string[]; create: () => PortImplementation<P> },
): AdapterDefinition<P> {
  const { name, requires = [], create } = definition;
  if (!ADAPTER_NAME.test(name)) {
    throw new AppError(patternErrors.adapter_invalid, {
      details: { port: port.name, adapter: name, reason: "the name is not a folder name" },
    });
  }
  const known = adapters.get(port.name) ?? new Map<string, AdapterDefinition>();
  if (known.has(name)) {
    throw new AppError(patternErrors.duplicate_adapter, {
      details: { port: port.name, adapter: name },
    });
  }
  const adapter: AdapterDefinition<P> = Object.freeze({
    port,
    name,
    requires: [...requires],
    create,
  });
  known.set(name, adapter as unknown as AdapterDefinition);
  adapters.set(port.name, known);
  return adapter;
}

/** The adapters registered for a port, by name. */
export function registeredAdapters(port: AnyPort): ReadonlyMap<string, AdapterDefinition> {
  return adapters.get(port.name) ?? new Map();
}

/** The port's folder: its name with dashes, `app_mail` in `app-mail/`. */
export const portFolder = (port: AnyPort): string => port.name.replaceAll("_", "-");

/** The adapter names the registry knows for a port, registered already or loadable, sorted. */
export function knownAdapterNames(port: AnyPort, loaders: AdapterLoaders): string[] {
  const prefix = `${portFolder(port)}/`;
  const loadable = Object.keys(loaders)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  return [...new Set([...registeredAdapters(port).keys(), ...loadable])].sort();
}

/** The adapter `selector` names, imported if need be and bound once per process; nothing is kept when a step fails. */
export async function resolveAdapter<P extends AnyPort>(
  port: P,
  selector: string | undefined,
  loaders: AdapterLoaders,
): Promise<PortInstance<P>> {
  if (selector === undefined) {
    throw new AppError(patternErrors.provider_not_configured, {
      details: { port: port.name, variable: port.variable },
    });
  }
  let definition = registeredAdapters(port).get(selector);
  if (!definition) {
    const load = loaders[`${portFolder(port)}/${selector}`];
    if (!load) {
      throw new AppError(patternErrors.provider_unknown, {
        details: { port: port.name, selector, known: knownAdapterNames(port, loaders) },
      });
    }
    await load(); // the folder's index.ts registers the adapter with defineAdapter
    definition = registeredAdapters(port).get(selector);
    if (!definition) {
      throw new AppError(patternErrors.adapter_invalid, {
        details: {
          port: port.name,
          adapter: selector,
          reason: "the folder's index.ts registered no adapter of that name for the port",
        },
      });
    }
  }
  const cached = instances.get(definition);
  if (cached) return cached as PortInstance<P>;
  // create() and the shape check are synchronous: no second caller slips in before the cache is set.
  const instance = bindPort(port, definition.create() as PortImplementation<P>, {
    adapter: definition.name,
  });
  instances.set(definition, instance);
  return instance;
}
