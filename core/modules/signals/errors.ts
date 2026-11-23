// signals' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** A write names a kind the registry does not hold (sources/<kind>/). 400. */
  signal_kind_unknown: { status: 400 },
  /** The config is off its kind's schema; `details.fields` names the paths, `config.postUrl`. 400. */
  signal_config_invalid: {},
  /** A topic's phrase names a special-category theme; `details.fields` is `["config.phrase"]`. 400. */
  signal_topic_blocked: { status: 400 },
  /** Run now on a post engagers source saved longer ago than its lookback. 409. */
  signal_source_expired: { status: 409 },
  /** A post's short link could not be opened: its request failed or was refused. 502. */
  signal_post_link_unreachable: { status: 502 },
  /**
   * SIGNALS_MAX_ENABLED_SOURCES of the source's group, its agent's or those in no agent, are
   * enabled already; `details.limit` is that number. 400.
   */
  signal_sources_limit: { status: 400 },
  /**
   * SIGNALS_MAX_TRACKED_PER_ACCOUNT competitor and creator sources of the sender account are enabled
   * already; `details.limit` is that number. 400.
   */
  signal_tracked_limit: { status: 400 },
  /** No source with the id in this workspace. 404. */
  signal_source_not_found: {},
  /** No found company with the id in this workspace (gamma-wr-110). 404. */
  signal_found_company_not_found: {},
  /** Run now while one of the source's runs is `running` or `waiting`. 409. */
  signal_run_open: { status: 409 },
  /**
   * Run now on a source whose agent is paused, by a member or for its owner's removal: its sources
   * read nothing until the agent is resumed (paused-agent-sources). 409.
   */
  signal_agent_paused: { status: 409 },
  /** A stop of a run that has ended: `done`, `failed` or `cancelled`. 409. */
  signal_run_not_open: { status: 409 },
  /** The sender account is not one of the workspace's; `details.fields` is `["senderAccountId"]`. 400. */
  signal_sender_account_invalid: { status: 400 },
  /** A run's end: the post is gone, or the sender account cannot see it. */
  signal_post_not_found: {},
  /**
   * A run's end (gamma-wr-030): the research run's audience, its agent's or the workspace's default,
   * names no country, so there is nowhere to look.
   */
  research_no_country: {},
  /** At start: two folders declare one kind; `details.sources` names both files. 500. */
  signal_kind_duplicate: {},
  /** At start: a kind's name is not snake_case; `details.source` names its file. 500. */
  signal_kind_invalid: { status: 500 },
  /** At start: a source type's definition is off its form; `details` names its id, file and reason. 500. */
  signal_place_invalid: { status: 500 },
  /** At start: two files declare one source type; `details.sources` names both files. 500. */
  signal_place_duplicate: { status: 500 },
  /**
   * A run's end (gamma-wr-040): the research plan's call failed twice (its schema or its gate) or
   * went over its budget, so the run has nothing to ask.
   */
  research_plan_failed: {},
  /**
   * A research run's end (gamma-wr-041): no web search adapter is loaded, so the source can find
   * nothing; the runs panel says so in words.
   */
  research_search_unavailable: {},
  /**
   * The host loaded no agent task signals.research-plan (loadAgentTasks): never retried, the run
   * ends `failed`. 500.
   */
  signal_research_agent_not_loaded: { status: 500 },
  /**
   * The host loaded no agent task signals.research-pick-results (loadAgentTasks): never retried, the
   * run goes on and reads the start pages alone. 500.
   */
  signal_research_pick_agent_not_loaded: { status: 500 },
  /**
   * The host loaded no agent task signals.research-read-page (loadAgentTasks): never retried, the run
   * ends `failed`. 500.
   */
  signal_research_read_agent_not_loaded: { status: 500 },
  /**
   * The host loaded no agent task signals.research-judge-company (loadAgentTasks): never retried, the
   * run ends `failed`. 500.
   */
  signal_research_judge_agent_not_loaded: { status: 500 },
  /**
   * The host loaded no agent task signals.research-read-people or signals.research-pick-people
   * (loadAgentTasks): never retried, the run ends `failed`. 500.
   */
  signal_research_people_agent_not_loaded: { status: 500 },
  /** The host loaded no agent task signals.rate-engagement (loadAgentTasks). 500. */
  signal_rating_agent_not_loaded: { status: 500 },
  /**
   * The host loaded no agent task signals.triage-engagers (loadAgentTasks): never retried, the run
   * decides the batch by the rules. 500.
   */
  signal_triage_agent_not_loaded: { status: 500 },
  /**
   * A sources CSV (sources-csv-import): a name not *.csv, content that is not text (a ZIP signature,
   * a NUL byte) or not CSV. 400.
   */
  signal_import_unsupported_type: { status: 400 },
  /** A sources CSV over SOURCE_IMPORT_MAX_BYTES. 413. */
  signal_import_too_large: { status: 413 },
  /** A sources CSV with more than SOURCE_IMPORT_MAX_ROWS data rows. 400. */
  signal_import_too_many_rows: { status: 400 },
  /** A sources CSV without a header row naming a `kind` column. 400. */
  signal_import_missing_column: { status: 400 },
  /** A sources CSV that is not UTF-8. 400. */
  signal_import_bad_encoding: { status: 400 },
});
