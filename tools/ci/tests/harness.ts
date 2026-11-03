// What the tests of this package share: a clone of the committed tree to run against, so uncommitted
// work is not tested, with a fixed git identity and no labels from this environment, and the small
// runners around it.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Run = {
  readonly status: number | null;
  /** Standard output and error together, in that order. */
  readonly out: string;
  readonly stdout: string;
  readonly ms: number;
};

export const env: Record<string, string | undefined> = { ...process.env };
delete env.CI_MERGE_REQUEST_LABELS;
delete env.WHYTIDE_CI_LOCAL;
for (const role of ["AUTHOR", "COMMITTER"]) {
  env[`GIT_${role}_NAME`] = "fixture";
  env[`GIT_${role}_EMAIL`] = "fixture@example.invalid";
}

export const say = (text: string) => process.stdout.write(`${text}\n`);

/** A clone of root's committed tree in a fresh temporary folder, its main at root's HEAD. */
export function cloneOf(root: string): { readonly tmp: string; readonly clone: string } {
  const tmp = mkdtempSync(join(tmpdir(), "whytide-ci-"));
  const clone = join(tmp, "whytide");
  git(tmp, ["clone", "-q", root, clone]);
  git(clone, ["remote", "remove", "origin"]);
  git(clone, ["checkout", "-q", "-B", "main"]);
  return { tmp, clone };
}

export function run(
  cwd: string,
  command: string,
  args: readonly string[],
  extra: Record<string, string> = {},
): Run {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  return {
    status: result.status,
    out: `${stdout}${result.stderr ?? ""}`,
    stdout,
    ms: Date.now() - started,
  };
}

/** Runs git and returns its output; a failure is an error, not a test result. */
export function git(cwd: string, args: readonly string[]): string {
  const result = run(cwd, "git", args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}:\n${result.out}`);
  return result.stdout;
}

export function commit(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

export function ci(cwd: string, args: readonly string[]): Run {
  return run(cwd, "pnpm", ["ci:local", ...args]);
}

/** The step report at the end of a `pnpm ci:local` run: step name to status. */
export function parse(out: string): Map<string, string> {
  const report = new Map<string, string>();
  for (const line of out.split("\n")) {
    const match = /^ {2}(\S+)\s+(ok|cached|skipped|failed|not run)\b/.exec(line);
    if (match) report.set(match[1] ?? "", match[2] ?? "");
  }
  return report;
}

export function tail(out: string): string {
  return out.trimEnd().split("\n").slice(-25).join("\n");
}
