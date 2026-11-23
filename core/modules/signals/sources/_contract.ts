// The source-kind contract (README.md "Adding a kind"; architecture §14.1): a kind is a folder,
// sources/<kind>/index.ts, that calls defineSourceKind with its config schema, its schedule, its
// reader and its evidence. The registry is a module-level map filled as those files load, from the
// generated list of sources/registry.ts: no central enum or switch of kinds exists (coding §3). A
// reader is a provider activity the run calls by name a page at a time, since only the provider's
// module opens its account (linkedin's workflows/), and the kind's reading of each page it wrote; or
// a posts reader, whose run reads the source's posts, then each post's engagers (gamma-p5-020). The
// event and the evidence are what a candidate kept by the processing leaves (alpha-p8-030). A daily
// kind's sources also run once a day, inside the read budget (gamma-p5-040). A kind that reads no
// LinkedIn account and whose run is the research workflow has a research reader (gamma-wr-030): its
// sources have no sender account, may be edited, and run every SIGNALS_RESEARCH_EVERY_DAYS days.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";

/**
 * The longest lookback of any kind, in days (README.md "Settings"): the 30-day rule deletes an EU or
 * UK person never contacted 30 days after they were found, and a source that read further back would
 * find them again (gamma-p7-010).
 */
export const LOOKBACK_DAYS_MAX = 30;
/** A kind's lookback setting, in its config.ts: whole days, at most LOOKBACK_DAYS_MAX. */
export const lookbackSetting = (days: number) =>
  z.coerce.number().int().positive().max(LOOKBACK_DAYS_MAX).default(days);

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
  /** What they did, in the kind's words: `like`, `comment` or `repost`; `author` for a post's author. */
  readonly reaction: string;
  /** Their own words: a comment, or an author's own post. */
  readonly commentText?: string;
  readonly engagedAt: Date;
  /** False when `engagedAt` is the listing's time, not theirs; absent in a page before gamma-p5-010. */
  readonly dateKnown?: boolean;
  /** What they engaged with: the post, a posts kind's in its unnamed form. */
  readonly objectUrl: string;
  /** The excerpt of the post a commenter or reactor engaged with, for a posts kind. */
  readonly postExcerpt?: string;
};

/** What a lead's page shows of a candidate's signal (data model "Evidence"), in table `evidence`. */
export type Evidence = {
  readonly url: string;
  readonly reaction: string;
  /** A comment, stored as one; the excerpt is the person's own words, this or `ownWords`. */
  readonly commentText?: string;
  /** Own words that are no comment, an author's own post: the excerpt only. */
  readonly ownWords?: string;
  /** The excerpt of the post they engaged with, someone else's words (RB-4.4.3). */
  readonly postExcerpt?: string;
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

/** Whose posts a posts reader reads: linkedin's postsRequestFile `source`. */
export type PostsSource =
  | { readonly by: "phrase"; readonly phrase: string }
  | { readonly by: "author"; readonly authorUrl: string }
  | { readonly by: "own" };

/**
 * How a run reads a source of a posts kind (gamma-p5-020; README.md "Runs"): the source's posts with
 * linkedin_read_posts, a page at a time, then each post's engagers with linkedin_read_post_engagers.
 */
export type PostsReader<Config> = {
  /** The source of linkedin_read_posts's request file, which no workflow history holds. */
  source(config: Config): PostsSource;
  /** Each post's author, a member, is a candidate (`author`). */
  keepsAuthors(config: Config): boolean;
  /** The engagers' reactions kept; none, and the run reads no engagers. */
  keepsReactions(config: Config): readonly string[];
  /** The posts a page asks for. */
  readonly pageSize: number;
};

/**
 * How a run reads a source of a research kind (gamma-wr-030; README.md "Runs"): no page is read
 * through a LinkedIn account, and the run is the workflow `signals_research_run`, not `signals_run`.
 */
export type ResearchReader = {
  readonly research: true;
};

/** The event a kept candidate makes (table `signal_events`). */
export type KindEvent<Config> = {
  /** snake_case, stored in signal_events.kind: `post_engagement` for post engagers. */
  readonly kind: string;
  /**
   * What the candidates engaged with, from the source's config: post engagers' post, which a row
   * staged before gamma-p5-020 takes. A posts kind's candidates each name their own post.
   */
  objectOf?(config: Config): string;
};

/** A data row of a sources CSV (domain/import/csv.ts): its cells by column, trimmed, "" when absent. */
export type ImportCells = {
  readonly url: string;
  readonly name: string;
  readonly phrase: string;
  readonly roles: string;
};

/**
 * How a row of a sources CSV makes a source of the kind (README.md "Importing sources";
 * sources-csv-import). A kind without it is not importable.
 */
export type KindCsv<Config> = {
  /** The `kind` cell's words for the kind besides its own name, in lower case: `post`. */
  readonly names: readonly string[];
  /** The config the row's cells give, which the kind's schema then reads as a create's. */
  config(cells: ImportCells): Record<string, unknown>;
  /** The column each path of a refusal's `details.fields` comes from: `config.postUrl`, `url`. */
  readonly columns: Readonly<Record<string, keyof ImportCells>>;
  /** The label of a row without one, from the config as stored. */
  label(config: Config): string;
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
  /** When a source saved at `savedAt` runs no more, for a kind whose runs end: Run now refuses after. */
  endsAt?(savedAt: Date): Date;
  /**
   * `daily`: an enabled source of the kind also runs once a quota day through its account, inside its
   * working hours and its share of the day's reads (README.md "Runs"; gamma-p5-040). None: its fire
   * times alone.
   */
  readonly cadence?: "daily" | "research";
  readonly reader: KindReader<Config> | PostsReader<Config> | ResearchReader;
  /**
   * Whether the source reads through a LinkedIn sender account; true when absent. A kind with false
   * takes none at its create, and its source's `sender_account_id` is null (gamma-wr-030).
   */
  readonly readsThroughAccount?: false;
  /**
   * Whether `PATCH /sources/{id}` takes a new config, which the kind's schema reads: true for a kind
   * whose fields steer its agent. A LinkedIn kind's target stays fixed, and it is absent (gamma-wr-030).
   */
  readonly configEditable?: true;
  readonly event: KindEvent<Config>;
  evidenceOf(candidate: Candidate): Evidence;
  /**
   * The config without the URL that names an erased person, `slug` their public id decoded and in
   * lower case; null when it names nobody. The erasure disables the source (README.md "Reduction").
   */
  scrub?(config: Config, slug: string): Config | null;
  /** How a row of a sources CSV gives a source of the kind; none, and no row can (sources-csv-import). */
  readonly csv?: KindCsv<Config>;
};

/** A reader that reads a page of a post's engagers, by a provider activity. */
export const isKindReader = <Config>(
  reader: KindReader<Config> | PostsReader<Config> | ResearchReader,
): reader is KindReader<Config> => "activity" in reader;

/** The reader reads posts first. */
export const isPostsReader = <Config>(
  reader: KindReader<Config> | PostsReader<Config> | ResearchReader,
): reader is PostsReader<Config> => "source" in reader;

/** The run is the research workflow's (gamma-wr-030). */
export const isResearchReader = <Config>(
  reader: KindReader<Config> | PostsReader<Config> | ResearchReader,
): reader is ResearchReader => "research" in reader;

/** The kind's sources read through a LinkedIn sender account. */
export const readsThroughAccount = (kind: { readonly readsThroughAccount?: false }): boolean =>
  kind.readsThroughAccount !== false;

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
