// The source-kind contract (README.md "Adding a kind"; architecture §14.1): a kind is a folder,
// sources/<kind>/index.ts, that calls defineSourceKind with its config schema, its schedule, its
// reader and its evidence. The registry is a module-level map filled as those files load, from the
// generated list of sources/registry.ts: no central enum or switch of kinds exists (coding §3). A
// reader is a provider activity the run calls by name a page at a time, since only the provider's
// module opens its account (linkedin's workflows/), and the kind's reading of each page it wrote; the
// event and the evidence are what a candidate kept by the processing leaves (alpha-p8-030).
import { AppError } from "@whytide/platform";
import type { z } from "zod";
import { errors } from "../errors.ts";

/**
 * Someone a reader found and what they did: business fields only (docs/rules/security.md §1). A run
 * stages each field but `objectUrl`, its source's. A rejected one leaves a salted hash of
 * `providerMemberRef` only.
 */
export type Candidate = {
  /** The provider's id of the person, never one of our ids (docs/rules/coding.md §5). */
  readonly providerMemberRef: string;
  readonly profileUrl: string;
  readonly name: string;
  readonly headline: string;
  /** What they did, in the kind's words: `like`, `comment` or `repost` for post engagers. */
  readonly reaction: string;
  readonly commentText?: string;
  readonly engagedAt: Date;
  /** What they engaged with: the post, for post engagers. */
  readonly objectUrl: string;
};

/** What a lead's page shows of a candidate's signal (data model "Evidence"), in table `evidence`. */
export type Evidence = {
  readonly url: string;
  readonly reaction: string;
  readonly commentText?: string;
  readonly author: string;
};

/** One page as the kind reads it (alpha-p8-020). */
export type PageCandidates = {
  /** Those who engaged at the cut or after it, newest first. */
  readonly candidates: readonly Candidate[];
  /** The page holds one before the cut: the pages after it are older still. */
  readonly reachedCut: boolean;
};

/** How a run reads a source of the kind, a page at a time (alpha-p8-020; README.md "Runs"). */
export type KindReader<Config> = {
  /**
   * The provider activity the run calls for each page, by name: it takes `{ workspaceId, accountId,
   * cursor?, limit, rawKey }` and the input below, writes the page to `rawKey` and answers linkedin's
   * EngagersPage or EngagersRefused.
   */
  readonly activity: string;
  /** The rest of its input, from the source's config. */
  input(config: Config): Readonly<Record<string, string>>;
  /** The engagers a page asks for. */
  readonly pageSize: number;
  /** A page file the activity wrote, read: the candidates at `cut` or after it. */
  page(file: unknown, config: Config, cut: Date): PageCandidates;
};

/** The event a kept candidate makes (table `signal_events`). */
export type KindEvent<Config> = {
  /** snake_case, stored in signal_events.kind: `post_engagement` for post engagers. */
  readonly kind: string;
  /** What the candidates engaged with, from the source's config: the post's URL. */
  objectOf(config: Config): string;
};

export type SourceKindDefinition<Config> = {
  /** snake_case; stored in signal_sources.kind, so never renamed once a source has it. */
  readonly kind: string;
  /**
   * The config of a source of the kind: a create is parsed with it, with safeParseAsync and outside
   * any run, so a transform may call out (post_engagers resolves a short link), and the result
   * stored. The result parses to itself with no call: the create parses it again in its run.
   */
  readonly configSchema: z.ZodType<Config>;
  /** The message key of the kind's name on the screens (alpha-p8-040). */
  readonly labelKey: string;
  /** How far back a run reads, in days. */
  readonly lookbackDays: number;
  /** The instants a source saved at `savedAt` runs at. */
  schedule(config: Config, savedAt: Date): Date[];
  readonly reader: KindReader<Config>;
  readonly event: KindEvent<Config>;
  evidenceOf(candidate: Candidate): Evidence;
};

/** A registered kind: its definition and the file that declared it. */
export type SourceKind = SourceKindDefinition<unknown> & { readonly source: string };

const KIND = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const kinds = new Map<string, SourceKind>();

/**
 * Registers a kind; `source` is the declaring file's `import.meta.url`. A name off snake_case is
 * signal_kind_invalid; a name declared twice is signal_kind_duplicate, naming both files, and the
 * first stands. Both fail at start: the host imports the module, which imports every kind.
 */
export function defineSourceKind<Config>(
  definition: SourceKindDefinition<Config>,
  source: string,
): SourceKindDefinition<Config> {
  const { kind } = definition;
  if (!KIND.test(kind)) {
    throw new AppError(errors.signal_kind_invalid, { details: { kind, source } });
  }
  const registered = kinds.get(kind);
  if (registered !== undefined) {
    const details = { kind, sources: [registered.source, source] };
    throw new AppError(errors.signal_kind_duplicate, { details });
  }
  kinds.set(kind, Object.freeze({ ...(definition as SourceKindDefinition<unknown>), source }));
  return definition;
}

/** Every registered kind by its name. */
export const registeredSourceKinds = (): ReadonlyMap<string, SourceKind> => kinds;
