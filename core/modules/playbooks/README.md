# playbooks

A workspace's agents (gamma-p3-040), and their screens (gamma-p3-041). An agent is a member's: it has a name, an audience of icp's (one audience per live agent) and up to `PLAYBOOKS_MAX_SOURCES_PER_AGENT` (10 unset) of signals' sources, each read through that member's own LinkedIn account. A workspace holds up to `PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE` (3 unset) live agents, active or paused ("Settings"); archived is final and frees the agent's audience and sources. Other modules read an agent by id: campaigns (gamma-p3-065), signals (gamma-p5-045) and qualification (gamma-p5-050) import this module, never the other way round.

The module is called playbooks, the data model's other name for an agent ("agent (playbook)"): in this codebase an agent is also an AI agent task (`agents/`, architecture §11), so the code says playbook and the screens say agent ("Screens").

- **Owns:** `playbooks` and `playbook_sources` in `core/packages/db/prisma/schema/playbooks.prisma` ([docs/data.md](docs/data.md)).
- **Public interface:** `index.ts`, below.
- **Depends on:** `platform`, `db`, icp's `findAudience` and tenancy's events (its `tenancy.member_removed`, "A removed member"); the screens on `ui` and the web's api client. Never signals, campaigns or qualification.
- **Reviewers:** the owners of this module.

## Public interface

| | |
|---|---|
| `getPlaybook(playbookId)` | `{ id, name, icpId, ownerUserId, status, pausedReason, createdAt }`, or null for an agent the run's workspace does not hold |
| `listPlaybooks()` | the workspace's agents with `sourceCount`, the live ones first, oldest first |
| `sourcesOf(playbookId)` | the ids of the agent's sources, oldest link first |
| `playbookOfSource(sourceId)` | the id of the agent that holds the source, or null for a free one |
| `detachSource(sourceId)` | deletes the source's link, if any: for signals when a source is deleted (gamma-p5-045) |
| `defineSourceChecker(check)`, `type SourceCheck`, `type SourceChecker` | the source checker's registration ("The source checker") |
| `api` | the routes, mounted under `/v1/workspaces/:workspaceId/playbooks` |
| `errors`, `events`, `ids`, `permissions` | the registries the hosts load |

Every reader and command runs in the caller's tenant run, through `tenantClient`, and opens none of its own.

## Commands

In `domain/playbooks.ts`, called by the routes:
- `createPlaybook({ name, icpId, ownerUserId })`: an active agent, its creator the run's user. Under the workspace's advisory lock: an audience the workspace does not hold is `playbook_icp_not_found` (404), one a live agent has `playbook_icp_in_use` (409), one past `PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE` live agents `playbook_limit_reached` (409, `details.limit` the value configured). Publishes `playbooks.playbook_created`.
- `updatePlaybook(playbookId, { name?, icpId?, status? })`: renames, moves to another audience (checked as a create checks it) or changes the status; archiving sets `archived_at` and deletes the agent's sources. Any change of an archived agent is `playbook_archived` (409). A pause records `paused_reason` `user`; an agent paused already keeps its reason; resuming one paused `member_removed` is its owner's alone, `playbook_owner_removed` (409) for anyone else, an Owner included, before anything is written ("A removed member"). Publishes `playbooks.playbook_updated` when the name, the audience or the status changed: a patch that changes none of them writes nothing and publishes nothing.
- `setSources(playbookId, sourceIds)`: replaces the agent's set, each id checked through the source checker. More than `PLAYBOOKS_MAX_SOURCES_PER_AGENT` distinct ids is `playbook_sources_limit` (400, `details.limit` the value configured) before anything is read; the route's schema caps no set, and the api's body limit (1 MB) bounds a request. A refused id fails the whole set with its code and `details.sourceIds`, nothing written. Publishes `playbooks.sources_changed` when the set changed.
- `checkSources(playbookId, sourceIds)`: for each id once, `{ sourceId, usable, code, heldBy }`, the code `setSources` would answer and the other agent that holds it.

An agent the workspace does not hold is `playbook_not_found` (404) on every command that names one.

## The source checker

playbooks cannot read signals' table, so signals registers a checker as it loads (gamma-p5-045), as qualification's `defineSignalReader` is filled. `check(sourceIds)` runs in the caller's tenant run and answers, for each id, `{ sourceId, found, readingAccountId, readingOwnerUserId }`; an id it leaves out is not found. A source is usable when it is found, reads through an account whose owner is the agent's owner, or reads through none and its creator is the agent's owner (a Web research source, gamma-wr-030: `readingAccountId` null, `readingOwnerUserId` its creator), and no other agent holds it. Otherwise: `playbook_source_not_found`, `playbook_source_wrong_owner`, `playbook_source_in_use` (409 each), checked in that order.

With no checker registered, both sources' routes answer 503 `playbook_source_checker_missing` and nothing is written: a link is never accepted unchecked. A second registration throws `playbook_source_checker_duplicate` as the module loads, so the start fails.

## Routes

| | Permission | |
|---|---|---|
| `GET /v1/workspaces/{ws}/playbooks` | `playbooks.read` | `{ playbooks: [{ id, name, icpId, ownerUserId, status, pausedReason, createdAt, sourceCount }], limits: { agents, sources } }`, the limits as configured ("Settings") |
| `POST /v1/workspaces/{ws}/playbooks` | `playbooks.write`, idempotent | `{ name, icpId }`: 201, the caller its owner |
| `GET /v1/workspaces/{ws}/playbooks/{playbookId}` | `playbooks.read` | the agent and its `sourceIds` |
| `PATCH /v1/workspaces/{ws}/playbooks/{playbookId}` | `playbooks.write` | `{ name?, icpId?, status? }` |
| `PUT /v1/workspaces/{ws}/playbooks/{playbookId}/sources` | `playbooks.write` | `{ sourceIds }`, `limits.sources` at most |
| `GET /v1/workspaces/{ws}/playbooks/{playbookId}/sources/check?ids=` | `playbooks.read` | 50 ids at most: `{ sources: [{ sourceId, usable, code, heldBy }] }` |

`playbooks.read` and `playbooks.write` are every role's; the PATCH and the PUT of sources then ask platform's `canWriteOwned` about the agent (`lockedPlaybook`, gamma-p6-015): its owner writes it, a holder of `playbooks.manage` (Owner, Admin) writes every one, and anyone else is 403 `forbidden`, before anything is written; an agent not found is 404 first. The requests are in `api-calls/gamma-p3-040-playbooks.http`; the routes' test is `core/apps/api/tests/playbooks-api.test.ts`.

## Screens

In `ui/`, registered in `ui/nav.ts`, every string a key under `playbooks.nav`, `playbooks.list`, `playbooks.agent` or `playbooks.sources`. They read and write only through the routes above, icp's `GET …/icp/audiences`, signals' `GET …/signals/sources` and tenancy's `GET …/tenancy/members`, through the web's api client, as the visitor.
- **Agents**, `/w/{ws}/agents`, in the ICP group after the ICP screen: the agents with their audience, owner, status and source count, each row opening the agent's page. "New agent" opens the kit's `Dialog`: a name and, in the kit's `Select`, an audience no live agent has, with the way to the ICP screen to make another; Create posts with an Idempotency-Key, the same one for the same body after a failure, and opens the new agent's page. With the list's `limits.agents` live agents the button is off and the limit is said beside it.
- **The agent's page**, `/w/{ws}/agents/{playbookId}`: the name, the status and the audience; Pause or Resume; Archive, after the kit's confirming `Dialog`; the name and the audience, saved together, the audience one no other live agent has. Its sources load in the browser: signals' sources, then the check, 50 ids a call. Each usable one is a kit `Checkbox`, the list's `limits.sources` at most checked; one another agent holds shows off, with that agent's name; one read through another member's account, or not found, is left out. With no checker (503) the card says sources cannot be linked yet; with nothing to offer, it leads to the Sources screen. An archived agent says it no longer changes, with no button, form or picker; an agent the workspace does not hold is the page's not-found state.
- **An agent paused because its owner left** (`pausedReason` `member_removed`): its status reads `playbooks.agent.status.paused_owner_removed` on both screens, and its page says why with `playbooks.errors.playbook_owner_removed`, with no Resume for anyone but its owner; an Owner may still rename or archive it.
- **Another member's agent**, for a visitor without `playbooks.manage`: the page, which reads `GET /v1/me`, shows the hint `playbooks.agent.not_owner`, the name, the audience and the sources disabled, and no Pause, Resume, Archive or Save; the routes refuse them anyway.
- **The `campaign` slot** (`ui/agent/slots.ts`), under the agent: another module's panel, rendered with `PanelProps`, `{ workspace, playbookId }`, behind an error boundary and in a `Suspense` of its own (`ui/agent/slot-boundary.tsx`; campaigns' agent campaign, gamma-p3-065). A panel that throws leaves the agent and the other slots up: its place says it could not load (`playbooks.agent.slot_failed`), with the code in words and Try again.
- **The `companies` slot** (`ui/agent/slots.ts`; gamma-wr-111), after `campaign`: signals' panel of the agent's newest fitting companies, with a link to its Companies found screen with the agent chosen. Like the `campaign` slot, it is another module's panel behind the same boundary; playbooks imports none of signals' screens.

## Testing

`@whytide/playbooks/testing`, in test files only: `createPlaybook(input, client?)` writes an agent and its sources straight to the tables (a paused one with `pausedReason`, `user` unless given), `usePlaybooksClient(client)` sets the client it writes on, `useSourceChecker(check)` puts a fake checker in place (undefined for none) and returns the function that takes it out, and `pauseRemovedMember(userId)` is the removal subscriber's body, for the web's e2e api, which runs no worker. The module's tests (`tests/`) call the commands on the worktree's database; the routes' are the api host's; the screens' is the web's, `core/apps/web/tests/playbooks-agents.spec.ts`, on the e2e api, where signals registers its own source checker as it loads (gamma-p5-045).

## Decided here

- The import direction: playbooks imports icp, and tenancy for its events (gamma-p6-075). Campaigns creates the agent's campaign on `playbooks.playbook_created` (gamma-p3-065): creating it here would close an import cycle.
- The owner is the member who created the agent, `owner_user_id`; the route takes it from the session, never from the body.
- The source checker is a registry; without one every link is refused (503), and the check answers each source's reading account so that an agent links only sources read through its owner's own account.
- One live agent per audience: the partial unique `playbooks_live_icp` holds it under any race; an archived agent's audience is free.
- Fixed values in `domain/constants.ts`: 80 characters of name, 50 ids per check; the agents' and the sources' limits are settings ("Settings").
- `heldBy` in the check's answer: the screen names the agent that holds a source.
- A second registration of the checker is its own code, `playbook_source_checker_duplicate` (500).
- `setSources` past `PLAYBOOKS_MAX_SOURCES_PER_AGENT` ids is its own code, `playbook_sources_limit` (400), counted after a repeated id is dropped; the route's schema caps no set (gamma-p3-041, limits-env, limits-no-max).
- A patch that changes nothing writes nothing, `updated_at` included, and publishes nothing.
- The screens name an agent's owner from tenancy's members route, which every role may read: a display name, else an email; one no longer a member is a former member.
- The source picker loads in the browser after the page, so that its reads never hold the page and the check's 503 shows in the card alone.
- New agent and the agent's page offer only the audiences no other live agent has; a race is still `playbook_icp_in_use`, said in words.
- The nav icon is Lucide's `Bot`.
- The `campaign` slot's error boundary (gamma-p3-065) is a React class, as playbooks has no `next` dependency: Try again renders the slot anew in the browser, where a panel reads again; a panel here calls neither `notFound()` nor `redirect()`, which it would hold as a failure.
- A Member writes the agents they created, an Owner every one (gamma-p6-015): the check sits in `lockedPlaybook`, the one gate of the PATCH and the PUT of sources, after the row is found and locked, so a lock is all a refused write takes, rolled back. The create is not checked, the caller is the owner; nor is the audience the agent takes (another member's audience may be chosen, as the task leaves it), nor a source's owner (the link checks the agent's owner only: playbooks cannot read signals). The hint is `playbooks.agent.not_owner`: the task's camelCase name fails the key check. The page compares the agent's `ownerUserId` and the member's role with `PLAYBOOKS_MANAGE_ROLES`, which `permissions.ts` declares `playbooks.manage` from; the api decides.

- The pause has a reason, `paused_reason` (gamma-p6-075): `user` for a member's pause, `member_removed` for the owner's removal, set exactly while paused (the CHECK `playbooks_paused_reason`), so that no Owner restarts an agent whose campaign would send from a departed member's accounts. A pause of an agent paused already keeps its reason: else an Owner's pause, then resume, would lift the removal's. Archiving one paused `member_removed` is an Owner's to do: it stops the agent for good and frees its audience.
- The task's key `playbooks.status.pausedOwnerRemoved` is `playbooks.agent.status.paused_owner_removed`, beside the other statuses: the camelCase name fails the key check. The page's hint reuses the refusal's key, `playbooks.errors.playbook_owner_removed`.
- The limits are settings (limits-env, the owner's request of 2026-11-15: "Agents per workspace can be increased, 3 may not be enough"), each defaulting to the old constant, which is gone, so that the setting is the one source of truth. They have no upper bound (limits-no-max, the owner, 2026-11-15: "Limits set in .env should not have hard upper limit"): each is an integer of 1 or more, and how high to go is the self-hoster's call. More sources read more through one member's account, inside signals' read budget and `SIGNALS_MAX_ENABLED_SOURCES`; the source picker checks a set of any size in calls of `MAX_CHECKED_SOURCES` (50) ids. Only the number's own range stops a value: above 9007199254740991 (the largest safe integer) is `config_invalid`.
- The screens read the limits from `GET …/playbooks`'s `limits`, which both pages read already; never a `NEXT_PUBLIC_` variable or a value of the build, so a restarted api shows its new limits without a new web build.
- The OpenAPI document and the generated client never depend on the environment: the PUT's schema caps no set, the domain checks the value configured with its own code, and a summary names the default only (the api host's `playbooks-api.test.ts` builds the document with the limits unset, set small and set large).
- The `modules/playbooks` block sits after icp's and before signals' in `deploy/.env.example`, the order the modules import each other in, so that the related limits sit together.

## Deferred

- A linked source that is no longer usable (its account changed hands, say) shows unchecked on the agent's page and leaves with the next save, without a word.

## A removed member

gamma-p6-075, the LinkedIn part. `events.ts` subscribes to tenancy's `tenancy.member_removed`; in the delivery's tenant run of the event's workspace and its transaction, `domain/removed.ts` turns each of the user's agents there that is not archived `paused` with `paused_reason` `member_removed`, and publishes `playbooks.playbook_updated { playbookId, status }` once per agent it changed. An agent its owner paused takes the new reason; one paused for the removal already and an archived one stay as they are, so a redelivery writes and publishes nothing. Each move is an update conditioned on the row as its lock finds it, so an agent archived meanwhile stays archived.

Only the agent's owner resumes it, through the PATCH, once a member again (invited again, tenancy's `addMember`); a removed member reaches no route of the workspace. Anyone else, an Owner included, is `playbook_owner_removed` (409) and nothing changes. A paused agent's sources read nothing, whatever the reason: signals writes them no run, ends a run of them at its start with no read, refuses Run now and, on `playbooks.playbook_updated`, stops their open runs (signals README "Runs", "A paused agent"; paused-agent-sources); the member's LinkedIn account is paused as well (linkedin, gamma-p6-070), and their enrollments end (campaigns, gamma-p6-040). Moving the agents to another member is later.

## Settings

`PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE` (3, the agents not archived in one workspace) and `PLAYBOOKS_MAX_SOURCES_PER_AGENT` (10, the sources one agent holds), each an integer of 1 or more with no maximum (the defaults are `AGENTS_PER_WORKSPACE` and `SOURCES_PER_AGENT` in `domain/constants.ts`), `settings.ts`: the `modules/playbooks` block of `deploy/.env.example` (limits-env). Unset or empty, the default applies. A value that is not an integer of 1 or more (0, a negative, a decimal, a word) stops the api's start with `config_invalid` naming it, and the worker's, which loads the module through signals, campaigns and qualification. They are read once, as the module loads: **a changed value needs an api restart**. `createPlaybook` and `setSources` refuse past them with `details.limit` the value configured, and `GET …/playbooks` answers them as `limits: { agents, sources }`, which the screens show.

Keep two relations:
- An agent needs an audience of its own (one live agent per audience), so keep icp's `ICP_MAX_AUDIENCES_PER_WORKSPACE` at or above `PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE`, else the audiences run out before the agents.
- signals' `SIGNALS_MAX_ENABLED_SOURCES` sets how many of an agent's sources are enabled, and so run, at once: keep it at or above `PLAYBOOKS_MAX_SOURCES_PER_AGENT` if they should all run.

The tests: `tests/limits.test.ts` sets 4 agents and 2 sources, and tries 1000 and values that are not integers of 1 or more in processes of their own; `tests/playbooks.test.ts` runs the defaults; the api host's `playbooks-api.test.ts` reads the list's `limits`, sends 51 ids to the PUT of sources for `playbook_sources_limit`, and builds the document with the settings unset, small and large.
