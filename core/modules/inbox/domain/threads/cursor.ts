// The list's cursor (README.md "API"): a thread's place in the newest-first order, its
// last_message_at and its id, as base64url JSON. The next page starts after it.
import { z } from "zod";
import { ID_MAX } from "../store/constants.ts";

export type ThreadCursor = { readonly lastMessageAt: Date; readonly id: string };

const shape = z.tuple([z.iso.datetime(), z.string().min(1).max(ID_MAX)]);

/** The cursor after the thread. */
export function encodeCursor(thread: ThreadCursor): string {
  const json = JSON.stringify([thread.lastMessageAt.toISOString(), thread.id]);
  return Buffer.from(json).toString("base64url");
}

/** The place the cursor names; null when it is not one this list wrote. */
export function decodeCursor(cursor: string): ThreadCursor | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = shape.safeParse(value);
  if (!parsed.success) return null;
  const [at, id] = parsed.data;
  return { lastMessageAt: new Date(at), id };
}
