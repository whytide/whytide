# Whytide

Whytide finds high-intent B2B leads from buying signals, qualifies them with AI against the customer's ideal customer profile, shows the evidence behind every lead, and drafts outreach that a human approves. This repository holds the code of Whytide Core, the source-available, self-hosted edition, and of Whytide Cloud, the hosted service that runs the same code.

## Get started

Node 26 (`.node-version`) and pnpm 10 or later; pnpm switches to the version pinned in `package.json` by itself.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Where things are

- [docs/architecture.md](docs/architecture.md): how it is built, the one description. [docs/rules/](docs/README.md): the coding, security and delivery rules every change follows. [docs/adr/](docs/adr/): the decisions.
- [core/](core/README.md): the hosts, the modules and the shared packages. [ee/](ee/README.md): the enterprise list. [deploy/](deploy/README.md): Compose and the environment.
- [AGENTS.md](AGENTS.md): the brief for contributors and coding agents, with every command. [CONTRIBUTING.md](CONTRIBUTING.md): how a change gets in.
- [SECURITY.md](SECURITY.md): how to report a vulnerability, privately.

## License

Whytide Core is source-available under the Business Source License 1.1. [LICENSE.md](LICENSE.md) is the binding text; in short:

- Individuals and organizations with up to 3 employees and contractors, counting their affiliates, may use it in production for free. Larger organizations need a commercial license.
- Under this license, nobody may offer it, or a derivative of it, to third parties as a hosted or managed service.
- Anyone may use it for evaluation, development and testing.
- Each version becomes Apache 2.0 two years after its release.

`ee/` is not part of Core and not under this license.
