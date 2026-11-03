# Whytide

Whytide finds high-intent B2B leads on LinkedIn from buying signals, qualifies them with AI against your ideal customer profile, shows the evidence behind every lead, and sends outreach only after a person approves it. This repository holds the code of Whytide Core, the source-available, self-hosted edition, and of Whytide Cloud, the hosted service that runs the same code.

**Status:** this is the code at the end of beta, version 0.2.1, published to read. It is not a supported release yet.

## What it does

1. **Company Knowledge.** Paste your website: the AI drafts what you sell, to whom and why, and you edit it.
2. **Ideal customer profile.** Titles, seniorities, industries, company sizes and countries, plus must-haves and disqualifiers in plain text.
3. **Signals.** Point it at LinkedIn posts (yours, a competitor's, a creator's) and it reads the people who reacted or commented, through your own connected LinkedIn account. Or import a CSV of LinkedIn profiles.
4. **Qualification.** Hard filters in code first, then an AI verdict on each criterion with its evidence, then a fit score computed in code and a tier.
5. **Review.** The leads sorted by score, each with the post and what the person did on it. You mark each one Good lead or Not a fit.
6. **Outreach on LinkedIn.** Approving a lead starts one fixed sequence from your own account: a connection request, a first message once it is accepted, then two follow-ups. The AI drafts each message from the facts Whytide holds, and every message waits in "Up next" until you approve, edit or skip it.
7. **Safety.** Daily quotas inside your working hours, under hard maximums that no setting raises. Any reply stops the sequence. A never-contact list, opt-outs, and kill switches per account, per workspace and for the whole platform.
8. **Inbox.** The replies in the threads Whytide started.

## AI agents

### Inside the product

Several AI agents work inside Whytide, each on one job. They run through Mastra inside Temporal activities, see only the facts they are given (qualification gets anonymized profiles), and return structured output that code checks before anything is saved; nothing reaches a prospect until a person approves it.

```mermaid
flowchart LR
  subgraph SETUP["Setup"]
    SITE["your website"] --> KNOW["agent: draft Company Knowledge<br/>you edit it"]
    KNOW --> ICPD["agent: draft the ICP<br/>you edit it"]
  end
  subgraph EACHLEAD["Each lead"]
    FILTERS["hard filters and anonymizer<br/>in code"] --> ASSESS["agent: assess the fit<br/>a verdict per criterion"]
    ASSESS --> SCORE["fit score and tier<br/>in code"]
  end
  subgraph EACHMSG["Each message"]
    DOSSIER["dossier: facts with their sources<br/>in code"] --> PLAN["agent: plan the message"]
    PLAN --> WRITE["agent: write the message"]
    WRITE --> CHECKS["checks in code<br/>grounding, length, placeholders"]
  end
  ICPD --> FILTERS
  SCORE -->|"you approve the lead"| DOSSIER
  CHECKS -->|"Up next: you approve, edit or skip"| SENT["sent on LinkedIn"]
```

### Building it

AI coding agents also build Whytide, in parallel, under the same rules as people ([AGENTS.md](AGENTS.md), [docs/rules/](docs/README.md)): each takes one task in its own git worktree, with its own slice of the development stack, and its work lands only through a reviewed merge request.

```mermaid
flowchart LR
  TASKS["tasks, each with<br/>its dependencies"] --> AGENTS["AI coding agents<br/>one per task, in parallel"]
  AGENTS --> WORKTREE["its own git worktree<br/>and branch"]
  AGENTS --> SLICE["its own slice of the dev stack<br/>database, Temporal namespace,<br/>Redis prefix, bucket, ports"]
  WORKTREE --> CHECKS["checks: types, lint, tests,<br/>docs, secrets"]
  SLICE --> CHECKS
  CHECKS --> MR["merge request, reviewed"]
  MR --> MAIN["main"]
```

## Architecture

The diagrams come from [docs/architecture.md](docs/architecture.md), the full design; some of what they show arrives in later versions.

**Stack:** TypeScript on Node 26 with pnpm workspaces, Next.js with Tailwind CSS 4, NestJS, Prisma, Temporal, Mastra, PostgreSQL with pgvector, Redis, MinIO, Caddy, OpenTelemetry, Biome and Docker Compose.

### [System context](docs/architecture.md#2-system-context)

Who and what Whytide talks to. LinkedIn goes only through hosted authentication, so Whytide never holds a password or a cookie, and each external system sits behind a port.

```mermaid
flowchart LR
  U["Customer users<br/>Owner, Admin, Member"]
  AG["AI agents acting for customers<br/>API keys, or MCP over OAuth 2.1"]
  OP["Operators of the installation<br/>us in Cloud, the self-hoster in Core"]
  P["Prospects"]
  subgraph APP["The platform"]
    WEB["web"]
    API["api"]
    ADM["admin app<br/>private port"]
    WRK["worker"]
  end
  subgraph EXT["External systems, each behind a port"]
    LI["LinkedIn, through a hosted-auth provider<br/>Unipile first"]
    MB["The customers' own mailboxes<br/>Google, Microsoft"]
    DV["Data vendors<br/>finders, verifiers, company data, people search"]
    LLM["LLM providers<br/>the organization's key, or ours in Cloud"]
    CRM["CRM, Slack, webhook receivers"]
    PAY["Payment provider, Cloud only<br/>Razorpay first, Stripe second"]
    SMTP["Any SMTP server<br/>the app's own mail"]
  end
  U -->|"configure, review, approve"| WEB
  WEB -->|"generated client"| API
  AG -->|"the same API"| API
  OP -->|"VPN or localhost, second factor"| ADM
  P -->|"notice page, unsubscribe, privacy requests"| WEB
  API -->|"starts workflows"| WRK
  WRK -->|"reads, invites, messages"| LI
  WRK -->|"send, sync replies"| MB
  LI -->|"messages"| P
  MB -->|"messages"| P
  WRK -->|"search, find, verify"| DV
  WRK -->|"qualify, write, classify"| LLM
  WRK -->|"leads, activities, events"| CRM
  CRM -->|"suppression lists"| WRK
  API -->|"checkout, webhooks"| PAY
  API -->|"invites, sign-in links, alerts"| SMTP
```

### [Processes](docs/architecture.md#3-processes)

The processes and where state lives. Caddy routes to `web` and `api`, the `worker` runs the background work, and Postgres is the only source of truth; Redis can be wiped.

```mermaid
flowchart TB
  subgraph PUBLIC["Reachable through Caddy"]
    CADDY["caddy<br/>TLS, reverse proxy"]
    WEB["web<br/>Next.js: tenant screens, public pages"]
    API["api<br/>NestJS: REST v1, auth, webhooks, MCP"]
  end
  subgraph PRIVATE["Private port, Compose profile admin"]
    ADMIN["admin<br/>Next.js for operators"]
    ADMINAPI["admin-api<br/>NestJS, own identity"]
  end
  WORKER["worker<br/>Temporal worker, Mastra agents, outbox delivery"]
  subgraph STATE["State, all self-hosted"]
    PG[("postgres<br/>pgvector, full-text search, RLS")]
    TEMPORAL["temporal<br/>server, two databases on postgres"]
    RD[("redis<br/>disposable")]
    MINIO[("minio<br/>S3 API, one bucket")]
  end
  OTEL["otel-lgtm<br/>optional profile observability"]
  CADDY --> WEB
  CADDY -->|"/api"| API
  WEB -->|"generated client"| API
  ADMIN --> ADMINAPI
  API -->|"role app"| PG
  WORKER -->|"role app"| PG
  ADMINAPI -->|"role app, billing_writer in Cloud"| PG
  API --> RD
  WORKER --> RD
  API --> MINIO
  WORKER --> MINIO
  API -->|"start, signal, query"| TEMPORAL
  TEMPORAL -->|"tasks"| WORKER
  TEMPORAL --> PG
  WEB -.->|"OTLP"| OTEL
  API -.->|"OTLP"| OTEL
  WORKER -.->|"OTLP"| OTEL
  ADMINAPI -.->|"OTLP"| OTEL
```

### [How modules talk](docs/architecture.md#43-how-modules-talk)

Modules call each other only through their `index.ts` and talk through events, written to an outbox in the same transaction as the change. A lint rule fails CI on any other import.

```mermaid
flowchart LR
  subgraph BASE["Used by every module, through packages/platform"]
    TEN["tenancy"]
    IDN["identity"]
    CRD["credits"]
    ANA["analytics"]
    PRV["privacy"]
  end
  ONB["onboarding<br/>Company Knowledge"] --> ICP["icp"]
  ICP --> QUA["qualification"]
  SIG["signals"] -->|"signal recorded"| QUA
  DIS["discovery<br/>imports, search"] -->|"people imported"| CON["contacts<br/>people, leads, lists, suppression"]
  QUA -->|"lead qualified"| CON
  CON --> CMP["campaigns<br/>sequences, enrolment, steps"]
  ENR["enrichment"] -->|"email found"| CMP
  CMP -->|"draft needed"| MSG["messaging"]
  MSG -->|"draft ready"| APR["approvals"]
  APR -->|"approved"| CMP
  CMP -->|"step due"| LNK["linkedin<br/>senders, safety engine"]
  CMP -->|"step due"| EML["email<br/>mailboxes, caps"]
  LNK -->|"reply, acceptance"| INB["inbox"]
  EML -->|"reply, bounce"| INB
  INB -->|"stop, pause"| CMP
  CON -->|"events"| INT["integrations<br/>HubSpot, Slack, webhooks"]
  CMP -->|"events"| INT
  INB -->|"events"| INT
  MCP["mcp"] -.->|"tools declared by every module"| CON
```

### [A request, end to end](docs/architecture.md#5-a-request-end-to-end)

Every request resolves to a principal (a member, an agent acting for its owner, or a service), and one permission function decides every action. The workspace is set per transaction, so row-level security applies.

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Caddy
  participant W as web
  participant A as api
  participant AU as Auth port (Better Auth adapter)
  participant P as platform (principal, permissions)
  participant M as Module command
  participant CR as credits
  participant DB as Postgres (role app, RLS)
  B->>C: GET /w/acme/leads
  C->>W: route
  W->>A: generated client call, session cookie
  A->>AU: resolve the principal (session, API key or OAuth token)
  AU-->>A: user, actor type, agent record if any, scopes
  A->>P: workspace from the URL, membership, role
  A->>DB: SET LOCAL app.workspace_id and app.user_id, per transaction
  A->>P: can(principal, action, resource)
  Note over P: one policy table, the deny list, the owner ceiling for agents
  P-->>A: allow, or deny with a machine code
  A->>M: input validated by the Zod schema
  M->>CR: reserve credits if the action is priced
  M->>DB: rows and an outbox row in one transaction
  M-->>A: result
  A-->>W: typed response
  W-->>B: screen, every string from a message file
```

```mermaid
flowchart TB
  REQ["request"] --> HOW{"authenticated how?"}
  HOW -->|"session"| HUM["human member"]
  HOW -->|"API key or OAuth 2.1 token"| WHO{"whose credential?"}
  WHO -->|"a member's"| HUM
  WHO -->|"an agent's"| AGT["agent, acting for its owner"]
  HOW -->|"admin session on the admin API"| OPR["operator"]
  HOW -->|"internal"| SVC["service: worker, seeder"]
  HUM --> PERM["permission function<br/>role policy, then the action's rules"]
  AGT --> AGP["owner's rights at this moment<br/>within the agent's scopes<br/>minus the deny list and the two fixed limits (§11)"]
  AGP --> PERM
  OPR --> OPP["operator permissions, on the admin API only"]
  SVC --> PERM
```

### [Tenancy and isolation](docs/architecture.md#6-tenancy-and-isolation)

Data lives in three scopes: global, organization and workspace. Workspace rows are under row-level security that fails closed: without a workspace, a query returns nothing.

```mermaid
flowchart TB
  subgraph G["Global: no person data except keyed hashes"]
    G1["users, auth tables"]
    G2["plans, price_list"]
    G3["companies, company_events,<br/>email_domain_status"]
    G4["dnc_tombstones"]
    G5["country_channel_policy, oauth_clients"]
  end
  subgraph O["Organization: rows carry organization_id"]
    O1["organizations, subscriptions"]
    O2["credit_balances, credit_grants, credit_usage"]
    O3["provider keys, the agent-sending setting, the deny list"]
  end
  subgraph W["Workspace: everything else, RLS fails closed"]
    W1["persons, leads, lists, suppression_entries"]
    W2["campaigns, step_executions, messages"]
    W3["sender_accounts, mailboxes, agents, api_keys"]
    W4["audit_log, events, outbox"]
  end
  G --> O --> W
```

### [Signals, people and leads](docs/architecture.md#73-signals-people-and-leads)

The tables from a signal to a lead: sources and their runs record events about people, and each lead keeps its score snapshots, a verdict per criterion and the reviewer's label.

```mermaid
erDiagram
  workspaces ||--o{ company_knowledge : "has"
  workspaces ||--o{ icps : "has"
  icps ||--o{ icp_versions : "versions"
  icps ||--o{ criteria : "has"
  workspaces ||--o{ signal_sources : "watches"
  signal_sources ||--o{ signal_runs : "runs"
  signal_runs ||--o{ signal_events : "produces"
  signal_events }o--|| persons : "about"
  signal_events ||--o{ evidence : "shows"
  persons ||--o{ contact_points : "has"
  persons ||--o| leads : "becomes"
  persons }o--o| workspace_companies : "works at"
  workspace_companies }o--|| companies : "global index"
  leads ||--o{ score_snapshots : "scored"
  score_snapshots ||--o{ criterion_verdicts : "per criterion"
  leads ||--o{ review_decisions : "labeled"
  lists ||--o{ list_members : "contains"
  list_members }o--|| persons : "is"
  workspaces ||--o{ suppression_entries : "blocks"
  persons ||--o{ enrichment_requests : "enriched"
  workspaces ||--o{ enrichment_cache : "caches"
  workspaces ||--o{ person_hashes : "rejected, salted, 90 days"
```

### [Campaigns, senders and inbox](docs/architecture.md#74-campaigns-senders-and-inbox)

The tables of outreach: a campaign enrolls people, each step has its draft and its approval, each sender account keeps its quota, health and action log, and threads hold the messages.

```mermaid
erDiagram
  campaigns ||--o{ campaign_versions : "edits are versions"
  campaign_versions ||--o{ steps : "ordered"
  campaigns ||--o{ enrollments : "per person"
  enrollments }o--|| persons : "of"
  enrollments ||--o{ step_executions : "one per step"
  step_executions ||--o| message_drafts : "content"
  message_drafts ||--o| approval_items : "waits for"
  step_executions }o--o| sender_accounts : "LinkedIn steps"
  step_executions }o--o| mailboxes : "email steps"
  sender_accounts ||--o{ sender_quota_usage : "per day and type"
  sender_accounts ||--o{ sender_health_events : "history"
  sender_accounts ||--o{ sender_action_log : "every action"
  mailboxes }o--|| sending_domains : "on"
  threads ||--o{ messages : "has"
  threads }o--|| persons : "with"
  messages ||--o| reply_classifications : "inbound"
  step_executions ||--o| messages : "outbound"
```

### [Privacy, integrations and platform](docs/architecture.md#75-privacy-integrations-and-platform)

The tables around them: erasure requests, consent and retention; integrations and webhooks fed from the outbox; idempotency records, jobs and feature flags.

```mermaid
erDiagram
  dsar_requests ||--o{ dsar_tasks : "one per workspace"
  workspaces ||--o{ consent_records : "keeps"
  workspaces ||--o{ retention_policies : "sets"
  workspaces ||--o{ integrations : "connects"
  integrations ||--o{ crm_sync_records : "syncs"
  workspaces ||--o{ webhook_endpoints : "registers"
  outbox ||--o{ webhook_deliveries : "fans out"
  webhook_endpoints ||--o{ webhook_deliveries : "receives"
  outbox ||--o{ events : "analytics copy"
  events ||--o{ rollups : "daily"
  workspaces ||--o{ idempotency_records : "24 h"
  workspaces ||--o{ change_requests : "MCP preview, then confirm"
  workspaces ||--o{ jobs : "async"
  oauth_clients ||--o{ oauth_grants : "MCP clients"
  workspaces ||--o{ feature_flags : "and safety parameters"
```

### [Background work: Temporal and Mastra](docs/architecture.md#8-background-work-temporal-and-mastra)

Temporal owns everything durable; Mastra runs one unit of AI work inside an activity. The second diagram is a qualification batch: credits reserved, the agents called, the score computed in code, the credits committed.

```mermaid
flowchart TB
  SCHED["Temporal schedules<br/>replace cron"] --> WF
  API["api: start, signal, query"] --> WF
  subgraph WORKER["apps/worker"]
    WF["Temporal workflows<br/>orchestration only, IDs only"]
    ACT["activities<br/>rules, ports, agents, database"]
    MW["Mastra workflow<br/>one unit of AI work, seconds to minutes"]
    A1["agent: relevance"]
    A2["agent: assessment"]
    A3["agent: writer"]
    TOOLS["tools: the module's public queries and commands"]
  end
  WF --> ACT
  ACT --> MW
  MW --> A1
  MW --> A2
  MW --> A3
  A1 --> LLMP["LLM port<br/>an AI SDK model with the organization's key"]
  A2 --> LLMP
  A3 --> LLMP
  LLMP --> VEND["Anthropic, OpenAI, Google, local"]
  A3 -.-> TOOLS
  ACT --> PORTS["other ports: LinkedIn, finders, verifiers, CRM"]
  ACT --> DB[("Postgres, role app")]
  MW -.->|"traces, evals"| MPG[("Mastra schema")]
```

```mermaid
sequenceDiagram
  participant S as Temporal schedule
  participant WF as qualification workflow
  participant A as activity: qualify a batch
  participant CR as credits
  participant MW as Mastra workflow
  participant AG as agents: pre-screen, assessment
  participant LLM as LLM port
  participant DB as Postgres
  S->>WF: run (workspace id, ICP version, candidate ids)
  WF->>A: a batch of ids, with retries and timeouts
  A->>DB: load candidates, ICP hard filters first, anonymize
  A->>CR: reserve (key: candidate, ICP version, model)
  A->>MW: run (anonymized candidates, criteria)
  MW->>AG: per candidate
  AG->>LLM: structured output from a Zod schema
  LLM-->>AG: verdicts
  MW-->>A: typed result
  A->>DB: score in code, lead, verdicts, decision record, outbox row
  A->>CR: commit, or release on failure
  A-->>WF: done
  WF->>WF: next batch, or finish
```

### [Ports and adapters](docs/architecture.md#9-ports-and-adapters)

Every external system sits behind a port in Whytide's own words, with one adapter per vendor folder, a fake for tests and one contract test suite for all of them. Replacing a vendor is a new folder and a configuration line.

```mermaid
flowchart LR
  MOD["module code"] --> PORT["packages/providers/linkedin/port.ts<br/>our types, our error codes, our units"]
  PORT --> REG["registry<br/>name to adapter, from server config<br/>or the organization's settings"]
  REG --> A1["unipile/<br/>the vendor SDK is imported only here"]
  REG --> A2["second-provider/"]
  REG --> FAKE["fake/<br/>a few dozen lines"]
  A1 --> V1["Unipile API"]
  CT["one contract test suite,<br/>run against every adapter"] -.-> A1
  CT -.-> A2
  CT -.-> FAKE
  FAKE -.->|"runs the unit tests and<br/>the Compose smoke test"| TESTS["CI"]
  LINT["lint: a vendor SDK import<br/>outside its folder fails CI"] -.-> MOD
  A1 -.->|"vendor ids"| REFS[("provider_refs column<br/>or the adapter's own table")]
```

### [Signal run to qualified lead](docs/architecture.md#141-signal-run-to-qualified-lead)

A scheduled run reserves read quota and credits, reads a post's engagers through the LinkedIn port, and sends new people to qualification. Each source kind is a folder in one registry; post engagers is the first.

```mermaid
sequenceDiagram
  participant SCH as Temporal schedule
  participant WF as signals workflow
  participant SAFE as safety engine (linkedin)
  participant CR as credits
  participant LIP as LinkedIn port (Unipile adapter)
  participant S3 as MinIO
  participant DB as Postgres
  participant QWF as qualification workflow
  participant AG as qualification agents (Mastra)
  SCH->>WF: run a source (workspace id, source id)
  WF->>DB: cadence, candidate budget, cost cap, approved backlog
  WF->>SAFE: reserve read quota (own-account sources)
  SAFE-->>WF: reservation, or none left today
  WF->>CR: reserve credits for the read
  WF->>LIP: fetch engagers since the watermark
  LIP-->>WF: events, with provider errors mapped to typed signals
  WF->>S3: raw payload, short retention
  WF->>DB: upsert signal_events by idempotency key, move the watermark
  WF->>CR: commit
  WF->>DB: normalize, filter noise, resolve person and company
  alt known person in this workspace
    WF->>DB: attach the event, queue a re-score
  else new candidate
    WF->>QWF: start or signal
    QWF->>DB: ICP hard filters first, then anonymize
    QWF->>AG: pre-screen, then full assessment (batch in steady state, sync at cold start)
    AG-->>QWF: structured verdicts per criterion
    QWF->>DB: score in code, lead, verdicts, decision record, outbox row
    QWF->>DB: or drop, keeping a salted hash for 90 days
  end
```

```mermaid
flowchart LR
  subgraph KINDS["source kinds, one folder each in modules/signals/sources/"]
    K1["post_engagers<br/>subject person, pull,<br/>spends the sender's read quota"]
    K2["funding<br/>subject company, pull,<br/>licensed data"]
    K3["hiring_for_role<br/>subject company,<br/>pull or push"]
    K4["job_change<br/>subject person,<br/>licensed data"]
  end
  KINDS --> DECL["each kind declares: fetch (pull on a schedule, or push by webhook),<br/>the budget it spends, the dedupe key, the evidence shape,<br/>its price, its settings, its message keys"]
  DECL --> REG["signals registry, assembled at start"]
  REG --> WF["one signals workflow,<br/>one schedule per source"]
  WF --> PORTS["LinkedIn port, company data port,<br/>people search port"]
  WF --> PE["signal_events<br/>subject person, per workspace"]
  WF --> CE["company_events<br/>global, licensed data only"]
  CE -->|"one row per workspace<br/>whose source matches"| PE
  CE --> WHO["who at this company:<br/>the workspace's contacts first,<br/>then the people-search port"]
  WHO --> PE
  PE --> QUA["qualification"]
```

### [Approval to send, through both gates](docs/architecture.md#142-approval-to-send-through-both-gates)

After approval, every step passes the campaign's just-in-time checks, then the LinkedIn safety engine's quota and health checks, just before it runs. The state diagram is the life of one step.

```mermaid
sequenceDiagram
  actor REV as Reviewer
  participant API as api
  participant DB as Postgres
  participant PLAN as planner (campaigns), daily per sender
  participant SWF as sender workflow, one per sender
  participant GATE as just-in-time gate (campaigns)
  participant SAFE as safety engine (linkedin)
  participant LIP as LinkedIn port (Unipile adapter)
  REV->>API: approve the draft (content frozen)
  API->>DB: approval_items approved, step_executions scheduled
  PLAN->>DB: daily plan: capacity, rank, jittered sessions in business hours
  SWF->>DB: claim the due step (this workflow is the sender's only writer)
  SWF->>GATE: check
  Note over GATE: suppression and DNC, reply or stop state, still enrolled, approval recorded, country rule and consent, CRM list fresh. Read through contacts, inbox, approvals, privacy and integrations
  alt a check fails
    GATE-->>SWF: blocked, with a reason
    SWF->>DB: step skipped, no quota used
  else all pass
    SWF->>SAFE: reserve quota (sender, day, action type)
    Note over SAFE: row lock on the quota row. Health state, kill switches, breaker, daily and weekly caps
    SAFE-->>SWF: reservation
    SWF->>LIP: send with the step's idempotency key
    alt success
      LIP-->>SWF: provider message id
      SWF->>DB: commit quota, step sent, action log, outbox row
    else 429, 500 or a limit error
      LIP-->>SAFE: typed signal: throttle or pause the account
      SWF->>DB: keep or release quota per the error map, reschedule or fail
    end
  end
```

```mermaid
stateDiagram-v2
  [*] --> scheduled : the planner's daily plan
  scheduled --> held : a reply or a stop arrives
  scheduled --> claimed : due, by the sender's workflow
  claimed --> skipped : a gate check fails
  claimed --> reserved : quota reserved
  reserved --> sent : the provider confirms
  reserved --> rescheduled : a retryable error, quota released
  reserved --> failed : a hard error, account paused
  rescheduled --> scheduled
  held --> paused : out of office
  held --> stopped : a human reply or an opt-out
  paused --> scheduled : return date plus one business day
  sent --> [*]
  stopped --> [*]
  skipped --> [*]
  failed --> [*]
```

## Project structure

```
core/
  apps/              the hosts: they mount the modules and hold no feature code
    web/             Next.js: the screens
    api/             NestJS: mounts every module's API
    worker/          Temporal: registers every module's workflows, runs the agents
  modules/           one folder per feature, all the same shape
    tenancy/         users, organizations, workspaces and memberships
    identity/        invite-only sign-in
    onboarding/      Company Knowledge
    icp/             the ideal customer profile
    signals/         signal sources (LinkedIn post engagers) and their runs
    discovery/       lead import from a CSV file
    contacts/        people, companies and leads; the review; the never-contact list
    qualification/   hard filters, AI verdicts, the fit score and the tier
    messaging/       the facts a draft may use, and the AI writer
    linkedin/        connected accounts, quotas, account health, kill switches
    approvals/       the "Up next" approval queue
    campaigns/       the fixed sequence and the record of each step
    inbox/           replies, which stop the sequence
    credits/         the wallet, the plan and the metering
    privacy/         erasure on request
    _template/       the shape `pnpm module:new` copies
  packages/          what every module uses
    platform/        principal and permissions, config, ids, errors, logs, telemetry, i18n
    db/              Prisma: one schema file per module, migrations, database roles
    providers/       the ports and their adapters
    ai/              the Mastra setup, the agent task registry, evals
    ui/              shared components, the theme and shared messages
ee/                  the enterprise list: empty for now, and not under the Core license
deploy/              Compose for development and production, Dockerfile, Caddyfile, backup and restore
docs/                the architecture, the coding, security and delivery rules, the decision records
tools/               the lint rules, the CI runner, the module generator
tests/               the end-to-end test of the skeleton
api-calls/           sample HTTP requests for the API
```

Inside a module: `domain/` holds the rules in plain TypeScript, with `api/`, `workflows/`, `agents/`, `ui/`, `schemas/`, `messages/`, `docs/` and `tests/` around it. `index.ts` is the only entry other modules may import. Four registry files declare the module's permissions, prices, events and settings. Each module's `README.md` says what it owns.

## Run it

**Development.** You need Node 26, pnpm 10 or later (it switches to the version pinned in `package.json` by itself) and Docker with Compose.

```sh
pnpm install --frozen-lockfile
pnpm stack:up      # the development stack, in Docker
pnpm env:create    # this checkout's database, Temporal namespace, bucket and ports, in .env.local
```

The LinkedIn and LLM ports start on their fakes. To use the real ones, set `PROVIDER_LINKEDIN=unipile` and `PROVIDER_LLM=anthropic` in `.env.local`, with their keys on the lines marked `# secret`. Then start each host in its own terminal: `pnpm -F api dev`, `pnpm -F worker dev` and `pnpm -F web dev`. `pnpm invite` invites the first user. `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test` run across every package. [AGENTS.md](AGENTS.md) lists every command.

**Self-hosting.** One Linux server with Docker runs Whytide from the same `compose.yaml`, in the `production` profile, with Caddy and automatic HTTPS. The steps are in [deploy/README.md](deploy/README.md), under "Production".

## Documentation

- [docs/architecture.md](docs/architecture.md): how Whytide is built, the one description. [docs/rules/](docs/README.md): the coding, security and delivery rules every change follows. [docs/adr/](docs/adr/): the decisions.
- Each module's `README.md` and `docs/`: what it owns, its routes, its screens and its decisions.
- [AGENTS.md](AGENTS.md): the brief for contributors and coding agents, with every command. [CONTRIBUTING.md](CONTRIBUTING.md): how a change gets in.
- [SECURITY.md](SECURITY.md): how to report a vulnerability, privately.

## License

Whytide Core is source-available under the Business Source License 1.1. [LICENSE.md](LICENSE.md) is the binding text; in short:

- Individuals and organizations with up to 3 employees and contractors, counting their affiliates, may use it in production for free. Larger organizations need a commercial license.
- Under this license, nobody may offer it, or a derivative of it, to third parties as a hosted or managed service.
- Anyone may use it for evaluation, development and testing.
- Each version becomes Apache 2.0 two years after its release.

`ee/` is not part of Core and not under this license.
