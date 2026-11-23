// The id prefixes of playbooks' two tables (core/packages/platform/README.md "Ids"): an agent, `pbk_`,
// and a source it holds, `pbs_`. Not the data model's `agt_`: architecture §11's agents, the AI users
// with API keys, would collide (README "The name").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({ pbk: "playbook", pbs: "playbook_source" });
