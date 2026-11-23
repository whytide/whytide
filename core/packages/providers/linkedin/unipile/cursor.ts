// Signed cursors (README.md "Cursors"; alpha security L13): a cursor the adapter hands out is its
// state as base64url JSON, a dot, and the HMAC-SHA-256 of the method's name and that payload under
// UNIPILE_CURSOR_SECRET. The port takes a cursor as an opaque string, so signing changes nothing
// there. The state holds the vendor's cursor and the post or the account it belongs to, which the
// method compares with its input, so that a cursor of one cannot page another; one of another method
// fails its signature. A post read's cursor is bound instead: the account and the phrase or the
// author it reads are signed with it, never written in it, so that a cursor carries no phrase and
// one of another read fails its signature. A cursor not signed with this key, forged or unsigned, is
// linkedin_input_invalid; one that would pass the port's 2,048 characters, which long vendor cursors
// can make, is linkedin_provider_error `cursor_too_long` rather than an invalid output.
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@whytide/platform";
import { linkedinPort } from "../port.ts";
import { type Method, providerError } from "./client.ts";

export type Cursors = {
  /** The state as a cursor, signed for the method and, when given, the values it is bound to. */
  readonly sign: (method: Method, state: unknown, bound?: readonly string[]) => string;
  /** The state a cursor carries, or undefined when this key did not sign it so. */
  readonly open: (method: Method, cursor: string, bound?: readonly string[]) => unknown;
};

/** One base64url part of a cursor. */
const PART = /^[\w-]+$/;
/** The port's bound on a cursor, from its own schema. */
const portCursor = linkedinPort.methods.listPendingInvites.output.shape.nextCursor;

export function signedCursors(secret: string): Cursors {
  // A bound cursor's text is a JSON array, which no method's name starts like: unbound cursors keep
  // theirs, so that a cursor handed out before stays valid.
  const mac = (method: Method, payload: string, bound?: readonly string[]) =>
    createHmac("sha256", secret)
      .update(bound ? JSON.stringify([method, ...bound, payload]) : `${method}.${payload}`)
      .digest();
  return {
    sign: (method, state, bound) => {
      const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
      const cursor = `${payload}.${mac(method, payload, bound).toString("base64url")}`;
      if (!portCursor.safeParse(cursor).success) {
        throw providerError(method, { reason: "cursor_too_long" });
      }
      return cursor;
    },
    open: (method, cursor, bound) => {
      const [payload = "", signature = "", ...rest] = cursor.split(".");
      if (rest.length > 0 || !PART.test(payload) || !PART.test(signature)) return undefined;
      const given = Buffer.from(signature, "base64url");
      const expected = mac(method, payload, bound);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
      try {
        return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * A cursor the adapter did not give for this post, account, phrase or author: forged, unsigned or
 * another's.
 */
export const cursorInvalid = (method: Method, of: "post" | "account" | "phrase" | "author") =>
  new AppError(linkedinPort.codes.input, {
    details: { method, reason: `a cursor the adapter did not give for this ${of}` },
  });
