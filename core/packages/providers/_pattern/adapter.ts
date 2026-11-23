// defineAdapter (docs/rules/coding.md §6 rules 2, 3 and 6): one folder per adapter, registered at
// import into a module-level map, as defineErrors and defineIds register codes and prefixes. No file
// lists the adapters by hand: registry.generated.ts (generate.ts writes it) maps "<port>/<adapter>"
// to a loader of that folder's index.ts, and resolveAdapter() imports the one adapter a selector
// names, so that a host loads no vendor SDK but the one it runs on; resolveAdapters() does the same
// for each name of a list, in its order. An adapter declares its free allowance and whether its data
// is open data, and the bound adapter exposes both beside the port's methods (README.md "Many
// adapters per port").
import { AppError } from "@whytide/platform";
import { ADAPTER_NAME, type Allowance } from "./config.ts";
import { patternErrors } from "./errors.ts";
import { type AnyPort, bindPort, type PortImplementation, type PortInstance } from "./port.ts";

export type AdapterDefinition<P extends AnyPort = AnyPort> = {
  readonly port: P;
  /** The folder name, `fake`, `anthropic`, `better-auth`: the value PROVIDER_<PORT> takes. */
  readonly name: string;
  /** The variables the adapter cannot run without; the contract suite skips while one is empty. */
  readonly requires: readonly string[];
  /**
   * The vendor's free calls per day or month, from the adapter's own `<ADAPTER>_ALLOWANCE`, read on
   * every access; null: none, no limit. Counting the calls is the caller's, never the port's.
   */
  readonly allowance: Allowance | null;
  /** Its data is open data: a company-data adapter's facts show as `open_data`, else `data_vendor`. */
  readonly openData: boolean;
  /** A new implementation; the registry calls it once per process and wraps it with bindPort(). */
  readonly create: () => PortImplementation<P>;
};
/** What a bound adapter exposes beside the port's methods, from its definition, not enumerable. */
export type AdapterDeclarations = Pick<AdapterDefinition, "allowance" | "openData">;
/** An adapter as the registry hands it out: the port's methods, then its declarations. */
export type BoundAdapter<P extends AnyPort> = PortInstance<P> & AdapterDeclarations;
/** `"<port folder>/<adapter>"` to the import of that folder's `index.ts`: the generated registry. */
export type AdapterLoaders = Readonly<Record<string, () => Promise<unknown>>>;

const adapters = new Map<string, Map<string, AdapterDefinition>>();
const instances = new WeakMap<AdapterDefinition, BoundAdapter<AnyPort>>();

export function defineAdapter<P extends AnyPort>(
  port: P,
  definition: {
    name: string;
    requires?: readonly string[];
    /** The allowance, or a function that reads it on every access: a fake's, which a test sets. */
    allowance?: Allowance | null | (() => Allowance | null);
    openData?: boolean;
    create: () => PortImplementation<P>;
  },
): AdapterDefinition<P> {
  const { name, requires = [], allowance = null, openData = false, create } = definition;
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
  const readAllowance = typeof allowance === "function" ? allowance : () => allowance;
  const adapter: AdapterDefinition<P> = Object.freeze({
    port,
    name,
    requires: [...requires],
    get allowance() {
      return readAllowance();
    },
    openData,
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
): Promise<BoundAdapter<P>> {
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
  if (cached) return cached as BoundAdapter<P>;
  // create() and the shape check are synchronous: no second caller slips in before the cache is set.
  const bound = bindPort(port, definition.create() as PortImplementation<P>, {
    adapter: definition.name,
  });
  const instance = withDeclarations(bound, definition);
  instances.set(definition, instance as BoundAdapter<AnyPort>);
  return instance;
}

/**
 * The adapters `names` lists (a providerList()), in its order, each as resolveAdapter() gives it,
 * the same instance; an empty list, none. A name given twice, or one the registry does not know,
 * fails before any adapter loads.
 */
export async function resolveAdapters<P extends AnyPort>(
  port: P,
  names: readonly string[],
  loaders: AdapterLoaders,
): Promise<readonly BoundAdapter<P>[]> {
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) {
    throw new AppError(patternErrors.provider_list_invalid, {
      details: { port: port.name, variable: port.variable, adapter: twice },
    });
  }
  const known = knownAdapterNames(port, loaders);
  const unknown = names.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    throw new AppError(patternErrors.provider_unknown, {
      details: { port: port.name, selector: unknown, known },
    });
  }
  const bound: BoundAdapter<P>[] = [];
  // One after another, in the list's order: a failing load stops the start at its name.
  for (const name of names) bound.push(await resolveAdapter(port, name, loaders));
  return Object.freeze(bound);
}

/** The bound adapter with its definition's declarations, not enumerable: its keys stay the port's methods. */
function withDeclarations<P extends AnyPort>(
  bound: PortInstance<P>,
  definition: AdapterDefinition,
): BoundAdapter<P> {
  return Object.defineProperties(bound, {
    allowance: { get: () => definition.allowance, enumerable: false },
    openData: { value: definition.openData, enumerable: false },
  }) as BoundAdapter<P>;
}
