// A source (README "Sources", docs/concepts.md): a definition and a name in one of the module's
// lists, unique within its kind; an email source (gamma-en-080) proposes addresses instead of
// facts. It says what it needs, any one input of which lets it run, what it fills, the activity kind
// it runs in, its free allowance and the provenance its facts carry. `run` gets the minimum input
// (RB-7.3.1) with the run's workspace and company ids, and a way to open a run of that workspace for
// its own reads; it answers the facts it found, with the provider that answered when it is not the
// definition's, or none, with its own word for a skip (`no_account`), and throws what failed.
// company-data's sources are made from PROVIDER_COMPANY_DATA (company-data.ts); a later task defines
// its own with defineSource as its file loads (index.ts imports it), and adds its name to a list and
// to deploy:check's table (deploy/scripts/constants.ts; tests/deploy-table.test.ts).
import type { Source } from "@whytide/contacts";
import { AppError } from "@whytide/platform";
import { ADAPTER_NAME, type Allowance, type EmailVerdict } from "@whytide/providers";
import { errors } from "../../errors.ts";
import {
  CODE,
  COMPANY_DATA,
  COMPANY_FIELDS,
  type Field,
  INPUTS,
  type Input,
  PERSON_FIELDS,
} from "../constants.ts";
import { EMAIL_FINDER } from "../lookup/constants.ts";

export type SourceKind = "company" | "person";
export type SourceActivityKind = "provider" | "ai" | "db";
/**
 * The minimum input: a company source gets the company's keys and its country, never the person's.
 * The ids name the run's workspace and the person's company (null while it has none): for a run of
 * the workspace or an agent's call, never for a vendor.
 */
export type SourceInput = {
  readonly workspaceId: string;
  readonly companyId: string | null;
  readonly company?: {
    readonly linkedinUrl?: string;
    readonly domain?: string;
    readonly name?: string;
    readonly country?: string;
  };
  /** A person source's: the person's location text. */
  readonly person?: { readonly locationText?: string };
  /** The fields the run still wants that the source fills. */
  readonly wanted: readonly Field[];
};
/**
 * What a source may open besides its input: a run of the run's workspace, as the worker's service
 * principal, one transaction per call, for the workspace's own rows (an account to read with, a
 * quota to reserve). Never around a vendor's call. And the activity's heartbeat, when it has one.
 */
export type SourceContext = {
  readonly tenant: <T>(fn: () => Promise<T>) => Promise<T>;
  /** An `ai` source's activity heartbeat, before each page it reads (gamma-en-065); absent elsewhere. */
  readonly beat?: () => void;
};
/** The facts by field, a headcount beside the size; one the run does not want is dropped. */
export type SourceFacts = { readonly [F in Field]?: string } & { readonly employeeCount?: number };
/**
 * Nothing found: `not_found`, or the source's own word for a skip (`no_account`, `ambiguous`), a code
 * other than `found` and `failed`, which counts as the company tried only when ANSWERED lists it. Or
 * the facts, with the provider that answered (`brave`) when it is not the definition's.
 */
export type SourceAnswer =
  | { readonly found: false; readonly outcome?: string }
  | { readonly found: true; readonly facts: SourceFacts; readonly provider?: string };
export type SourceDefinition = {
  readonly name: string;
  readonly kind: SourceKind;
  readonly fills: readonly Field[];
  readonly needs: readonly Input[];
  readonly activityKind: SourceActivityKind;
  /** Its facts' provenance: the class the lead page shows (RB-7.3.2), and the provider's name. */
  readonly provenance: { readonly source: Source; readonly provider: string };
  /** Its free calls, read before each call; absent or null, no limit (domain/usage.ts). */
  readonly allowance?: () => Allowance | null;
  /**
   * Its step's start-to-close timeout in seconds; without one, a `provider` source's is 15 and a
   * `db` or `ai` source's 60 (web-search sets its own: two searches, each passed on when one fails).
   */
  readonly timeoutSeconds?: number;
  readonly run: (input: SourceInput, context: SourceContext) => Promise<SourceAnswer>;
};

/**
 * An email source's input (gamma-en-080): the lookup's first name, last name and company domain, and
 * the lookup's workspace and person ids, for the source's own runs of the workspace, never for a
 * vendor: a finder gets the three only. The lookup for a name (gamma-wr-080) has no person yet: its
 * `personId` is empty, and a source with `forName` never reads it. `room`: the candidates the lookup may still verify,
 * ENRICHMENT_EMAIL_MAX_CANDIDATES less those kept so far (gamma-en-085's `pattern` guesses so many).
 */
export type EmailSourceInput = {
  readonly workspaceId: string;
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly companyDomain: string;
  readonly room: number;
};
/** An address it proposes, with the vendor's own verdict when it checked it (a finder's). */
export type EmailCandidate = { readonly address: string; readonly vendorVerdict?: EmailVerdict };
/** Nothing, or its word for a skip (a code); or its candidates, with the provider that answered. */
export type EmailSourceAnswer =
  | { readonly found: false; readonly outcome?: string }
  | {
      readonly found: true;
      readonly candidates: readonly EmailCandidate[];
      readonly provider?: string;
    };
/**
 * An email source: it proposes candidates, which only a verifier's `valid` keeps. `anyDomain`, for
 * the lead's own addresses (gamma-en-085's `reply`, gamma-en-087's `linkedin-contact-info`): its
 * candidates may sit at any domain, and one off the company's is a personal address. The class is
 * the contact point's `source_class` (`email_finder`, `lead_reply`).
 */
export type EmailSourceDefinition = {
  readonly name: string;
  readonly kind: "email";
  readonly activityKind: SourceActivityKind;
  readonly anyDomain?: boolean;
  /**
   * It needs no person: its candidates come from the names and the company's domain alone (the
   * pattern's guesses, the finders), so the lookup for a name that is not a person yet may ask it
   * (gamma-wr-080). Absent, it is never asked for a name.
   */
  readonly forName?: true;
  readonly provenance: { readonly source: string; readonly provider: string };
  readonly allowance?: () => Allowance | null;
  /** Its step's start-to-close timeout in seconds; without one, 15 for a `provider`, else 60. */
  readonly timeoutSeconds?: number;
  readonly run: (input: EmailSourceInput, context: SourceContext) => Promise<EmailSourceAnswer>;
};
type AnySource = SourceDefinition | EmailSourceDefinition;

/** By `<kind>:<name>`: a name is unique within its kind. */
const defined = new Map<string, AnySource>();

/** Registers a source by its name, a list's word; enrichment_source_invalid naming what is off. */
export function defineSource(definition: SourceDefinition): SourceDefinition;
export function defineSource(definition: EmailSourceDefinition): EmailSourceDefinition;
export function defineSource(definition: AnySource): AnySource {
  const { name, kind, provenance } = definition;
  const off = (field: string) =>
    new AppError(errors.enrichment_source_invalid, { details: { field } });
  const reserved = kind === "email" ? EMAIL_FINDER : COMPANY_DATA;
  if (!ADAPTER_NAME.test(name) || name === reserved || defined.has(`${kind}:${name}`)) {
    throw off("name");
  }
  if (definition.kind !== "email") {
    const { fills, needs } = definition;
    const fields: readonly Field[] = kind === "person" ? PERSON_FIELDS : COMPANY_FIELDS;
    if (fills.length === 0 || !fills.every((field) => fields.includes(field))) throw off("fills");
    if (needs.length === 0 || !needs.every((input) => INPUTS.includes(input))) throw off("needs");
  } else if (!CODE.test(provenance.source)) throw off("provenance");
  if (!ADAPTER_NAME.test(provenance.provider)) throw off("provenance");
  const source = Object.freeze({ ...definition });
  defined.set(`${kind}:${name}`, source);
  return source;
}

/** The source a list names for its kind, or undefined: no source of that kind defines it. */
export function definedSource(name: string, kind: SourceKind): SourceDefinition | undefined {
  const source = defined.get(`${kind}:${name}`);
  return source?.kind === kind ? source : undefined;
}

/** The names of the sources defined of a kind, sorted: deploy:check's table follows them. */
export function definedNames(kind: SourceKind | "email"): string[] {
  return [...defined.values()]
    .filter((source) => source.kind === kind)
    .map((source) => source.name)
    .sort();
}

/** The email source ENRICHMENT_EMAIL_SOURCES names, or undefined. */
export function definedEmailSource(name: string): EmailSourceDefinition | undefined {
  const source = defined.get(`email:${name}`);
  return source?.kind === "email" ? source : undefined;
}
