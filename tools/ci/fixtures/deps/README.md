# Fixture dependencies

Local packages `tools/ci/tests/supply-chain.test.ts` adds to a clone with `pnpm add -w -D file:…`: `postinstall` carries a build script, which the install must refuse; `gpl` carries a license the allow-list rejects; `one` and `two` are two plain new dependencies, more than one merge request may add. None is a workspace package: `pnpm-workspace.yaml` lists `tools/*` one level deep only.
