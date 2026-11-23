// The email lookup's sources and verifiers (README "Email lookups"): ENRICHMENT_EMAIL_SOURCES in its
// order, `email-finder` expanded into one source per adapter of PROVIDER_EMAIL_FINDER, and the
// verifiers of PROVIDER_EMAIL_VERIFIER in their turn order. Each adapter loads in a getAdapters call
// of its own; a name that cannot run is left out with its reason, as en-050's lists' names are
// (../sources/index.ts), and the worker's start warns once per list.
import { isAppError } from "@whytide/platform";
import {
  type BoundAdapter,
  emailFinderConfig,
  emailFinderPort,
  emailVerifierConfig,
  emailVerifierPort,
  getAdapters,
} from "@whytide/providers";
import { settings } from "../../settings.ts";
import { SOURCE_UNKNOWN } from "../constants.ts";
import { definedEmailSource, type EmailSourceDefinition } from "../sources/define.ts";
import { type LeftOut, variablesOf } from "../sources/index.ts";
import { EMAIL_FINDER, EMAIL_VERIFIER, FINDER_SOURCE_CLASS } from "./constants.ts";

type Finder = BoundAdapter<typeof emailFinderPort>;
type VerifierAdapter = BoundAdapter<typeof emailVerifierPort>;
/** A verifier in its turn: `email-verifier/<adapter>`, its counter's name too. */
export type Verifier = { readonly name: string; readonly adapter: VerifierAdapter };
export type EmailLists = {
  readonly sources: readonly string[];
  readonly finders: readonly string[];
  readonly verifiers: readonly string[];
};
export type LoadedEmail = {
  readonly sources: readonly EmailSourceDefinition[];
  readonly verifiers: readonly Verifier[];
  readonly leftOut: readonly LeftOut[];
};

const configured = (): EmailLists => ({
  sources: settings.ENRICHMENT_EMAIL_SOURCES,
  finders: emailFinderConfig.PROVIDER_EMAIL_FINDER,
  verifiers: emailVerifierConfig.PROVIDER_EMAIL_VERIFIER,
});
let lists: EmailLists | undefined;
let loading: Promise<LoadedEmail> | undefined;

/** For tests (testing/): lists in place of the settings'; undefined restores them. */
export function useEmailLists(next: Partial<EmailLists> | undefined): void {
  lists = next && { ...configured(), ...next };
  loading = undefined;
}

/** The email sources and verifiers, loaded once per process, and the names left out. */
export function loadEmail(): Promise<LoadedEmail> {
  loading ??= load(lists ?? configured());
  return loading;
}

/** The finder of PROVIDER_EMAIL_FINDER as a source: the three keys in, its address out. */
export function finderSource(name: string, adapter: Finder): EmailSourceDefinition {
  return Object.freeze({
    name: `${EMAIL_FINDER}/${name}`,
    kind: "email",
    activityKind: "provider",
    forName: true,
    provenance: { source: FINDER_SOURCE_CLASS, provider: name },
    allowance: () => adapter.allowance,
    run: async ({ firstName, lastName, companyDomain }) => {
      const answer = await adapter.findEmail({ firstName, lastName, companyDomain });
      if (answer.result === "not_found") return { found: false };
      const { address, vendorVerdict } = answer;
      return { found: true, candidates: [{ address, ...(vendorVerdict && { vendorVerdict }) }] };
    },
  } satisfies EmailSourceDefinition);
}

async function load({ sources, finders, verifiers }: EmailLists): Promise<LoadedEmail> {
  const leftOut: LeftOut[] = [];
  /** Each adapter of `names` loaded on its own: one that cannot load is left out. */
  const each = async <P extends typeof emailFinderPort | typeof emailVerifierPort>(
    port: P,
    names: readonly string[],
  ) => {
    const loaded: [string, BoundAdapter<P>][] = [];
    for (const name of names) {
      try {
        const [adapter] = await getAdapters(port, [name]);
        if (adapter) loaded.push([name, adapter]);
      } catch (error) {
        const reason = isAppError(error) ? error.code : "adapter_load_failed";
        leftOut.push({ list: port.variable, name, reason, variables: variablesOf(error) });
      }
    }
    return loaded;
  };
  const found: EmailSourceDefinition[] = [];
  for (const name of sources) {
    if (name === EMAIL_FINDER) {
      const loaded = await each(emailFinderPort, finders);
      for (const [adapter, bound] of loaded) found.push(finderSource(adapter, bound));
      continue;
    }
    const source = definedEmailSource(name);
    if (source) found.push(source);
    else {
      leftOut.push({
        list: "ENRICHMENT_EMAIL_SOURCES",
        name,
        reason: SOURCE_UNKNOWN,
        variables: [],
      });
    }
  }
  const turns = (await each(emailVerifierPort, verifiers)).map(([name, adapter]) => ({
    name: `${EMAIL_VERIFIER}/${name}`,
    adapter,
  }));
  return { sources: found, verifiers: turns, leftOut };
}
