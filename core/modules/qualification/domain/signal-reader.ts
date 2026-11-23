// The signal reader's registry (README "Intent and priority"; docs/rules/coding.md §3): qualification
// imports nothing of signals, which registers its reader here as it loads (gamma-p5-030), as privacy's
// defineEraser is filled. One reader per process: a second registration fails at start. With none,
// no intent is computed, and every lead keeps its fit tier. The items are ids, codes, numbers and
// dates; the excerpts are the person's own words, for the assessment (gamma-p5-050).
import { AppError } from "@whytide/platform";
import { errors } from "../errors.ts";
import type { IntentClass, IntentKind, IntentRole } from "./intent/constants.ts";

/** One of the person's signals, collapsed per source by the reader (RB-4.4.2). No words. */
export type IntentInput = {
  readonly personId: string;
  readonly eventId: string;
  readonly sourceId: string;
  readonly kind: IntentKind;
  readonly role: IntentRole;
  /** 0 to 1; null while unrated. */
  readonly relevance: number | null;
  /** Null while unrated. */
  readonly intentClass: IntentClass | null;
  readonly occurredAt: Date;
  /** The member who created the source; null when none is known. */
  readonly ownerUserId: string | null;
  /** The events the item collapses: shown, never weighed. */
  readonly count: number;
};
export type SignalReader = {
  /** Per person, the items of the events since `since`. */
  intentInputs(input: {
    readonly personIds: readonly string[];
    readonly since: Date;
  }): Promise<readonly IntentInput[]>;
  /** Up to `max` of the person's own words not yet reduced, newest first. */
  excerpts(input: { readonly personId: string; readonly max: number }): Promise<readonly string[]>;
};

let current: SignalReader | undefined;

/** Registers the process's reader as its module loads; a second is signal_reader_duplicate (500). */
export function defineSignalReader(reader: SignalReader): void {
  if (current !== undefined) throw new AppError(errors.signal_reader_duplicate);
  current = reader;
}

/** The registered reader, or undefined: then nothing of the intent runs. */
export const signalReader = (): SignalReader | undefined => current;

/**
 * For tests (testing/): `next` in place of any reader, undefined for none; the function returned
 * puts back the one before.
 */
export function useSignalReader(next: SignalReader | undefined): () => void {
  const previous = current;
  current = next;
  return () => {
    if (current === next) current = previous;
  };
}
