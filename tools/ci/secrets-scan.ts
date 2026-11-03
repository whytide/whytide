// Secret scanning (docs/rules/security.md §4, §7) with gitleaks, run from its image so the scan is the
// same on every laptop and in the GitLab job, pinned by digest like the stack's images, with nothing
// to install. The rules are .gitleaks.toml at the root; findings print with the secret redacted.
//   node tools/ci/secrets-scan.ts          the step secrets:scan: every commit reachable from HEAD
//   node tools/ci/secrets-scan.ts staged   the pre-commit hook: the staged changes (hooks/pre-commit)
//   node tools/ci/secrets-scan.ts hook     the root's prepare script: points core.hooksPath at hooks/
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sh } from "./workspace.ts";

const image =
  "zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const root = resolve(import.meta.dirname, "..", "..");
const mode = process.argv[2] ?? "history";
const say = (text: string) => process.stdout.write(`${text}\n`);

if (mode === "hook") {
  const set = spawnSync("git", ["config", "core.hooksPath", "tools/ci/hooks"], {
    cwd: root,
    encoding: "utf8",
  });
  say(
    set.status === 0
      ? "secrets-scan: the pre-commit hook is installed (core.hooksPath = tools/ci/hooks)"
      : "secrets-scan: not a git checkout, no pre-commit hook to install",
  );
  process.exit(0);
}
if (mode !== "history" && mode !== "staged") {
  process.stderr.write("usage: node tools/ci/secrets-scan.ts [staged | hook]\n");
  process.exit(2);
}

// The checkout and, for a worktree, the repository's own .git, mounted at their own paths so the
// paths git keeps stay valid inside the container, which runs as this user.
const top = sh(root, "git", ["rev-parse", "--show-toplevel"]).trim();
const common = resolve(top, sh(root, "git", ["rev-parse", "--git-common-dir"]).trim());
const mounts = [top, ...(common.startsWith(`${top}/`) ? [] : [common])].flatMap((path) => [
  "-v",
  `${path}:${path}`,
]);
const user =
  process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
const where = mode === "staged" ? "the staged changes" : "the history";
const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    ...user,
    "-e",
    "HOME=/tmp",
    ...mounts,
    "-w",
    top,
    image,
    "git",
    "--no-banner",
    "--redact",
    "--verbose",
    "--exit-code",
    "1",
    "--config",
    ".gitleaks.toml",
    ...(mode === "staged" ? ["--pre-commit", "--staged"] : ["--log-opts=HEAD"]),
    ".",
  ],
  { cwd: top, encoding: "utf8", stdio: "inherit" },
);
if (run.error) {
  say(
    `secrets-scan: docker did not run (${run.error.message}); the scan runs gitleaks from its image, see tools/ci/README.md`,
  );
  process.exit(2);
}
if (run.status === 0) {
  say(`secrets-scan: ok, no secret in ${where}`);
  process.exit(0);
}
if (run.status === 1) {
  say(
    `secrets-scan: a secret is in ${where} (above, redacted): remove it and rotate it (docs/rules/security.md §4)`,
  );
  process.exit(1);
}
say(`secrets-scan: gitleaks exited ${run.status ?? run.signal}`);
process.exit(2);
