// What the branch checks look at: the merge request's labels, and every file changed since the
// branch left main, committed or not, plus the untracked files. Main is `origin/main` where the
// remote exists (a worktree, the GitLab job after its fetch) and `main` otherwise.
import { spawnSync } from "node:child_process";
import { sh } from "./workspace.ts";

/** The merge request's labels: CI_MERGE_REQUEST_LABELS, which `pnpm ci:local --labels` sets. */
export function labels(): string[] {
  return (process.env.CI_MERGE_REQUEST_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

export function changedFiles(root: string): { readonly base: string; readonly files: string[] } {
  const base = ["origin/main", "main"].find(
    (ref) =>
      spawnSync("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
        cwd: root,
        encoding: "utf8",
      }).status === 0,
  );
  if (!base) throw new Error("no main to compare with: neither origin/main nor main exists");
  const mergeBase = sh(root, "git", ["merge-base", "HEAD", base]).trim();
  const changed = sh(root, "git", ["diff", "--name-only", "-z", mergeBase]).split("\0");
  const untracked = sh(root, "git", ["ls-files", "--others", "--exclude-standard", "-z"]).split(
    "\0",
  );
  return { base, files: [...new Set([...changed, ...untracked].filter(Boolean))].sort() };
}
