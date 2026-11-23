# playbooks: concepts

- **Agent** (a playbook in the code): a member's prospecting setup, with a name, an audience and its sources. The screens say agent; the code says playbook, since `agents/` holds AI agent tasks.
- **Owner:** the member who created the agent (`owner_user_id`). Its sources read through the owner's own LinkedIn accounts; its campaign sends from them (gamma-p3-065, gamma-p6-040). Who may edit whose agent is gamma-p6-015's.
- **Audience:** one of icp's audiences (`icp_id`). A live agent has one of its own: two live agents never share an audience.
- **Sources:** up to `PLAYBOOKS_MAX_SOURCES_PER_AGENT` (10 unset; README "Settings") of signals' sources, each on one agent at a time, each read through the owner's account. The source checker signals registers says whether a source exists and whose account reads it.
- **Status:** `active` and `paused` go back and forth and count as live: `PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE` (3 unset) live agents at most in a workspace. `archived` is final: the agent keeps its row, its sources and its audience are free.
- **Pause reason:** a paused agent was paused by a member (`user`) or because its owner left the workspace (`member_removed`, gamma-p6-075); the second is resumed by its owner alone, once a member again.
