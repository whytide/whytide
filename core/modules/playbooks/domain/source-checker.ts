// The source checker's registry (README "The source checker"; docs/rules/coding.md §3): playbooks
// cannot read signals' table and never imports signals, which registers its checker here as it loads
// (gamma-p5-045), as qualification's defineSignalReader is filled. One checker per process: a second
// registration fails at start. With none, every link is refused (setSources), never accepted
// unchecked. The answers are ids only.
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";

/** What the checker answers for one id: the source, the sender account it reads through, its owner. */
export type SourceCheck = {
  readonly sourceId: string;
  /** A source of the run's workspace has the id. */
  readonly found: boolean;
  /** The sender account the source reads through; null when there is none. */
  readonly readingAccountId: string | null;
  /** That account's owner, a member's user id; null when there is none. */
  readonly readingOwnerUserId: string | null;
};

/** Runs in the caller's tenant run and answers each id; an id it leaves out is not found. */
export type SourceChecker = (sourceIds: readonly string[]) => Promise<readonly SourceCheck[]>;

let current: SourceChecker | undefined;

/** Registers the process's checker as its module loads; a second is playbook_source_checker_duplicate. */
export function defineSourceChecker(check: SourceChecker): void {
  if (current !== undefined) throw new AppError(errors.playbook_source_checker_duplicate);
  current = check;
}

/** The registered checker, or undefined: then every link is refused. */
export const sourceChecker = (): SourceChecker | undefined => current;

/**
 * For tests (testing/): `next` in place of any checker, undefined for none; the function returned
 * puts back the one before.
 */
export function useSourceChecker(next: SourceChecker | undefined): () => void {
  const previous = current;
  current = next;
  return () => {
    if (current === next) current = previous;
  };
}
