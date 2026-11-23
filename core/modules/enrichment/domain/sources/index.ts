// The sources this process runs (README "A name that cannot run"): ENRICHMENT_COMPANY_SOURCES, then
// ENRICHMENT_PERSON_SOURCES, in their order, `company-data` expanded into one source per adapter of
// PROVIDER_COMPANY_DATA. Each adapter loads in a getAdapters call of its own, since one that cannot
// load fails a whole list's call. A name that cannot run is left out with its reason, never an
// error: a name no source of the list's kind defines, an adapter the registry does not know, one
// without its key or contact, named by its variable and never its value. The worker's start logs
// one warning per list with a name left out and starts with the rest (workflows/index.ts);
// deploy:check refuses those names before a deploy.
import { isAppError, type Logger } from "@whytide/platform";
import { companyDataConfig, companyDataPort, getAdapters } from "@whytide/providers";
import { settings } from "../../settings.ts";
import { COMPANY_DATA, SOURCE_UNKNOWN } from "../constants.ts";
import { companyDataSource } from "./company-data.ts";
// Each module source defines itself as its file loads (define.ts).
import "./country-ai.ts";
import { definedSource, type SourceDefinition, type SourceKind } from "./define.ts";
// The module's own sources, each defined as its file loads.
import "./linkedin.ts";
import "./linkedin-contact-info.ts";
// The email sources of gamma-en-085.
import "./pattern.ts";
import "./reply.ts";
import "./web-search/index.ts";
import "./website/email.ts";
import "./website/index.ts";

/** A name a list gives that this process does not run, why, and the variables it lacks. */
export type LeftOut = {
  readonly list: string;
  readonly name: string;
  readonly reason: string;
  readonly variables: readonly string[];
};
export type LoadedSources = {
  readonly sources: readonly SourceDefinition[];
  readonly leftOut: readonly LeftOut[];
};
/** The lists, by the setting that gives each. */
export type SourceLists = {
  readonly company: readonly string[];
  readonly person: readonly string[];
  readonly companyData: readonly string[];
};

const VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const configured = (): SourceLists => ({
  company: settings.ENRICHMENT_COMPANY_SOURCES,
  person: settings.ENRICHMENT_PERSON_SOURCES,
  companyData: companyDataConfig.PROVIDER_COMPANY_DATA,
});
let lists: SourceLists | undefined;
let loading: Promise<LoadedSources> | undefined;

/** For tests (testing/): lists in place of the settings'; undefined restores them. */
export function useSourceLists(next: Partial<SourceLists> | undefined): void {
  lists = next && { ...configured(), ...next };
  loading = undefined;
}

/** The sources, loaded once per process, and the names left out; it never throws. */
export function loadSources(): Promise<LoadedSources> {
  loading ??= load(lists ?? configured());
  return loading;
}

/** The loaded source of that name; undefined for one a plan of other lists named. */
export async function sourceNamed(name: string): Promise<SourceDefinition | undefined> {
  return (await loadSources()).sources.find((source) => source.name === name);
}

/** One warning per list with a name left out: each name, its reason and the variables it lacks. */
export function warnLeftOut(log: Logger, leftOut: readonly LeftOut[]): void {
  for (const list of new Set(leftOut.map((entry) => entry.list))) {
    const details = leftOut
      .filter((entry) => entry.list === list)
      .map(({ name, reason, variables }) => ({
        provider: name,
        reason,
        ...(variables.length > 0 && { variable: variables.join(",") }),
      }));
    log.warn(
      { variable: list, details },
      "enrichment: names left out of the list; the worker runs the others",
    );
  }
}

async function load({ company, person, companyData }: SourceLists): Promise<LoadedSources> {
  const sources: SourceDefinition[] = [];
  const leftOut: LeftOut[] = [];
  const expand = async () => {
    for (const name of companyData) {
      try {
        const [adapter] = await getAdapters(companyDataPort, [name]);
        if (adapter) sources.push(companyDataSource(name, adapter));
      } catch (error) {
        const reason = isAppError(error) ? error.code : "adapter_load_failed";
        leftOut.push({
          list: companyDataPort.variable,
          name,
          reason,
          variables: variablesOf(error),
        });
      }
    }
  };
  const add = async (list: string, kind: SourceKind, names: readonly string[]) => {
    for (const name of names) {
      if (kind === "company" && name === COMPANY_DATA) {
        await expand();
        continue;
      }
      const source = definedSource(name, kind);
      if (source) sources.push(source);
      else leftOut.push({ list, name, reason: SOURCE_UNKNOWN, variables: [] });
    }
  };
  await add("ENRICHMENT_COMPANY_SOURCES", "company", company);
  await add("ENRICHMENT_PERSON_SOURCES", "person", person);
  return { sources, leftOut };
}

/** A config_invalid's variables (`COMPANIES_HOUSE_API_KEY: required by …`), by name only. */
export function variablesOf(error: unknown): string[] {
  const given = isAppError(error) ? error.details?.variables : undefined;
  if (!Array.isArray(given)) return [];
  const names = given.map((entry) => String(entry).split(":")[0]?.trim() ?? "");
  return names.filter((name) => VARIABLE.test(name));
}
