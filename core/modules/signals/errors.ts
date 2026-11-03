// signals' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** A write names a kind the registry does not hold (sources/<kind>/). 400. */
  signal_kind_unknown: { status: 400 },
  /** The config is off its kind's schema; `details.fields` names the paths, `config.postUrl`. 400. */
  signal_config_invalid: {},
  /** A post's short link could not be opened: its request failed or was refused. 502. */
  signal_post_link_unreachable: { status: 502 },
  /** SIGNALS_MAX_ENABLED_SOURCES are enabled already; `details.limit` is that number. 400. */
  signal_sources_limit: { status: 400 },
  /** No source with the id in this workspace. 404. */
  signal_source_not_found: {},
  /** Run now while one of the source's runs is `running` or `waiting`. 409. */
  signal_run_open: { status: 409 },
  /** A stop of a run that has ended: `done`, `failed` or `cancelled`. 409. */
  signal_run_not_open: { status: 409 },
  /** The sender account is not one of the workspace's; `details.fields` is `["senderAccountId"]`. 400. */
  signal_sender_account_invalid: { status: 400 },
  /** A run's end: the post is gone, or the sender account cannot see it. */
  signal_post_not_found: {},
  /** At start: two folders declare one kind; `details.sources` names both files. 500. */
  signal_kind_duplicate: {},
  /** At start: a kind's name is not snake_case; `details.source` names its file. 500. */
  signal_kind_invalid: { status: 500 },
});
