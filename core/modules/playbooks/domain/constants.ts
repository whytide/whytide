// The agents' fixed values (README "Decided here"), which the commands, the routes and the screens
// share, and the defaults of the limits settings.ts reads (README "Settings"), which the screens
// never use: they show the limits the api answers. No import: the screens read this file.

/**
 * The roles of playbooks.manage (permissions.ts): who writes every agent, another member's included
 * (README "Decided here"); the agent's page asks it too.
 */
export const PLAYBOOKS_MANAGE_ROLES = ["Owner", "Admin"] as const;

/**
 * PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE's default (settings.ts, README "Settings"): the agents not
 * archived in a workspace, unset the gamma roadmap's "up to 3 agents"; set, 1 or more, no maximum.
 */
export const AGENTS_PER_WORKSPACE = { default: 3 } as const;

/**
 * PLAYBOOKS_MAX_SOURCES_PER_AGENT's default (settings.ts, README "Settings"): the sources an agent
 * holds, unset beta's SIGNALS_MAX_ENABLED_SOURCES applied per agent, inside the read budget;
 * RB-4.4.1's 25 waits (not in the sources). Set, 1 or more, no maximum: the route's schema caps no
 * set, the api's body limit bounds a request.
 */
export const SOURCES_PER_AGENT = { default: 10 } as const;

/** An agent's name, trimmed, in characters. */
export const PLAYBOOK_NAME_MAX = 80;

/** The ids one `GET …/sources/check` takes at most. */
export const MAX_CHECKED_SOURCES = 50;

/** An id in a path, a body or a query: a `<prefix>_<ULID>` is far shorter. */
export const ID_MAX = 64;

/** A source's id as signals makes them: `src_` and the id's letters and digits. */
const SOURCE_ID = "src_[0-9A-Za-z]{1,60}";
export const SOURCE_ID_PATTERN = new RegExp(`^${SOURCE_ID}$`);

/** Up to MAX_CHECKED_SOURCES source ids, comma-separated, or none (`GET …/sources/check?ids=`). */
export const SOURCE_ID_LIST_PATTERN = new RegExp(
  `^(?:${SOURCE_ID}(?:,${SOURCE_ID}){0,${MAX_CHECKED_SOURCES - 1}})?$`,
);

/** active and paused go back and forth; archived is final. */
export const PLAYBOOK_STATUSES = ["active", "paused", "archived"] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

/** The statuses of an agent that counts: not archived. */
export const LIVE_STATUSES = ["active", "paused"] as const satisfies readonly PlaybookStatus[];

/**
 * Why an agent is paused, set exactly while it is (the CHECK playbooks_paused_reason): `user`, a
 * member's pause through the PATCH; `member_removed`, its owner's removal from the workspace, which
 * only that owner, a member again, resumes (gamma-p6-075).
 */
export const PAUSED_REASONS = ["user", "member_removed"] as const;
export type PausedReason = (typeof PAUSED_REASONS)[number];

/** The agents an owner's removal pauses: the active ones and those a member paused (domain/removed.ts). */
export const MOVABLE_TO_REMOVED = [
  { status: "active" },
  { status: "paused", pausedReason: "user" },
] as const;

/** An agent as its owner's removal leaves it (domain/removed.ts). */
export const PAUSED_FOR_REMOVAL = { status: "paused", pausedReason: "member_removed" } as const;

/** The prefix of the workspace's advisory lock around an agent's create, which counts them. */
export const PLAYBOOKS_LOCK = "playbooks.create";

/** Prisma's code for a write a unique index refused. */
export const UNIQUE_VIOLATION = "P2002";

/** A source's refusals, in the order a set's checks answer them (setSources). */
export const SOURCE_CODES = [
  "playbook_source_not_found",
  "playbook_source_wrong_owner",
  "playbook_source_in_use",
] as const;
export type SourceCode = (typeof SOURCE_CODES)[number];
