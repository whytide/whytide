// The eval step's change detection (README.md "Evals"): the pipeline's step `eval` runs the evals
// only when a file they cover changed since the branch left main, committed or not, as tools/ci's
// branch checks see changes (tools/ci/branch.ts). Main is `origin/main` where the remote exists, else
// `main`; without either, or when git fails, the evals run.
import { spawnSync } from "node:child_process";

/** What the evals cover: the modules' agents (task and prompt files), and the cases and scorers here. */
export const COVERED = /^core\/(?:modules\/[^/]+\/agents|packages\/ai\/evals)\//;

/** Whether a covered file changed in the repository at `root` since its branch left main. */
export function evalsChanged(root: string): boolean {
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args[0]} exited ${run.status}`);
    return run.stdout;
  };
  try {
    const exists = (ref: string) =>
      spawnSync("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: root }).status ===
      0;
    const base = ["origin/main", "main"].find(exists);
    if (!base) return true;
    const fork = git("merge-base", "HEAD", base).trim();
    const changed = git("diff", "--name-only", "-z", fork);
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
    return `${changed}\0${untracked}`.split("\0").some((file) => COVERED.test(file));
  } catch {
    return true;
  }
}
