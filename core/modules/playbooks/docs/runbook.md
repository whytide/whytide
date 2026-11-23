# playbooks: runbook

No setting and no workflow. The commands log nothing of their own; a refusal is the route's answer, with its code.

- **An agent stuck at the limit** (`playbook_limit_reached`): the workspace has `PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE` live agents (`details.limit`, 3 unset), paused ones included. Archive one (`PATCH …/playbooks/{id}` `{ "status": "archived" }`); archived is final, so a mistaken archive is a new agent. Or raise the setting, with `ICP_MAX_AUDIENCES_PER_WORKSPACE` at or above it, and restart the api (README "Settings").
- **`playbook_icp_in_use`**: another live agent has the audience. Move that agent to another audience, or archive it.
- **Links refused with 503 `playbook_source_checker_missing`**: no source checker is registered in the process. Until gamma-p5-045, signals registers none, so no agent can hold a source; nothing is wrong. After it, check that signals loads in the api.
- **The start fails with `playbook_source_checker_duplicate`**: two modules register a source checker; keep signals' alone.
- **An agent paused because its owner left** (`paused_reason` `member_removed`, its status "Paused: its owner left"): its owner was removed from the workspace (gamma-p6-075), and an Owner's Resume answers `playbook_owner_removed`. Invite the owner again: once a member, they resume it from its page. Otherwise archive it, which frees its audience and its sources for another agent; moving it to another member is not built yet.
- **A removed member's agents still active:** the worker delivers `tenancy.member_removed`; look for the event's row in the outbox, delivered or dead, and for a worker that ran without playbooks' build. Delivered again, the subscriber moves what it did not.
