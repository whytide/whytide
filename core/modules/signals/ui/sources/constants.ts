// The sources screen's constants (README.md "Screen"): the status of a sender account a run reads
// through, where an open run's line links, its id, by which Run now names it, how often the list is
// read again while a run reads or one Run now asked for has not started, the cards the loading
// state shows, and the kinds the form adds with their fields and a topic's roles; where View leads,
// the Import screen and an agent's page are, and the statuses of the imports the Imported files show.

/** The status, in linkedin's accounts, of a sender account a run can read through. */
export const CONNECTED = "connected";

/** The workspace's LinkedIn screen, where a sender account is connected again. */
export const linkedinScreen = (workspaceId: string): string => `/w/${workspaceId}/linkedin`;

/** The lead list of one source, a LinkedIn source's or an import's: its View leads. */
export const leadsOf = (workspaceId: string, ref: string): string =>
  `/w/${workspaceId}/leads?source=${encodeURIComponent(ref)}`;

/** discovery's Import screen, where a CSV file is imported. */
export const importScreen = (workspaceId: string): string => `/w/${workspaceId}/import`;

/** playbooks' page of the agent that holds a source, where its sources are linked (gamma-p5-045). */
export const agentScreen = (workspaceId: string, playbookId: string): string =>
  `/w/${workspaceId}/agents/${playbookId}`;

/** The statuses of an import that ran, the ones Imported files shows; not validated or invalid. */
export const RAN = ["done", "running", "failed"] as const;
export type Ran = (typeof RAN)[number];

/** The id of a source's open-run line, in its card, while a run of the source is open. */
export const runStateId = (sourceId: string): string => `signals-run-state-${sourceId}`;

/** How often the list is read again while a run reads, or until a run Run now asked for starts. */
export const SOURCES_POLL_MS = 15_000;

/** The loading state's skeletons: the add form's lines, the source cards and theirs, the runs' rows. */
export const SKELETON = { formLines: 2, cards: 2, cardLines: 4, runRows: 3 } as const;

/** The kinds the add form adds, in its select's order (README.md "Screen"), the first chosen. */
export const KINDS = [
  "post_engagers",
  "topic_engagement",
  "competitor_engagement",
  "creator_engagement",
  "my_post_engagement",
  "web_research",
] as const;
export type Kind = (typeof KINDS)[number];

/** The kinds that read through no LinkedIn account (gamma-wr-030): no account field, none needed. */
export const ACCOUNTLESS: readonly Kind[] = ["web_research"];

/**
 * The fields of each kind's config the form shows, by their paths in a refusal's `details.fields`,
 * under which the refusal shows (gamma-p5-025).
 */
export const FIELDS: Readonly<Record<Kind, readonly string[]>> = {
  post_engagers: ["config.postUrl"],
  topic_engagement: ["config.phrase"],
  competitor_engagement: ["config.companyUrl", "config.companyName"],
  creator_engagement: ["config.profileUrl"],
  my_post_engagement: [],
  web_research: ["config.focus", "config.region", "config.languages", "config.startPages"],
};

/** The longest start pages box, in characters: five addresses of a usual length and more. */
export const START_PAGES_BOX_CHARS = 2000;

/** The roles a topic keeps, all three at first (sources/topic_engagement). */
export const ROLES = ["author", "commenter", "reactor"] as const;
