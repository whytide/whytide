# Fixture secrets

Fake secrets in the shapes `.gitleaks.toml` knows, for `tools/ci/tests/supply-chain.test.ts`: the test plants one elsewhere in a clone and proves the pre-commit hook and `secrets:scan` reject it. This folder is the one path the scan allowlists. None of these values is real.
